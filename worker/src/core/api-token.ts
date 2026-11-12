/**
 * 接口令牌（`schema_v3` 起读写合表）：一个令牌一行，`kind` 在建行时固定。
 *
 * 三条隔离线，全部落在数据模型上，不靠调用方约定：
 * - 读接口（middleware/read-token.ts）认 `kind = read` 与 `kind = write`，范围按命中的
 *   那一行（`token_space_scopes.token_id`）取；
 * - 写接口只认 `kind = write`（finder 查询直接带 kind 过滤，read 令牌查不到即 401）；
 * - 导入令牌仍是另一张表（core/import-token.ts），两个方向都进不来。
 *
 * 与导入令牌一致的硬口径：
 * - 库里只存令牌的 SHA-256 hex，明文只在生成响应里出现一次；
 * - 不设过期列：失效只走吊销 / 用户被停用或未批准，校验每次回表；
 * - `last_used_at` 按**令牌行**更新（同一用户的两枚令牌互不影响）。
 *
 * 名称（规格 §1）：trim 后 ≤40 码点；留空用默认名。kind 创建后不可变更——本模块
 * 不提供改 kind 的函数，也没有对应 SQL。
 */
import { randomToken, sha256Hex } from "./auth"
import {
  apiTokensTable,
  tokenSpaceScopesTable,
  usersTable
} from "../lib/tables"
import {
  scopeReplaceStatements,
  type TokenKind,
  type TokenScope
} from "./token-scope"

/** 名称上限：**码点**数（`Array.from`，不按 UTF-16 长度算）。 */
export const API_TOKEN_NAME_MAX = 40

/** 迁移与新建时的默认名（迁移里的字面量与本表保持一致）。 */
export const API_TOKEN_DEFAULT_NAMES: Record<TokenKind, string> = {
  read: "只读 Token",
  write: "读写 Token"
}

export function defaultTokenName(kind: TokenKind): string {
  return API_TOKEN_DEFAULT_NAMES[kind]
}

export type TokenNameResult =
  | { ok: true; name: string }
  | { ok: false; reason: "INVALID_TOKEN_NAME" }

/**
 * 解析建令牌时的名称：缺省 / 空白 → 默认名；非字符串或超 40 码点 → 失败。
 * 改名走 `parseTokenNameUpdate`（那里空白是拒绝，不是默认名）。
 */
export function parseTokenName(raw: unknown, kind: TokenKind): TokenNameResult {
  if (raw === undefined || raw === null) {
    return { ok: true, name: defaultTokenName(kind) }
  }
  if (typeof raw !== "string")
    return { ok: false, reason: "INVALID_TOKEN_NAME" }
  const name = raw.trim()
  if (name === "") return { ok: true, name: defaultTokenName(kind) }
  if (Array.from(name).length > API_TOKEN_NAME_MAX) {
    return { ok: false, reason: "INVALID_TOKEN_NAME" }
  }
  return { ok: true, name }
}

/**
 * 解析改名请求里的名称：trim 后必须是 1–40 码点。
 *
 * 与建令牌不同，空白**不是**「用默认名」——改名把名字清空会让列表里出现一行
 * 没有标识的令牌，所以这里直接拒绝，由路由回 400。
 */
export function parseTokenNameUpdate(raw: unknown): TokenNameResult {
  if (typeof raw !== "string")
    return { ok: false, reason: "INVALID_TOKEN_NAME" }
  const name = raw.trim()
  if (name === "") return { ok: false, reason: "INVALID_TOKEN_NAME" }
  if (Array.from(name).length > API_TOKEN_NAME_MAX) {
    return { ok: false, reason: "INVALID_TOKEN_NAME" }
  }
  return { ok: true, name }
}

