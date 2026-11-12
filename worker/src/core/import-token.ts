/**
 * 个人导入令牌（规格 §12.1；`schema_v3` 起为多行）。
 *
 * - 每个浏览器插件凭证一行（`id` 主键），库里只存令牌的 SHA-256 hex，与 `sessions`
 *   同口径；明文只在生成响应里出现一次。
 * - 不设过期列：失效只走吊销 / 用户被停用或未批准；校验每次回表。
 * - `last_used_at` 按令牌行更新（吊销一枚不影响其它插件凭证）。
 * - 与接口令牌（core/api-token.ts）**分表**：`/api/import/*` 只查本表，接口令牌的
 *   hash 不在这里；反过来导入令牌也进不了 read/write 接口。
 * - 名称：trim 后 ≤40 码点，留空用默认名「浏览器插件」（多行后名称是管理信息）。
 */
import { sha256Hex, randomToken } from "./auth"
import { importTokensTable, usersTable } from "../lib/tables"
import { API_TOKEN_NAME_MAX, type TokenNameResult } from "./api-token"

/** 迁移与新建时的默认名（迁移里的字面量与这里保持一致）。 */
export const IMPORT_TOKEN_DEFAULT_NAME = "浏览器插件"

export interface ImportTokenRow {
  id: number
  user_id: number
  name: string
  token_hash: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export interface ImportTokenIdentity {
  tokenId: number
  userId: number
  role: string
}

/** 解析名称：缺省 / 空白 → 默认名；非字符串或超 40 码点 → 失败。 */
export function parseImportTokenName(raw: unknown): TokenNameResult {
  if (raw === undefined || raw === null) {
    return { ok: true, name: IMPORT_TOKEN_DEFAULT_NAME }
  }
  if (typeof raw !== "string")
    return { ok: false, reason: "INVALID_TOKEN_NAME" }
  const name = raw.trim()
  if (name === "") return { ok: true, name: IMPORT_TOKEN_DEFAULT_NAME }
  if (Array.from(name).length > API_TOKEN_NAME_MAX) {
    return { ok: false, reason: "INVALID_TOKEN_NAME" }
  }
  return { ok: true, name }
}

/** 某用户的全部有效导入凭证（`GET /api/me/import-tokens` 用），按创建时间升序。 */
export async function listActiveImportTokens(
  db: D1Database,
  prefix: string,
  userId: number
): Promise<ImportTokenRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM ${importTokensTable(prefix)}
        WHERE user_id = ? AND revoked_at IS NULL
        ORDER BY created_at, id`
    )
    .bind(userId)
    .all<ImportTokenRow>()
  return rows.results
}

export interface IssueImportTokenOptions {
  /** 已归一化的名称（走 parseImportTokenName）；缺省用默认名。 */
  name?: string
}

/** 新建一枚导入令牌，返回明文（只此一次）。 */
export async function issueImportToken(
  db: D1Database,
  prefix: string,
  userId: number,
  options: IssueImportTokenOptions = {}
): Promise<{ id: number; token: string; createdAt: string }> {
  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  const now = new Date().toISOString()
  const statements: D1PreparedStatement[] = []
  statements.push(
    db
      .prepare(
        `INSERT INTO ${importTokensTable(prefix)}
           (user_id, name, token_hash, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, NULL, NULL)`
      )
      .bind(userId, options.name ?? IMPORT_TOKEN_DEFAULT_NAME, tokenHash, now)
  )
  const results = await db.batch(statements)
  return {
    id: results[results.length - 1].meta.last_row_id,
    token,
    createdAt: now
  }
}

/** 吊销本人单枚导入凭证：有效行被改动返回 true；不存在 / 已吊销 / 非本人 false。 */
export async function revokeImportTokenById(
  db: D1Database,
  prefix: string,
  userId: number,
  tokenId: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE ${importTokensTable(prefix)} SET revoked_at = ?
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
    )
    .bind(new Date().toISOString(), tokenId, userId)
    .run()
  return result.meta.changes > 0
}

/** 校验令牌：哈希回表 + 连 users 校验激活/审批；已吊销或用户不可用一律 null。 */
export async function findImportToken(
  db: D1Database,
  prefix: string,
  token: string
): Promise<ImportTokenIdentity | null> {
  if (!token) return null
  const tokenHash = await sha256Hex(token)
  const row = await db
    .prepare(
      `SELECT t.id AS tokenId, t.user_id AS userId, u.role AS role,
              u.is_active AS isActive, u.approval_status AS approvalStatus
         FROM ${importTokensTable(prefix)} t
         JOIN ${usersTable(prefix)} u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL`
    )
    .bind(tokenHash)
    .first<{
      tokenId: number
      userId: number
      role: string
      isActive: number
      approvalStatus: string
    }>()
  if (!row) return null
  if (!row.isActive || row.approvalStatus !== "approved") return null
  return { tokenId: row.tokenId, userId: row.userId, role: row.role }
}

/** 每次成功调用导入接口后按令牌行更新 `last_used_at`。 */
export async function touchImportToken(
  db: D1Database,
  prefix: string,
  tokenId: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE ${importTokensTable(prefix)} SET last_used_at = ? WHERE id = ?`
    )
    .bind(new Date().toISOString(), tokenId)
    .run()
}
