/**
 * 2FA：登录第二步（TOTP / passkey / 邮箱验证码）与配置管理。
 *
 * - 登录挑战（tempToken）存 auth_challenges，5 分钟过期；验证码错 5 次作废。
 * - TOTP 密钥只在加密后落库（core/secret-box.ts），且用 totp_used 挑战行防重放。
 * - passkey 凭证独立成表；注册/认证挑战消费即删。
 * - 邮箱验证码走 core/email-code.ts 的统一 plumbing：库内只存哈希，用途
 *   `2fa_login`（binding = SHA-256(tempToken)）/ `2fa_enable`，收码邮箱即账号邮箱。
 * - 受限会话在 TOTP 启用、passkey 注册成功或邮箱验证码启用后自动解除。
 */
import { Hono } from "hono"
import type { Context } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import { findUserById, type UserRow } from "../db/queries/users"
import { getTotp, setEmailOtpEnabled, upsertTotp } from "../db/queries/totp"
import { deleteUserEmailCodes } from "../db/queries/email-codes"
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
import {
  bindingForTempToken,
  consumeEmailCodeSendLimits,
  consumeEmailCodeVerifyLimits,
  EMAIL_CODE_COOLDOWN_SECONDS,
  EMAIL_CODE_TTL_SECONDS,
  issueEmailCode,
  resetEmailCodeVerifyCounter,
  verifyEmailCode,
  type EmailCodePurpose
} from "../core/email-code"
import { isEmailConfigured, sendEmailCodeMessage } from "../services/email"
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

/**
 * 敏感 2FA 操作的重认证：密码校验 + D1 计数表限流。
 * 被盗会话 Cookie 不能靠无限次试密码绕过登录的限流（(reauth, 用户, IP) 5 次/5 分钟，
 * 成功即清零）。
 */
async function requirePassword(
  c: Context<HonoEnv>,
  password: unknown
): Promise<Response | null> {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const ip = clientIp(c)
  const attempts = await consumeCounter(c.env.DB, prefix, {
    action: "reauth",
    account: userId,
    ip,
    windowSeconds: 300
  })
  if (attempts.count > 5) {
    return c.json({ error: "Too many requests", code: "RATE_LIMITED" }, 429)
  }

  if (typeof password !== "string" || !password) {
    return c.json({ error: "Password required" }, 400)
  }
  const user = await findUserById(c.env.DB, prefix, userId)
  if (!user) return c.json({ error: "User not found" }, 404)
  if (!(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: "Password is incorrect" }, 403)
  }
  await clearAccountCounters(c.env.DB, prefix, "reauth", userId)
  return null
}

/** 账号是否已有任何二步因子（TOTP / 邮箱验证码已启用，或存在 passkey 行）。 */
async function hasAnyFactor(c: Context<HonoEnv>): Promise<boolean> {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const totp = await getTotp(c.env.DB, prefix, userId)
  // 邮箱验证码也是因子：已开启时新增/启用其它方式同样要密码重认证。
  if (totp?.totp_enabled || totp?.email_otp_enabled) return true
  return (await countPasskeys(c.env.DB, prefix, userId)) > 0
}

/**
 * 新增/启用因子时的重认证：**已有任何因子才要求密码**（首次设置、刚密码登录过的
 * 账号免密码），复用 disable/delete 的同一套 reauth 限流与错误码（400/403/429）。
 */
