/**
 * 鉴权：注册 / 登录 / 登出 / 刷新 / 公开站点配置。
 *
 * - 注册默认开启、默认需管理员批准；首个注册者直接成为管理员并批准。
 * - 登录限流与失败锁定以 D1 计数表为唯一权威（规格补遗）。
 * - 会话是单枚不透明 Cookie（core/session.ts），库里只存 SHA-256。
 */
import { Hono } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import { getBooleanSetting } from "../db/queries/settings"
import {
  createUserFirstIsAdmin,
  findUserByEmail,
  findUserById,
  type UserRow
} from "../db/queries/users"
import { countPasskeys } from "../db/queries/passkeys"
import { getTotp } from "../db/queries/totp"
import { hashPassword, randomToken, verifyPassword } from "../core/auth"
import {
  clearSessionCookie,
  deleteSessionByToken,
  findSession,
  readSessionToken,
  rotateSession,
  setSessionCookie
} from "../core/session"
import { challengeKeyForToken, putChallenge } from "../core/challenges"
import {
  clearAccountCounters,
  consumeCounter,
  lockedUntil,
  setLock
} from "../core/counters"
import { clientIp, issueSession, readJsonBody } from "../lib/http"
import { generateId } from "../core/auth"
import type { HonoEnv } from "../types"

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

/** 用户不存在时也跑一遍同等成本的校验，避免用响应时间探测邮箱是否存在。 */
const DUMMY_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000"

const LOGIN_WINDOW = 300
const LOGIN_LIMIT = 10
const FAIL_WINDOW = 900
const FAIL_LIMIT = 5

export function publicUser(user: UserRow) {
  return { id: user.id, email: user.email, role: user.role }
}

export const authRoutes = new Hono<HonoEnv>()

/** 公开站点配置：登录页据 registrationEnabled 决定是否展示注册入口。 */
authRoutes.get("/config", async (c) => {
  const prefix = getTablePrefix(c.env)
  try {
    return c.json({
      registrationEnabled: await getBooleanSetting(
        c.env.DB,
        prefix,
        "registration_enabled",
        true
      ),
      registrationApprovalRequired: await getBooleanSetting(
        c.env.DB,
        prefix,
        "registration_approval_required",
        true
      )
    })
  } catch {
    return c.json({
      registrationEnabled: true,
      registrationApprovalRequired: true
    })
  }
})

authRoutes.post("/register", async (c) => {
  const body = await readJsonBody<{ email?: string; password?: string }>(c)
  const email = body?.email?.trim().toLowerCase()
  const password = body?.password

  if (!email || !password) {
    return c.json({ error: "Email and password required" }, 400)
  }
  if (!EMAIL_RE.test(email)) {
    return c.json({ error: "Invalid email format" }, 400)
  }
  if (password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400)
  }

  const prefix = getTablePrefix(c.env)
  const ip = clientIp(c)
  const limit = await consumeCounter(c.env.DB, prefix, {
    action: "register",
    ip,
    windowSeconds: 300
  })
  if (limit.count > 5) {
    return c.json({ error: "Too many requests", code: "RATE_LIMITED" }, 429)
  }

  const registrationEnabled = await getBooleanSetting(
    c.env.DB,
    prefix,
    "registration_enabled",
    true
  )
  if (!registrationEnabled) {
    return c.json(
      { error: "Registration is disabled", code: "REGISTRATION_DISABLED" },
      403
    )
  }

  if (await findUserByEmail(c.env.DB, prefix, email)) {
    return c.json(
      { error: "Email already registered", code: "EMAIL_TAKEN" },
      409
    )
  }

  const approvalRequired = await getBooleanSetting(
    c.env.DB,
    prefix,
    "registration_approval_required",
    true
  )
  const id = generateId()
  try {
    await createUserFirstIsAdmin(c.env.DB, prefix, {
      id,
      email,
      password_hash: await hashPassword(password),
      approvalStatus: approvalRequired ? "pending" : "approved"
    })
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      return c.json(
        { error: "Email already registered", code: "EMAIL_TAKEN" },
        409
      )
    }
    throw err
  }

  const user = await findUserById(c.env.DB, prefix, id)
  return c.json(
    {
      success: true,
      approvalRequired: user?.approval_status === "pending"
    },
    201
  )
})

