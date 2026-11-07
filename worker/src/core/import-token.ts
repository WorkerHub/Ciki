/**
 * 个人导入令牌（规格 §12.1）。
 *
 * - 每用户一枚（user_id 主键），生成/重置即覆盖；库里只存令牌的 SHA-256 hex，
 *   与 `sessions` 的不透明令牌同口径（core/session.ts），库被读也拿不到可用凭证。
 * - 明文只在生成/重置的响应里出现一次，此后只能查状态。
 * - 不设过期列：失效只走 吊销 / 重置 / 用户被停用或未批准；校验每次回表。
 * - last_used_at 每次通过令牌调用导入接口时更新（供设置页显示最近使用时间）。
 */
import { sha256Hex, randomToken } from "./auth"
import { importTokensTable, usersTable } from "../lib/tables"

export interface ImportTokenRow {
  user_id: string
  token_hash: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

/** 对外状态（永不包含 token_hash 或明文）。 */
export interface ImportTokenStatus {
  active: boolean
  createdAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
}

export function toImportTokenStatus(
  row: ImportTokenRow | null
): ImportTokenStatus {
  return {
    active: Boolean(row && !row.revoked_at),
    createdAt: row?.created_at ?? null,
    lastUsedAt: row?.last_used_at ?? null,
    revokedAt: row?.revoked_at ?? null
  }
}

export async function getImportTokenRow(
  db: D1Database,
  prefix: string,
  userId: string
): Promise<ImportTokenRow | null> {
  return db
    .prepare(`SELECT * FROM ${importTokensTable(prefix)} WHERE user_id = ?`)
    .bind(userId)
    .first<ImportTokenRow>()
}

/** 生成或覆盖（重置）当前用户的令牌，返回明文（只此一次）。 */
export async function issueImportToken(
  db: D1Database,
  prefix: string,
  userId: string
): Promise<{ token: string; createdAt: string }> {
  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO ${importTokensTable(prefix)} (user_id, token_hash, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, NULL, NULL)
       ON CONFLICT(user_id) DO UPDATE SET
         token_hash = excluded.token_hash,
         created_at = excluded.created_at,
         last_used_at = NULL,
         revoked_at = NULL`
    )
    .bind(userId, tokenHash, now)
    .run()
  return { token, createdAt: now }
}

/** 吊销：从未生成过返回 false（路由转 404），已吊销视为成功（幂等）。 */
export async function revokeImportToken(
  db: D1Database,
  prefix: string,
  userId: string
): Promise<boolean> {
  const now = new Date().toISOString()
  const result = await db
    .prepare(
      `UPDATE ${importTokensTable(prefix)} SET revoked_at = ?
        WHERE user_id = ? AND revoked_at IS NULL`
    )
    .bind(now, userId)
    .run()
  if (result.meta.changes > 0) return true
  return (await getImportTokenRow(db, prefix, userId)) !== null
}

export interface ImportIdentity {
  userId: string
  role: string
}

/** 校验令牌：哈希回表 + 连 users 校验激活/审批；已吊销或用户不可用一律 null。 */
export async function findImportToken(
  db: D1Database,
  prefix: string,
  token: string
): Promise<ImportIdentity | null> {
  if (!token) return null
  const tokenHash = await sha256Hex(token)
  const row = await db
    .prepare(
      `SELECT t.user_id AS userId, u.role AS role,
              u.is_active AS isActive, u.approval_status AS approvalStatus
         FROM ${importTokensTable(prefix)} t
         JOIN ${usersTable(prefix)} u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL`
    )
    .bind(tokenHash)
    .first<{
      userId: string
      role: string
      isActive: number
      approvalStatus: string
    }>()
  if (!row) return null
  if (!row.isActive || row.approvalStatus !== "approved") return null
  return { userId: row.userId, role: row.role }
}

/** 每次成功调用导入接口后更新 last_used_at。 */
export async function touchImportToken(
  db: D1Database,
  prefix: string,
  userId: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE ${importTokensTable(prefix)} SET last_used_at = ? WHERE user_id = ?`
    )
    .bind(new Date().toISOString(), userId)
    .run()
}