async function requireFactorReauth(
  c: Context<HonoEnv>,
  password: unknown
): Promise<Response | null> {
  if (!(await hasAnyFactor(c))) return null
  return requirePassword(c, password)
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

// ── 邮箱验证码 2FA 的共用小工具 ──────────────────────────────────────────────

/** 发码成功回执（send-verify / send-login 同形；前端按这两个字段做冷却与有效期）。 */
const EMAIL_OTP_SENT = {
  success: true as const,
  cooldownSeconds: EMAIL_CODE_COOLDOWN_SECONDS,
  expiresInSeconds: EMAIL_CODE_TTL_SECONDS
}

/** email_code_* 限频命中的统一 429（`retryAfter` 是还要等多少秒）。 */
function emailCodeRateLimited(c: Context<HonoEnv>, retryAfter: number) {
  return c.json(
    { error: "Too many requests", code: "RATE_LIMITED", retryAfter },
    429
  )
}

/**
 * 站点级发信开关：未配置就直接 503，且不写任何计数（与找回密码同口径）。
 * 返回非 null 表示应当直接把它当响应返回。
 */
async function requireEmailConfigured(
  c: Context<HonoEnv>
): Promise<Response | null> {
  if (await isEmailConfigured(c.env)) return null
  return c.json(
    { error: "Email delivery is not configured", code: "EMAIL_NOT_CONFIGURED" },
    503
  )
}

/**
 * 发一枚验证码并同步投递。发信失败回 502（原因已脱敏、不含密码）；库里那枚
 * 码不额外清理——它 10 分钟后自然过期，下次重发会覆盖。
 */
async function sendEmailCode(
  c: Context<HonoEnv>,
  options: {
    userId: string
    email: string
    purpose: EmailCodePurpose
    binding?: string
  }
): Promise<Response | null> {
  const prefix = getTablePrefix(c.env)
  const issued = await issueEmailCode(c.env.DB, prefix, {
    userId: options.userId,
    purpose: options.purpose,
    binding: options.binding
  })
  const sent = await sendEmailCodeMessage(c.env, {
    to: options.email,
    code: issued.code,
    purpose: options.purpose
  })
  if (sent.success) return null
  return c.json({ error: sent.error, code: "SMTP_SEND_FAILED" }, 502)
}

/** 登录第二步：TOTP。 */
auth2faRoutes.post("/verify", async (c) => {
  const body = await readJsonBody<{
    tempToken?: unknown
    method?: unknown
    code?: unknown
  }>(c)
  const tempToken = typeof body?.tempToken === "string" ? body.tempToken : ""
  const method = typeof body?.method === "string" ? body.method : ""
  const code = typeof body?.code === "string" ? body.code : ""
  if (!tempToken || !method || !code) {
    return c.json({ error: "tempToken, method, and code required" }, 400)
  }
  if (method !== "totp" && method !== "email_otp") {
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
  const attemptAccount = loginKey
  let verified = false

  if (method === "email_otp") {
    if (!config?.email_otp_enabled) {
      return c.json(
        {
          error: "Email code is not enabled for this account",
          code: "METHOD_NOT_ENABLED"
        },
        400
      )
    }
    // 纵深防御：两步之间站点把发信关掉时，邮箱验证码不再作为有效因子。
    const unavailable = await requireEmailConfigured(c)
    if (unavailable) return unavailable
    verified = await verifyEmailCode(db, prefix, {
      userId: login.userId,
      purpose: "2fa_login",
      binding: await bindingForTempToken(tempToken),
      code
    })
  } else {
    if (!config?.totp_enabled || !config.totp_secret) {
      return c.json({ error: "TOTP not configured" }, 400)
    }

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

/**
 * 登录第二步选了邮箱验证码：向账号邮箱发 6 位验证码（公开，只认有效的 2fa_login 挑战）。
 *
 * 收码邮箱就是账号邮箱（v1 不支持另设）；码绑定 `SHA-256(tempToken)`，同一登录挑战
 * 重发就覆盖旧码。限频复用 email_code_cd / send / send_ip（账号为 userId）。
 */
auth2faRoutes.post("/email-otp/send-login", async (c) => {
  const body = await readJsonBody<{ tempToken?: unknown }>(c)
  const tempToken = typeof body?.tempToken === "string" ? body.tempToken : ""
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

  const user = await findUserById(db, prefix, login.userId)
  if (!user) {
    return c.json({ error: "Invalid or expired 2FA session" }, 401)
  }
  if (!user.is_active || user.approval_status !== "approved") {
    return c.json({ error: "Account is disabled" }, 403)
  }

  const row = await getTotp(db, prefix, login.userId)
  if (!row?.email_otp_enabled) {
    return c.json(
      {
        error: "Email code is not enabled for this account",
        code: "METHOD_NOT_ENABLED"
      },
      400
    )
  }

  const unavailable = await requireEmailConfigured(c)
  if (unavailable) return unavailable

  const limits = await consumeEmailCodeSendLimits(db, prefix, {
    purpose: "2fa_login",
    accountKey: login.userId,
    ip: clientIp(c)
  })
  if (!limits.allowed) return emailCodeRateLimited(c, limits.retryAfter)

  const failed = await sendEmailCode(c, {
    userId: login.userId,
    email: user.email,
    purpose: "2fa_login",
    binding: await bindingForTempToken(tempToken)
  })
  if (failed) return failed

  return c.json(EMAIL_OTP_SENT)
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
    Record<string, unknown> & { tempToken?: unknown }
  >(c)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400)
  }
  const tempToken = typeof body.tempToken === "string" ? body.tempToken : ""
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
  const body = await readJsonBody<{ password?: unknown }>(c)
  const reauth = await requireFactorReauth(
    c,
    typeof body?.password === "string" ? body.password : undefined
  )
  if (reauth) return reauth

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
  const body = await readJsonBody<{ code?: unknown; password?: unknown }>(c)
  const reauth = await requireFactorReauth(
    c,
    typeof body?.password === "string" ? body.password : undefined
  )
  if (reauth) return reauth
  const code = typeof body?.code === "string" ? body.code.trim() : ""
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
  const body = await readJsonBody<{ password?: unknown }>(c)
  const reauth = await requireFactorReauth(
    c,
    typeof body?.password === "string" ? body.password : undefined
  )
  if (reauth) return reauth

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
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400)
  }
  const reauth = await requireFactorReauth(
    c,
    typeof body.password === "string" ? body.password : undefined
  )
  if (reauth) return reauth

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

/**
 * 邮箱验证码：设置页发码（`2fa_enable`）。
 *
 * 顺序固定「站点发信 → 密码重认证 → 发码限频 → 发信」：未配 SMTP 时不写任何
 * 计数（503），重认证与 TOTP/Passkey 的「新增因子」同一套规则与错误码。
 */
auth2faRoutes.post("/email-otp/send-verify", async (c) => {
  const unavailable = await requireEmailConfigured(c)
  if (unavailable) return unavailable

  const body = await readJsonBody<{ password?: unknown }>(c)
  const reauth = await requireFactorReauth(
    c,
    typeof body?.password === "string" ? body.password : undefined
  )
  if (reauth) return reauth

  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const user = await findUserById(c.env.DB, prefix, userId)
  if (!user) return c.json({ error: "User not found" }, 404)

  const limits = await consumeEmailCodeSendLimits(c.env.DB, prefix, {
    purpose: "2fa_enable",
    accountKey: userId,
    ip: clientIp(c)
  })
  if (!limits.allowed) return emailCodeRateLimited(c, limits.retryAfter)

  const failed = await sendEmailCode(c, {
    userId,
    email: user.email,
    purpose: "2fa_enable"
  })
  if (failed) return failed
  return c.json(EMAIL_OTP_SENT)
})

/**
 * 邮箱验证码：验码开启（验码往返过关才真正启用，即时生效）。
 *
 * 只改 `email_otp_enabled` 一列，TOTP 字段原样保留；成功同时把当前受限会话
 * 的 `needs_2fa_setup` 清掉，与 TOTP 启用 / passkey 注册一致。
 */
auth2faRoutes.post("/email-otp/enable", async (c) => {
  const unavailable = await requireEmailConfigured(c)
  if (unavailable) return unavailable

  const body = await readJsonBody<{ code?: unknown; password?: unknown }>(c)
  const reauth = await requireFactorReauth(
    c,
    typeof body?.password === "string" ? body.password : undefined
  )
  if (reauth) return reauth

  const code = typeof body?.code === "string" ? body.code.trim() : ""
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const userId = c.get("userId")

  const invalidCode = () =>
    c.json({ error: "Invalid code", code: "INVALID_CODE" }, 400)
  if (!code) return invalidCode()

  const limits = await consumeEmailCodeVerifyLimits(db, prefix, {
    purpose: "2fa_enable",
    accountKey: userId,
    ip: clientIp(c)
  })
  if (!limits.allowed) return emailCodeRateLimited(c, limits.retryAfter)

  // 错码/无码/过期统一 400；错码的次数与「第 5 次作废」由 plumbing 负责。
  const verified = await verifyEmailCode(db, prefix, {
    userId,
    purpose: "2fa_enable",
    code
  })
  if (!verified) return invalidCode()

  await resetEmailCodeVerifyCounter(db, prefix, {
    purpose: "2fa_enable",
    accountKey: userId
  })
  await setEmailOtpEnabled(db, prefix, userId, true)
  await clearSessionRestriction(db, prefix, c.get("sessionId"))
  return c.json({ success: true })
})

/**
 * 邮箱验证码：即时停用。
 *
 * **始终要求密码**（与关闭 TOTP 一致），且**不看 SMTP 是否可用**——发信坏掉时
 * 用户仍必须能把因子关掉，否则会被锁死。顺手清掉未使用的 `2fa_enable` 验证码，
 * 免得重新启用时旧码还能用。
 */
auth2faRoutes.post("/email-otp/disable", async (c) => {
  const body = await readJsonBody<{ password?: string }>(c)
  const passwordError = await requirePassword(c, body?.password)
  if (passwordError) return passwordError

  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  await setEmailOtpEnabled(c.env.DB, prefix, userId, false)
  await deleteUserEmailCodes(c.env.DB, prefix, userId, "2fa_enable")
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
  emailOtpEnabled: boolean
}> {
  const totp = await getTotp(db, prefix, userId)
  const passkeyCount = await countPasskeys(db, prefix, userId)
  return {
    totpEnabled: Boolean(totp?.totp_enabled),
    passkeyEnabled: passkeyCount > 0,
    passkeyCount,
    // 前端设置页靠这个字段显示「已开启」并判断重认证（字段名由前端锁定）。
    emailOtpEnabled: Boolean(totp?.email_otp_enabled)
  }
}