authRoutes.post("/login", async (c) => {
  const body = await readJsonBody<{ email?: string; password?: string }>(c)
  const email = body?.email?.trim().toLowerCase()
  const password = body?.password
  if (!email || !password) {
    return c.json({ error: "Email and password required" }, 400)
  }

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const ip = clientIp(c)

  const limit = await consumeCounter(db, prefix, {
    action: "login",
    ip,
    windowSeconds: LOGIN_WINDOW
  })
  if (limit.count > LOGIN_LIMIT) {
    const retryAfter = Math.max(
      1,
      limit.windowStart + LOGIN_WINDOW - Math.floor(Date.now() / 1000)
    )
    return c.json(
      { error: "Too many requests", code: "RATE_LIMITED", retryAfter },
      429
    )
  }

  const locked = await lockedUntil(db, prefix, {
    action: "login_fail",
    account: email,
    ip
  })
  if (locked) {
    return c.json(
      {
        error: "Account locked",
        code: "ACCOUNT_LOCKED",
        retryAfter: Math.max(1, locked - Math.floor(Date.now() / 1000))
      },
      429
    )
  }

  const user = await findUserByEmail(db, prefix, email)
  let valid = false
  if (user) {
    valid = await verifyPassword(password, user.password_hash)
  } else {
    // 与真实校验同成本，避免用响应时间探测邮箱是否存在。
    await verifyPassword(password, DUMMY_HASH)
  }

  if (!user || !valid) {
    const failures = await consumeCounter(db, prefix, {
      action: "login_fail",
      account: email,
      ip,
      windowSeconds: FAIL_WINDOW
    })
    if (failures.count >= FAIL_LIMIT) {
      await setLock(
        db,
        prefix,
        { action: "login_fail", account: email, ip },
        Math.floor(Date.now() / 1000) + FAIL_WINDOW
      )
    }
    return c.json({ error: "Invalid credentials" }, 401)
  }

  if (user.approval_status === "pending") {
    return c.json(
      {
        error: "Account pending approval",
        code: "ACCOUNT_PENDING_APPROVAL"
      },
      403
    )
  }
  if (user.approval_status === "rejected") {
    return c.json(
      { error: "Account was rejected", code: "ACCOUNT_REJECTED" },
      403
    )
  }
  if (!user.is_active) {
    return c.json({ error: "Invalid credentials" }, 401)
  }

  await clearAccountCounters(db, prefix, "login_fail", email)

  const totp = await getTotp(db, prefix, user.id)
  const passkeys = await countPasskeys(db, prefix, user.id)
  const methods: string[] = []
  if (totp?.totp_enabled) methods.push("totp")
  if (passkeys > 0) methods.push("passkey")

  if (methods.length > 0) {
    const tempToken = randomToken()
    const key = await challengeKeyForToken(tempToken)
    await putChallenge(db, prefix, {
      key,
      userId: user.id,
      purpose: "2fa_login",
      payload: "",
      ttlSeconds: 300
    })
    return c.json({
      requires2fa: true,
      tempToken,
      availableMethods: methods
    })
  }

  const require2fa = await getBooleanSetting(db, prefix, "require_2fa", false)
  const needs2faSetup = require2fa && methods.length === 0
  await issueSession(c, user.id, needs2faSetup)

  return c.json({
    success: true,
    user: publicUser(user),
    ...(needs2faSetup ? { needs2faSetup: true } : {})
  })
})

authRoutes.post("/logout", async (c) => {
  const token = readSessionToken(c)
  if (token) {
    const prefix = getTablePrefix(c.env)
    await deleteSessionByToken(c.env.DB, prefix, token)
  }
  clearSessionCookie(c)
  return c.json({ success: true })
})

authRoutes.post("/refresh", async (c) => {
  const token = readSessionToken(c)
  if (!token) {
    return c.json({ error: "No session" }, 401)
  }
  const prefix = getTablePrefix(c.env)
  const session = await findSession(c.env.DB, prefix, token)
  if (!session) {
    clearSessionCookie(c)
    return c.json({ error: "Session revoked" }, 401)
  }
  const next = await rotateSession(c.env.DB, prefix, session.sessionId)
  if (!next) {
    clearSessionCookie(c)
    return c.json({ error: "Session revoked" }, 401)
  }
  setSessionCookie(c, next)
  return c.json({ success: true })
})
