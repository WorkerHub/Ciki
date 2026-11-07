/**
 * 2FA：登录第二步（TOTP / passkey）与配置管理。
 *
 * - 登录挑战（tempToken）存 auth_challenges，5 分钟过期；验证码错 5 次作废。
 * - TOTP 密钥只在加密后落库（core/secret-box.ts），且用 totp_used 挑战行防重放。
 * - passkey 凭证独立成表；注册/认证挑战消费即删。
 * - 受限会话在 TOTP 启用或 passkey 注册成功后自动解除。
 */
import { Hono } from "hono"
import type { Context } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import { findUserById, type UserRow } from "../db/queries/users"
import { getTotp, upsertTotp } from "../db/queries/totp"
import {
  countPasskeys,
  deletePasskey,
  deleteUserPasskeys,
  findPasskeyByCredentialId,
  insertPasskey,
  listPasskeys,
  updatePasskeyCounter
} from "../db/queries/passkeys"
import { verifyPassword } from "../core/auth"
import {
  challengeKeyForToken,
  challengeKeyForUser,
  consumeChallenge,
  deleteChallenge,
  markChallengeUsed,
  putChallenge,
  readChallenge
} from "../core/challenges"
import { clearAccountCounters, consumeCounter } from "../core/counters"
import { decryptSecret, encryptSecret } from "../core/secret-box"
import { generateTotpSecret, verifyTotpCode } from "../core/totp"
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  checkAuthentication,
  checkRegistration
} from "../core/webauthn"
import { clearSessionRestriction } from "../core/session"
import { clientIp, issueSession, readJsonBody } from "../lib/http"
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON
} from "@simplewebauthn/server"
import type { HonoEnv } from "../types"

export const auth2faRoutes = new Hono<HonoEnv>()

function publicUser(user: UserRow) {
  return { id: user.id, email: user.email, role: user.role }
}

function hostOf(c: Context<HonoEnv>): string {
  return new URL(c.req.url).hostname
}

function originOf(c: Context<HonoEnv>): string {
  return new URL(c.req.url).origin
}

async function requirePassword(
  c: Context<HonoEnv>,
  password: unknown
): Promise<Response | null> {
  if (typeof password !== "string" || !password) {
    return c.json({ error: "Password required" }, 400)
  }
  const prefix = getTablePrefix(c.env)
  const user = await findUserById(c.env.DB, prefix, c.get("userId"))
  if (!user) return c.json({ error: "User not found" }, 404)
  if (!(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: "Password is incorrect" }, 403)
  }
  return null
}

async function loadActiveUser(
  c: Context<HonoEnv>,
  userId: string
): Promise<UserRow | null> {
  const prefix = getTablePrefix(c.env)
  const user = await findUserById(c.env.DB, prefix, userId)
  if (!user?.is_active || user.approval_status !== "approved") {
    return null
  }
  return user
}

