/**
 * 我的：资料、改密、会话列表/吊销、个人导入令牌（规格 §12.1）。
 */
import { Hono } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import { findUserById, updateUser } from "../db/queries/users"
import { twofaSummary } from "./auth-2fa"
import {
  deleteSessionById,
  deleteUserSessions,
  listUserSessions
} from "../core/session"
import { hashPassword, verifyPassword } from "../core/auth"
import { consumeCounter } from "../core/counters"
import {
  getImportTokenRow,
  issueImportToken,
  revokeImportToken,
  toImportTokenStatus
} from "../core/import-token"
import { clientIp, readJsonBody } from "../lib/http"
import type { HonoEnv } from "../types"

export const meRoutes = new Hono<HonoEnv>()

meRoutes.get("/", async (c) => {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const user = await findUserById(c.env.DB, prefix, userId)
  if (!user) return c.json({ error: "User not found" }, 404)

  return c.json({
    id: user.id,
    email: user.email,
    role: user.role,
    approvalStatus: user.approval_status,
    createdAt: user.created_at,
    twofa: await twofaSummary(c.env.DB, prefix, userId)
  })
})

meRoutes.put("/password", async (c) => {
  const body = await readJsonBody<{
    currentPassword?: unknown
    newPassword?: unknown
  }>(c)
  const currentPassword =
    typeof body?.currentPassword === "string" ? body.currentPassword : ""
  const newPassword =
    typeof body?.newPassword === "string" ? body.newPassword : ""
  if (!currentPassword || !newPassword) {
    return c.json({ error: "Current and new password required" }, 400)
  }
  if (newPassword.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400)
  }

  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const limit = await consumeCounter(c.env.DB, prefix, {
    action: "password_change",
    account: userId,
    ip: clientIp(c),
    windowSeconds: 300
  })
  if (limit.count > 5) {
    return c.json({ error: "Too many requests", code: "RATE_LIMITED" }, 429)
  }

  const user = await findUserById(c.env.DB, prefix, userId)
  if (!user) return c.json({ error: "User not found" }, 404)
  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    return c.json({ error: "Current password is incorrect" }, 403)
  }

  await updateUser(c.env.DB, prefix, userId, {
    password_hash: await hashPassword(newPassword)
  })
  await deleteUserSessions(c.env.DB, prefix, userId, c.get("sessionId"))
  return c.json({ success: true })
})

meRoutes.get("/sessions", async (c) => {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const currentId = c.get("sessionId")
  const sessions = await listUserSessions(c.env.DB, prefix, userId)
  return c.json(
    sessions.map((session) => ({
      id: session.id,
      createdAt: new Date(session.createdAt * 1000).toISOString(),
      lastSeenAt: new Date(session.lastSeenAt * 1000).toISOString(),
      ip: session.ip,
      userAgent: session.userAgent,
      current: session.id === currentId
    }))
  )
})

meRoutes.delete("/sessions/:id", async (c) => {
  const sessionId = c.req.param("id")
  if (sessionId === c.get("sessionId")) {
    return c.json({ error: "Use logout to end current session" }, 400)
  }
  const prefix = getTablePrefix(c.env)
  const removed = await deleteSessionById(
    c.env.DB,
    prefix,
    sessionId,
    c.get("userId")
  )
  if (!removed) return c.json({ error: "Session not found" }, 404)
  return c.json({ success: true })
})

// ── 个人导入令牌（会话 Cookie 鉴权；令牌本身只用于 /api/import/*） ──────────

/** 是否有可用令牌 + 时间线；永不返回哈希或明文。 */
meRoutes.get("/import-token", async (c) => {
  const prefix = getTablePrefix(c.env)
  const row = await getImportTokenRow(c.env.DB, prefix, c.get("userId"))
  return c.json(toImportTokenStatus(row))
})

/** 生成或重置：明文只在这一个响应里出现一次，库里只留 SHA-256。 */
meRoutes.post("/import-token", async (c) => {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const limit = await consumeCounter(c.env.DB, prefix, {
    action: "import_token",
    account: userId,
    windowSeconds: 300
  })
  if (limit.count > 10) {
    return c.json({ error: "Too many requests", code: "RATE_LIMITED" }, 429)
  }
  const { token, createdAt } = await issueImportToken(c.env.DB, prefix, userId)
  return c.json({ token, createdAt })
})

/** 吊销：从未生成过 404；已吊销再删仍成功（幂等）。 */
meRoutes.delete("/import-token", async (c) => {
  const prefix = getTablePrefix(c.env)
  const revoked = await revokeImportToken(c.env.DB, prefix, c.get("userId"))
  if (!revoked) return c.json({ error: "Import token not found" }, 404)
  return c.json({ success: true })
})
