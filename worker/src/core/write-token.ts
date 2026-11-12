/**
 * 读写接口令牌（二期），逐函数与 core/read-token.ts 同构、只换一张表。
 *
 * 与只读令牌、导入令牌**互不通用**：三套令牌各在自己的表里，校验各查各的表。双向隔离
 * 靠表隔离落地（读侧中间件两张表都认，见 middleware/read-token.ts；写侧只认本表）：
 * 只读令牌与导入令牌调 `/api/write/*` 一律 401，会话 Cookie 在令牌接口上同样无效。
 *
 * 与只读令牌一致的硬口径：
 * - 每用户一枚（`user_id` 主键），生成/重置即覆盖；库里只存 SHA-256 hex，明文只在
 *   生成/重置的响应里出现一次。
 * - 不设过期列：失效只走 吊销 / 重置 / 用户被停用或未批准；校验每次回表。
 * - `last_used_at` 每次通过本令牌调用接口时更新。
 * - 空间范围（core/token-scope.ts）：范围取读写令牌自己的那一份（`token_kind='write'`），
 *   与只读令牌的范围互不影响。
 */
import { randomToken, sha256Hex } from "./auth"
import { usersTable, writeTokensTable } from "../lib/tables"
import { scopeReplaceStatements, type TokenScope } from "./token-scope"

export interface WriteTokenRow {
  user_id: number
  token_hash: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

/** 对外状态（永不包含 token_hash 或明文），形状与 `ReadTokenStatus` 一致。 */
export interface WriteTokenStatus {
  active: boolean
  createdAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  /** 当前空间范围：`null` = 不限制；数组 = 范围（升序）。 */
  spaceIds: TokenScope
}

export function toWriteTokenStatus(
  row: WriteTokenRow | null,
  spaceIds: TokenScope
): WriteTokenStatus {
  return {
    active: Boolean(row && !row.revoked_at),
    createdAt: row?.created_at ?? null,
    lastUsedAt: row?.last_used_at ?? null,
    revokedAt: row?.revoked_at ?? null,
    spaceIds
  }
}

export async function getWriteTokenRow(
  db: D1Database,
  prefix: string,
  userId: number
): Promise<WriteTokenRow | null> {
  return db
    .prepare(`SELECT * FROM ${writeTokensTable(prefix)} WHERE user_id = ?`)
    .bind(userId)
    .first<WriteTokenRow>()
}

/**
 * 生成或覆盖（重置）当前用户的读写令牌，返回明文（只此一次）。
 *
 * `scope` 省略 = 保留现有范围；`null` = 清除范围；数组 = 设成该范围。令牌 upsert 与
 * 范围替换在同一次 `db.batch()` 里落库。
 */
export async function issueWriteToken(
  db: D1Database,
  prefix: string,
  userId: number,
  options: { scope?: TokenScope } = {}
): Promise<{ token: string; createdAt: string }> {
  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  const now = new Date().toISOString()
  const statements = [
    db
      .prepare(
        `INSERT INTO ${writeTokensTable(prefix)} (user_id, token_hash, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, NULL, NULL)
         ON CONFLICT(user_id) DO UPDATE SET
           token_hash = excluded.token_hash,
           created_at = excluded.created_at,
           last_used_at = NULL,
           revoked_at = NULL`
      )
      .bind(userId, tokenHash, now)
  ]
  if (options.scope !== undefined) {
    statements.push(
      ...scopeReplaceStatements(db, prefix, "write", userId, options.scope)
    )
  }
  await db.batch(statements)
  return { token, createdAt: now }
}

/**
 * 吊销：从未生成过返回 false（路由转 404），已吊销视为成功（幂等）。
 * 范围行不动：之后重新生成但不带范围时沿用，范围只会更窄，不会悄悄放大。
 */
export async function revokeWriteToken(
  db: D1Database,
  prefix: string,
  userId: number
): Promise<boolean> {
  const now = new Date().toISOString()
  const result = await db
    .prepare(
      `UPDATE ${writeTokensTable(prefix)} SET revoked_at = ?
        WHERE user_id = ? AND revoked_at IS NULL`
    )
    .bind(now, userId)
    .run()
  if (result.meta.changes > 0) return true
  return (await getWriteTokenRow(db, prefix, userId)) !== null
}

export interface WriteIdentity {
  userId: number
  /** 站点角色；`admin` 在写接口里等于「可见全部空间」。 */
  role: string
}

/** 校验令牌：哈希回表 + 连 users 校验激活/审批；已吊销或用户不可用一律 null。 */
export async function findWriteToken(
  db: D1Database,
  prefix: string,
  token: string
): Promise<WriteIdentity | null> {
  if (!token) return null
  const tokenHash = await sha256Hex(token)
  const row = await db
    .prepare(
      `SELECT t.user_id AS userId, u.role AS role,
              u.is_active AS isActive, u.approval_status AS approvalStatus
         FROM ${writeTokensTable(prefix)} t
         JOIN ${usersTable(prefix)} u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL`
    )
    .bind(tokenHash)
    .first<{
      userId: number
      role: string
      isActive: number
      approvalStatus: string
    }>()
  if (!row) return null
  if (!row.isActive || row.approvalStatus !== "approved") return null
  return { userId: row.userId, role: row.role }
}

/** 每次成功调用写接口后更新 last_used_at。 */
export async function touchWriteToken(
  db: D1Database,
  prefix: string,
  userId: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE ${writeTokensTable(prefix)} SET last_used_at = ? WHERE user_id = ?`
    )
    .bind(new Date().toISOString(), userId)
    .run()
}
