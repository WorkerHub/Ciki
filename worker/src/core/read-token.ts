/**
 * 个人只读接口令牌（一期：供 Muse 的自定义连接器接入）。
 *
 * 与导入令牌（core/import-token.ts）并列、**互不通用**：存储在各自的表里，校验各查
 * 各的表，所以「导入令牌调读接口」「只读令牌调导入/写接口」在服务端天然被拒——双向
 * 隔离靠表隔离落地，不靠前置判断，也不靠前端。规格明确要求导入令牌这一侧原样不动，
 * 因此这里照抄它的口径而不去抽取共用组件。
 *
 * - 每用户一枚（`user_id` 主键），生成/重置即覆盖；库里只存令牌的 SHA-256 hex，与
 *   `sessions` / `import_tokens` 同口径，库被读也拿不到可用凭证。
 * - 明文只在生成/重置的响应里出现一次，此后只能查状态。
 * - 不设过期列：失效只走 吊销 / 重置 / 用户被停用或未批准；校验每次回表。
 * - `last_used_at` 每次通过令牌调用读接口时更新（供设置页显示最近使用时间）。
 */
import { randomToken, sha256Hex } from "./auth"
import { readTokensTable, usersTable } from "../lib/tables"

export interface ReadTokenRow {
  user_id: string
  token_hash: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

/** 对外状态（永不包含 token_hash 或明文），形状与 `ImportTokenStatus` 一致。 */
export interface ReadTokenStatus {
  active: boolean
  createdAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
}

export function toReadTokenStatus(row: ReadTokenRow | null): ReadTokenStatus {
  return {
    active: Boolean(row && !row.revoked_at),
    createdAt: row?.created_at ?? null,
    lastUsedAt: row?.last_used_at ?? null,
    revokedAt: row?.revoked_at ?? null
  }
}

export async function getReadTokenRow(
  db: D1Database,
  prefix: string,
  userId: string
): Promise<ReadTokenRow | null> {
  return db
    .prepare(`SELECT * FROM ${readTokensTable(prefix)} WHERE user_id = ?`)
    .bind(userId)
    .first<ReadTokenRow>()
}

/** 生成或覆盖（重置）当前用户的只读令牌，返回明文（只此一次）。 */
export async function issueReadToken(
  db: D1Database,
  prefix: string,
  userId: string
): Promise<{ token: string; createdAt: string }> {
  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO ${readTokensTable(prefix)} (user_id, token_hash, created_at, last_used_at, revoked_at)
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
export async function revokeReadToken(
  db: D1Database,
  prefix: string,
  userId: string
): Promise<boolean> {
  const now = new Date().toISOString()
  const result = await db
    .prepare(
      `UPDATE ${readTokensTable(prefix)} SET revoked_at = ?
        WHERE user_id = ? AND revoked_at IS NULL`
    )
    .bind(now, userId)
    .run()
  if (result.meta.changes > 0) return true
  return (await getReadTokenRow(db, prefix, userId)) !== null
}

export interface ReadIdentity {
  userId: string
  /** 站点角色；`admin` 在读接口里等于「可见全部空间」。 */
  role: string
}

/** 校验令牌：哈希回表 + 连 users 校验激活/审批；已吊销或用户不可用一律 null。 */
export async function findReadToken(
  db: D1Database,
  prefix: string,
  token: string
): Promise<ReadIdentity | null> {
  if (!token) return null
  const tokenHash = await sha256Hex(token)
  const row = await db
    .prepare(
      `SELECT t.user_id AS userId, u.role AS role,
              u.is_active AS isActive, u.approval_status AS approvalStatus
         FROM ${readTokensTable(prefix)} t
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

/** 每次成功调用读接口后更新 last_used_at。 */
export async function touchReadToken(
  db: D1Database,
  prefix: string,
  userId: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE ${readTokensTable(prefix)} SET last_used_at = ? WHERE user_id = ?`
    )
    .bind(new Date().toISOString(), userId)
    .run()
}