export interface ApiTokenRow {
  id: number
  user_id: number
  kind: TokenKind
  name: string
  token_hash: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export interface ApiTokenIdentity {
  tokenId: number
  /** 令牌主人。 */
  userId: number
  /** 站点角色：`admin` 在令牌接口里等于「可见全部空间」。 */
  role: string
  /** 行内固定的种类；写接口只会拿到 `write`。 */
  kind: TokenKind
}

/**
 * 校验 `Authorization: Bearer` 的明文：按 hash 查有效行 + 连 users 校验激活/审批。
 *
 * `options.kind` 是服务端的硬过滤（写接口传 `"write"`），不是「查出来再判断」：
 * 只读令牌在写接口上根本查不到，401 与限流失败计数都和「无效令牌」完全一致。
 */
export async function findApiToken(
  db: D1Database,
  prefix: string,
  token: string,
  options: { kind?: TokenKind } = {}
): Promise<ApiTokenIdentity | null> {
  if (!token) return null
  const tokenHash = await sha256Hex(token)
  const kindFilter = options.kind ? " AND t.kind = ?" : ""
  const sql = `SELECT t.id AS tokenId, t.user_id AS userId, t.kind AS kind,
                      u.role AS role, u.is_active AS isActive,
                      u.approval_status AS approvalStatus
                 FROM ${apiTokensTable(prefix)} t
                 JOIN ${usersTable(prefix)} u ON u.id = t.user_id
                WHERE t.token_hash = ? AND t.revoked_at IS NULL${kindFilter}`
  const statement = db.prepare(sql)
  const row = await (options.kind
    ? statement.bind(tokenHash, options.kind)
    : statement.bind(tokenHash)
  ).first<{
    tokenId: number
    userId: number
    kind: TokenKind
    role: string
    isActive: number
    approvalStatus: string
  }>()
  if (!row) return null
  if (!row.isActive || row.approvalStatus !== "approved") return null
  return {
    tokenId: row.tokenId,
    userId: row.userId,
    role: row.role,
    kind: row.kind
  }
}

/** 每次成功调用后按令牌行更新 `last_used_at`。 */
export async function touchApiToken(
  db: D1Database,
  prefix: string,
  tokenId: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE ${apiTokensTable(prefix)} SET last_used_at = ? WHERE id = ?`
    )
    .bind(new Date().toISOString(), tokenId)
    .run()
}

/** 按 id 取本人一行（含已吊销；改范围时的 404 判定要用）。 */
export async function getTokenRowById(
  db: D1Database,
  prefix: string,
  userId: number,
  tokenId: number
): Promise<ApiTokenRow | null> {
  return db
    .prepare(
      `SELECT * FROM ${apiTokensTable(prefix)} WHERE id = ? AND user_id = ?`
    )
    .bind(tokenId, userId)
    .first<ApiTokenRow>()
}

/** 某用户的全部有效令牌（`GET /api/me/tokens` 用），按创建时间升序。 */
export async function listActiveTokens(
  db: D1Database,
  prefix: string,
  userId: number
): Promise<ApiTokenRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM ${apiTokensTable(prefix)}
        WHERE user_id = ? AND revoked_at IS NULL
        ORDER BY created_at, id`
    )
    .bind(userId)
    .all<ApiTokenRow>()
  return rows.results
}

export interface IssueApiTokenOptions {
  kind: TokenKind
  /** 已归一化的名称（走 parseTokenName）；缺省用默认名。 */
  name?: string
  /** 省略 = 不写范围（不限）；`null` 同义；数组 = 设成该范围。 */
  scope?: TokenScope
}

/**
 * 新建一枚令牌，返回明文（只此一次）。
 *
 * 令牌行与范围行在同一个 `db.batch()`（D1 的事务单位）里落库：范围插入用
 * `SELECT id FROM api_tokens WHERE token_hash = ?` 定位刚插入的行，不需要先读回 id，
 * 所以不会出现「密钥建好了、范围没写上」而悄悄放大权限。
 */
export async function issueApiToken(
  db: D1Database,
  prefix: string,
  userId: number,
  options: IssueApiTokenOptions
): Promise<{ id: number; token: string; createdAt: string }> {
  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  const now = new Date().toISOString()
  const statements: D1PreparedStatement[] = []

  statements.push(
    db
      .prepare(
        `INSERT INTO ${apiTokensTable(prefix)}
           (user_id, kind, name, token_hash, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`
      )
      .bind(
        userId,
        options.kind,
        options.name ?? defaultTokenName(options.kind),
        tokenHash,
        now
      )
  )
  const insertIndex = statements.length - 1

  for (const spaceId of options.scope ?? []) {
    statements.push(
      db
        .prepare(
          `INSERT INTO ${tokenSpaceScopesTable(prefix)} (token_id, space_id)
           SELECT id, ? FROM ${apiTokensTable(prefix)} WHERE token_hash = ?`
        )
        .bind(spaceId, tokenHash)
    )
  }

  const results = await db.batch(statements)
  return {
    id: results[insertIndex].meta.last_row_id,
    token,
    createdAt: now
  }
}

/** 按 id 吊销本人令牌：有效行被改动返回 true；不存在 / 已吊销 / 非本人返回 false。 */
export async function revokeTokenById(
  db: D1Database,
  prefix: string,
  userId: number,
  tokenId: number
): Promise<boolean> {
  const now = new Date().toISOString()
  const result = await db
    .prepare(
      `UPDATE ${apiTokensTable(prefix)} SET revoked_at = ?
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
    )
    .bind(now, tokenId, userId)
    .run()
  return result.meta.changes > 0
}

/**
 * 改名：只改未吊销、本人的行，返回是否改到。kind 不在可改字段里。
 * 未命中（不存在 / 非本人 / 已吊销）统一返回 false，由路由回 404。
 */
export async function renameToken(
  db: D1Database,
  prefix: string,
  userId: number,
  tokenId: number,
  name: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE ${apiTokensTable(prefix)} SET name = ?
        WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
    )
    .bind(name, tokenId, userId)
    .run()
  return result.meta.changes > 0
}

/** 只改范围、不换令牌：整体替换（单次 `db.batch()`，要么全换要么不动）。 */
export async function setApiTokenScope(
  db: D1Database,
  prefix: string,
  tokenId: number,
  scope: TokenScope
): Promise<void> {
  await db.batch(scopeReplaceStatements(db, prefix, tokenId, scope))
}