/** 登录第二步：TOTP。 */
auth2faRoutes.post("/verify", async (c) => {
  const body = await readJsonBody<{
    tempToken?: string
    method?: string
    code?: string
  }>(c)
  const tempToken = body?.tempToken
  const method = body?.method
  const code = body?.code
  if (!tempToken || !method || !code) {
    return c.json({ error: "tempToken, method, and code required" }, 400)
  }
  if (method !== "totp") {
    return c.json(
      { error: "Use the passkey authenticate endpoint for passkey" },
      400
    )
  }

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const ip = clientIp(c)
  const limit = await consumeCounter(db, prefix, {
    action: "2fa_verify",
    ip,
    windowSeconds: 300
  })
  if (limit.count > 5) {
    return c.json({ error: "Too many requests", code: "RATE_LIMITED" }, 429)
  }

  const loginKey = await challengeKeyForToken(tempToken)
  const login = await readChallenge(db, prefix, loginKey)
  if (login?.purpose !== "2fa_login") {
    return c.json({ error: "Invalid or expired 2FA session" }, 401)
  }

  const config = await getTotp(db, prefix, login.userId)
  if (!config?.totp_enabled || !config.totp_secret) {
    return c.json({ error: "TOTP not configured" }, 400)
  }

  const attemptAccount = loginKey
  let verified = false
  try {
    const secret = await decryptSecret(
      c.env.ENCRYPTION_KEY,
      config.totp_secret,
      `ciki:totp:${login.userId}`
    )
    verified = verifyTotpCode(secret, code)
  } catch (err) {
    console.error(
      "TOTP secret undecryptable:",
      err instanceof Error ? err.message : err
    )
    return c.json({ error: "Internal server error" }, 500)
  }

  if (verified) {
    const fresh = await markChallengeUsed(db, prefix, {
      key: await challengeKeyForUser("totp_used", `${login.userId}:${code}`),
      userId: login.userId,
      purpose: "totp_used",
      payload: ""
    })
    if (!fresh) verified = false
  }

  if (!verified) {
    const failures = await consumeCounter(db, prefix, {
      action: "2fa_attempt",
      account: attemptAccount,
      ip,
      windowSeconds: 300
    })
    if (failures.count >= 5) {
      await deleteChallenge(db, prefix, loginKey)
    }
    return c.json({ error: "Invalid verification code" }, 401)
  }

  await clearAccountCounters(db, prefix, "2fa_attempt", attemptAccount)
  await deleteChallenge(db, prefix, loginKey)

  const user = await loadActiveUser(c, login.userId)
  if (!user) return c.json({ error: "Account is disabled" }, 403)

  await issueSession(c, user.id)
  return c.json({ success: true, user: publicUser(user) })
})

/** passkey 登录：options（用 tempToken 找回用户）。 */
auth2faRoutes.post("/passkey/authenticate/options", async (c) => {
  const body = await readJsonBody<{ tempToken?: string }>(c)
  const tempToken = body?.tempToken
  if (!tempToken) return c.json({ error: "tempToken required" }, 400)

  const prefix = getTablePrefix(c.env)
  const login = await readChallenge(
    c.env.DB,
    prefix,
    await challengeKeyForToken(tempToken)
  )
  if (login?.purpose !== "2fa_login") {
    return c.json({ error: "Invalid or expired 2FA session" }, 401)
  }

  const credentials = await listPasskeys(c.env.DB, prefix, login.userId)
  if (credentials.length === 0) {
    return c.json({ error: "No passkeys registered" }, 400)
  }

  const options = await buildAuthenticationOptions({
    rpID: hostOf(c),
    credentials: credentials.map((credential) => ({
      credentialId: credential.credential_id,
      publicKey: credential.public_key,
      counter: credential.counter
    }))
  })

  await putChallenge(c.env.DB, prefix, {
    key: await challengeKeyForUser("passkey_auth", tempToken),
    userId: login.userId,
    purpose: "passkey_auth",
    payload: options.challenge,
    ttlSeconds: 300
  })

  return c.json(options)
})

