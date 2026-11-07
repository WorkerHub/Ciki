/**
 * 会话：不透明令牌 + SHA-256 哈希落库（规格补遗定版）。
 *
 * - Cookie 里是 32 字节随机令牌；`sessions` 表只存它的 SHA-256，库被读也拿不到
 *   可用凭证。
 * - 登出 / 改密 / 管理员停用或拒绝都靠删行吊销；每次请求都回表校验，删行立即生效。
 * - `refresh` 只把同一行的 token_hash 换掉并延长过期（7 天滑动），不新建行。
 */
import type { Context } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import type { HonoEnv } from "../types"
import { sessionsTable, usersTable } from "../lib/tables"
import { randomToken, sha256Hex } from "./auth"

export const SESSION_COOKIE = "ciki_session"
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7

export interface SessionLookup {
  sessionId: string
  userId: string
  role: string
  restricted: boolean
  email: string
  approvalStatus: string
  createdAt: string
}

/** 新建会话行并返回明文令牌（只回给 Cookie，永不落库）。 */
export async function createSession(
  db: D1Database,
  prefix: string,
  options: {
    userId: string
    ip?: string
    userAgent?: string
    needs2faSetup?: boolean
  }
): Promise<{ token: string; sessionId: string }> {
  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  const sessionId = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  await db
    .prepare(
      `INSERT INTO ${sessionsTable(prefix)}
        (id, token_hash, user_id, needs_2fa_setup, created_at, last_seen_at, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionId,
      tokenHash,
      options.userId,
      options.needs2faSetup ? 1 : 0,
      now,
      now,
      now + SESSION_TTL_SECONDS,
      options.ip ?? "",
      (options.userAgent ?? "").slice(0, 512)
    )
    .run()
  return { token, sessionId }
}

/** 用 Cookie 令牌查会话（连 users 校验激活/审批），无效返回 null。 */
export async function findSession(
  db: D1Database,
  prefix: string,
  token: string
): Promise<SessionLookup | null> {
  if (!token) return null
  const tokenHash = await sha256Hex(token)
  const row = await db
    .prepare(
      `SELECT s.id AS sessionId, s.user_id AS userId, s.needs_2fa_setup AS restricted,
              u.role AS role, u.email AS email, u.approval_status AS approvalStatus,
              u.is_active AS isActive, u.created_at AS createdAt
         FROM ${sessionsTable(prefix)} s
         JOIN ${usersTable(prefix)} u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`
    )
    .bind(tokenHash, Math.floor(Date.now() / 1000))
    .first<{
      sessionId: string
      userId: string
      restricted: number
      role: string
      email: string
      approvalStatus: string
      isActive: number
      createdAt: string
    }>()
  if (!row) return null
  if (!row.isActive || row.approvalStatus !== "approved") return null
  return {
    sessionId: row.sessionId,
    userId: row.userId,
    role: row.role,
    restricted: row.restricted === 1,
    email: row.email,
    approvalStatus: row.approvalStatus,
    createdAt: row.createdAt
  }
}

/** 轮换令牌：同一行换 token_hash、延长过期、刷新 last_seen_at。 */
export async function rotateSession(
  db: D1Database,
  prefix: string,
  sessionId: string
): Promise<string | null> {
  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  const now = Math.floor(Date.now() / 1000)
  const result = await db
    .prepare(
      `UPDATE ${sessionsTable(prefix)}
          SET token_hash = ?, last_seen_at = ?, expires_at = ?
        WHERE id = ?`
    )
    .bind(tokenHash, now, now + SESSION_TTL_SECONDS, sessionId)
    .run()
  if (result.meta.changes === 0) return null
  return token
}

export async function deleteSessionById(
  db: D1Database,
  prefix: string,
  sessionId: string,
  userId?: string
): Promise<boolean> {
  const sql = userId
    ? `DELETE FROM ${sessionsTable(prefix)} WHERE id = ? AND user_id = ?`
    : `DELETE FROM ${sessionsTable(prefix)} WHERE id = ?`
  const stmt = db.prepare(sql)
  const result = userId
    ? await stmt.bind(sessionId, userId).run()
    : await stmt.bind(sessionId).run()
  return result.meta.changes > 0
}

export async function deleteSessionByToken(
  db: D1Database,
  prefix: string,
  token: string
): Promise<void> {
  const tokenHash = await sha256Hex(token)
  await db
    .prepare(`DELETE FROM ${sessionsTable(prefix)} WHERE token_hash = ?`)
    .bind(tokenHash)
    .run()
}

/** 删除某用户的全部会话；`exceptSessionId` 用于改密时保留当前会话。 */
export async function deleteUserSessions(
  db: D1Database,
  prefix: string,
  userId: string,
  exceptSessionId?: string
): Promise<void> {
  if (exceptSessionId) {
    await db
      .prepare(
        `DELETE FROM ${sessionsTable(prefix)} WHERE user_id = ? AND id != ?`
      )
      .bind(userId, exceptSessionId)
      .run()
    return
  }
  await db
    .prepare(`DELETE FROM ${sessionsTable(prefix)} WHERE user_id = ?`)
    .bind(userId)
    .run()
}

/** 2FA 配置完成后解除当前会话的受限标记。 */
export async function clearSessionRestriction(
  db: D1Database,
  prefix: string,
  sessionId: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE ${sessionsTable(prefix)} SET needs_2fa_setup = 0 WHERE id = ?`
    )
    .bind(sessionId)
    .run()
}

export async function listUserSessions(
  db: D1Database,
  prefix: string,
  userId: string
): Promise<
  Array<{
    id: string
    createdAt: number
    lastSeenAt: number
    expiresAt: number
    ip: string
    userAgent: string
  }>
> {
  const rows = await db
    .prepare(
      `SELECT id, created_at AS createdAt, last_seen_at AS lastSeenAt,
              expires_at AS expiresAt, ip, user_agent AS userAgent
         FROM ${sessionsTable(prefix)}
        WHERE user_id = ? AND expires_at > ?
        ORDER BY last_seen_at DESC`
    )
    .bind(userId, Math.floor(Date.now() / 1000))
    .all<{
      id: string
      createdAt: number
      lastSeenAt: number
      expiresAt: number
      ip: string
      userAgent: string
    }>()
  return rows.results
}

// ── Cookie helpers ──────────────────────────────────────────────────────────

export function readSessionToken(c: Context<HonoEnv>): string | null {
  return getCookie(c, SESSION_COOKIE) ?? null
}

export function setSessionCookie(c: Context<HonoEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_TTL_SECONDS
  })
}

export function clearSessionCookie(c: Context<HonoEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" })
}
