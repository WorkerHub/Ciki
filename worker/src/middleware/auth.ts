/**
 * 会话校验中间件。
 *
 * Cookie 令牌 → SHA-256 → `sessions` 行（连 users 校验激活/审批）。会话行被删、
 * 过期、用户被停用/未批准都立即 401/403 失效。受限会话（needs_2fa_setup=1）
 * 只放行完成 2FA 配置所需的白名单路径。
 */
import type { Context, Next } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import { findSession, readSessionToken } from "../core/session"
import type { HonoEnv } from "../types"

const RESTRICTED_EXACT = new Set(["/api/me", "/api/auth/logout"])
const RESTRICTED_PREFIX = [
  "/api/auth/2fa/totp/",
  "/api/auth/2fa/passkey/",
  // 受限会话也能启用（或关闭）邮箱验证码作为第二因子。
  "/api/auth/2fa/email-otp/"
]

function unauthorized(c: Context<HonoEnv>) {
  c.header("Cache-Control", "no-store")
  return c.json({ error: "Unauthorized" }, 401)
}

export async function authMiddleware(c: Context<HonoEnv>, next: Next) {
  const token = readSessionToken(c)
  if (!token) return unauthorized(c)

  const prefix = getTablePrefix(c.env)
  const session = await findSession(c.env.DB, prefix, token)
  if (!session) return unauthorized(c)

  c.set("userId", session.userId)
  c.set("role", session.role)
  c.set("sessionId", session.sessionId)
  c.set("restricted", session.restricted)

  if (session.restricted) {
    const path = new URL(c.req.url).pathname
    const allowed =
      RESTRICTED_EXACT.has(path) ||
      RESTRICTED_PREFIX.some((p) => path.startsWith(p))
    if (!allowed) {
      return c.json({ error: "2FA setup required", needs2faSetup: true }, 403)
    }
  }

  await next()
}