/** passkey 登录：verify。 */
auth2faRoutes.post("/passkey/authenticate/verify", async (c) => {
  const body = await readJsonBody<
    Record<string, unknown> & { tempToken?: string }
  >(c)
  const tempToken = body?.tempToken
  if (!tempToken) return c.json({ error: "tempToken required" }, 400)

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const login = await readChallenge(
    db,
    prefix,
    await challengeKeyForToken(tempToken)
  )
  if (login?.purpose !== "2fa_login") {
    return c.json({ error: "Invalid or expired 2FA session" }, 401)
  }

  const challenge = await consumeChallenge(
    db,
    prefix,
    await challengeKeyForUser("passkey_auth", tempToken)
  )
  if (!challenge) return c.json({ error: "No pending challenge" }, 400)

  const credentialId = typeof body.id === "string" ? body.id : ""
  const credential = await findPasskeyByCredentialId(db, prefix, credentialId)
  if (!credential || credential.user_id !== login.userId) {
    return c.json({ error: "Unknown credential" }, 400)
  }

  try {
    const verification = await checkAuthentication({
      response: body as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge.payload,
      expectedOrigin: originOf(c),
      expectedRPID: hostOf(c),
      credential: {
        credentialId: credential.credential_id,
        publicKey: credential.public_key,
        counter: credential.counter
      }
    })
    if (!verification.verified) {
      return c.json({ error: "Verification failed" }, 401)
    }
    await updatePasskeyCounter(
      db,
      prefix,
      credential.id,
      verification.authenticationInfo.newCounter
    )
  } catch (err) {
    console.error(
      "Passkey authentication failed:",
      err instanceof Error ? err.message : err
    )
    return c.json({ error: "Verification failed" }, 401)
  }

  await deleteChallenge(db, prefix, await challengeKeyForToken(tempToken))
  const user = await loadActiveUser(c, login.userId)
  if (!user) return c.json({ error: "Account is disabled" }, 403)

  await issueSession(c, user.id)
  return c.json({ success: true, user: publicUser(user) })
})

// ── 以下均需会话（由 index.ts 的全局会话守卫覆盖） ─────────────────────────

/** 生成 TOTP 密钥：明文只回这一次，待确认密钥加密后存挑战行。 */
auth2faRoutes.post("/totp/setup", async (c) => {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const user = await findUserById(c.env.DB, prefix, userId)
  if (!user) return c.json({ error: "User not found" }, 404)

  const { secret, uri } = generateTotpSecret(user.email)
  const encrypted = await encryptSecret(
    c.env.ENCRYPTION_KEY,
    secret,
    `ciki:totp:${userId}`
  )
  await putChallenge(c.env.DB, prefix, {
    key: await challengeKeyForUser("totp_setup", userId),
    userId,
    purpose: "totp_setup",
    payload: encrypted,
    ttlSeconds: 300
  })
  return c.json({ secret, uri })
})

/** 校验并启用 TOTP；成功后把当前受限会话标记清零。 */
auth2faRoutes.post("/totp/enable", async (c) => {
  const body = await readJsonBody<{ code?: string }>(c)
  const code = body?.code?.trim()
  if (!code) return c.json({ error: "Code required" }, 400)

  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const key = await challengeKeyForUser("totp_setup", userId)
  const challenge = await readChallenge(c.env.DB, prefix, key)
  if (!challenge) return c.json({ error: "No pending TOTP setup" }, 400)

  let secret: string
  try {
    secret = await decryptSecret(
      c.env.ENCRYPTION_KEY,
      challenge.payload,
      `ciki:totp:${userId}`
    )
  } catch {
    return c.json({ error: "No pending TOTP setup" }, 400)
  }

  if (!verifyTotpCode(secret, code)) {
    return c.json({ error: "Invalid code" }, 400)
  }
  const fresh = await markChallengeUsed(c.env.DB, prefix, {
    key: await challengeKeyForUser("totp_used", `${userId}:${code}`),
    userId,
    purpose: "totp_used",
    payload: ""
  })
  if (!fresh) return c.json({ error: "Invalid code" }, 400)

  await deleteChallenge(c.env.DB, prefix, key)
  const encrypted = await encryptSecret(
    c.env.ENCRYPTION_KEY,
    secret,
    `ciki:totp:${userId}`
  )
  await upsertTotp(c.env.DB, prefix, userId, {
    totp_secret: encrypted,
    totp_enabled: 1
  })
  await clearSessionRestriction(c.env.DB, prefix, c.get("sessionId"))
  return c.json({ success: true })
})

auth2faRoutes.post("/totp/disable", async (c) => {
  const body = await readJsonBody<{ password?: string }>(c)
  const passwordError = await requirePassword(c, body?.password)
  if (passwordError) return passwordError

  const prefix = getTablePrefix(c.env)
  await upsertTotp(c.env.DB, prefix, c.get("userId"), {
    totp_secret: null,
    totp_enabled: 0
  })
  return c.json({ success: true })
})

auth2faRoutes.post("/passkey/register/options", async (c) => {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const user = await findUserById(c.env.DB, prefix, userId)
  if (!user) return c.json({ error: "User not found" }, 404)

  const existing = await listPasskeys(c.env.DB, prefix, userId)
  const options = await buildRegistrationOptions({
    rpID: hostOf(c),
    rpName: "ciki",
    user: { id: user.id, email: user.email },
    existing: existing.map((credential) => ({
      credentialId: credential.credential_id,
      publicKey: credential.public_key,
      counter: credential.counter
    }))
  })

  await putChallenge(c.env.DB, prefix, {
    key: await challengeKeyForUser("passkey_register", userId),
    userId,
    purpose: "passkey_register",
    payload: options.challenge,
    ttlSeconds: 300
  })
  return c.json(options)
})

auth2faRoutes.post("/passkey/register/verify", async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c)
  if (!body) return c.json({ error: "Invalid request body" }, 400)

  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const key = await challengeKeyForUser("passkey_register", userId)
  const challenge = await readChallenge(c.env.DB, prefix, key)
  if (!challenge) return c.json({ error: "No pending challenge" }, 400)

  try {
    const verification = await checkRegistration({
      response: body as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge.payload,
      expectedOrigin: originOf(c),
      expectedRPID: hostOf(c)
    })
    if (!verification.verified || !verification.registrationInfo) {
      return c.json({ error: "Verification failed" }, 400)
    }
    const { credential } = verification.registrationInfo
    const response = body.response as { transports?: unknown } | undefined
    const transports = Array.isArray(response?.transports)
      ? (response.transports as string[])
      : []
    await insertPasskey(c.env.DB, prefix, {
      id: crypto.randomUUID(),
      userId,
      credentialId: credential.id,
      publicKey: btoa(
        String.fromCharCode(...new Uint8Array(credential.publicKey))
      ),
      counter: credential.counter,
      transports: JSON.stringify(transports)
    })
  } catch (err) {
    console.error(
      "Passkey registration failed:",
      err instanceof Error ? err.message : err
    )
    return c.json({ error: "Verification failed" }, 400)
  }

  await deleteChallenge(c.env.DB, prefix, key)
  await clearSessionRestriction(c.env.DB, prefix, c.get("sessionId"))
  return c.json({ success: true })
})

auth2faRoutes.delete("/passkey/:credentialId", async (c) => {
  const body = await readJsonBody<{ password?: string }>(c)
  const passwordError = await requirePassword(c, body?.password)
  if (passwordError) return passwordError

  const prefix = getTablePrefix(c.env)
  const removed = await deletePasskey(
    c.env.DB,
    prefix,
    c.get("userId"),
    c.req.param("credentialId")
  )
  if (!removed) return c.json({ error: "Passkey not found" }, 404)
  return c.json({ success: true })
})

auth2faRoutes.post("/passkey/disable", async (c) => {
  const body = await readJsonBody<{ password?: string }>(c)
  const passwordError = await requirePassword(c, body?.password)
  if (passwordError) return passwordError

  const prefix = getTablePrefix(c.env)
  await deleteUserPasskeys(c.env.DB, prefix, c.get("userId"))
  return c.json({ success: true })
})

/** /api/me 的 twofa 汇总（避免 me 路由重复查询逻辑）。 */
export async function twofaSummary(
  db: D1Database,
  prefix: string,
  userId: string
): Promise<{
  totpEnabled: boolean
  passkeyEnabled: boolean
  passkeyCount: number
}> {
  const totp = await getTotp(db, prefix, userId)
  const passkeyCount = await countPasskeys(db, prefix, userId)
  return {
    totpEnabled: Boolean(totp?.totp_enabled),
    passkeyEnabled: passkeyCount > 0,
    passkeyCount
  }
}
