/**
 * 令牌空间范围的唯一实现（二期规格 §2.2 / §2.4；`schema_v3` 起按令牌 id）。
 *
 * - 一行 `token_space_scopes` = 「该令牌可见该空间」；无行 = 不限制。每个令牌各存
 *   各的范围（`token_id`），同一用户的只读 / 读写令牌互不影响。
 * - 有效可见范围 = **令牌主人凭自身权限能看的空间 ∩ 范围集合**：范围只能收窄、不能
 *   放大。主人不是成员的空间即使被写进范围也不生效；主人退出某空间后令牌立即看不见，
 *   重新加入后范围自动恢复生效。对站点管理员同样生效。
 * - 交集在每次令牌校验时现算（本文件不缓存），所以范围改动与成员关系变化都立即生效。
 * - 空集（无行）与「什么都不限制」同义，所以空数组永不入库：写接口一律回 400，防止
 *   把范围误设成「什么都看不见」。
 *
 * 表名一律经 tables.ts 拼装；空间事实查询复用 `db/queries/spaces.ts`（排序也是那里的
 * `SPACE_ORDER`），本文件只负责「取/存/校验/求交」。
 */
import {
  listAllSpaces,
  listSpacesForUser,
  type SpaceRow
} from "../db/queries/spaces"
import { tokenSpaceScopesTable } from "../lib/tables"

/** 令牌种类：`api_tokens.kind` 的取值（建行时固定，之后不可变更）。 */
export type TokenKind = "read" | "write"

/** 空间范围：`null` = 不限制（无行）；数组 = 当前范围（升序、已去重）。 */
export type TokenScope = number[] | null

/**
 * 读取某枚令牌的范围：无行返回 `null`（不限制），有行按 `space_id` 升序返回。
 * 行随空间删除留着无妨——交集会把已不存在的空间自然排除，不需要顺带清理。
 */
export async function getTokenScope(
  db: D1Database,
  prefix: string,
  tokenId: number
): Promise<TokenScope> {
  const rows = await db
    .prepare(
      `SELECT space_id FROM ${tokenSpaceScopesTable(prefix)}
        WHERE token_id = ?
        ORDER BY space_id`
    )
    .bind(tokenId)
    .all<{ space_id: number }>()
  if (rows.results.length === 0) return null
  return rows.results.map((row) => row.space_id)
}

/**
 * 把某枚令牌的范围整体替换成 `scope` 的语句序列（先删后插），交给调用方的
 * `db.batch()` 执行。`null` 只删不插。
 */
export function scopeReplaceStatements(
  db: D1Database,
  prefix: string,
  tokenId: number,
  scope: TokenScope
): D1PreparedStatement[] {
  const statements = [
    db
      .prepare(
        `DELETE FROM ${tokenSpaceScopesTable(prefix)}
          WHERE token_id = ?`
      )
      .bind(tokenId)
  ]
  for (const spaceId of scope ?? []) {
    statements.push(
      db
        .prepare(
          `INSERT INTO ${tokenSpaceScopesTable(prefix)}
            (token_id, space_id)
           VALUES (?, ?)`
        )
        .bind(tokenId, spaceId)
    )
  }
  return statements
}

/** 只改范围、不换令牌：整体替换（单次 `db.batch()`，要么全换要么不动）。 */
export async function setTokenScope(
  db: D1Database,
  prefix: string,
  tokenId: number,
  scope: TokenScope
): Promise<void> {
  await db.batch(scopeReplaceStatements(db, prefix, tokenId, scope))
}

/** 解析结果：保留现有范围 / 设成某个范围 / 非法。 */
export type TokenScopeInput =
  | { ok: true; action: "keep" }
  | { ok: true; action: "set"; scope: TokenScope }
  | { ok: false }

/**
 * 解析请求体里的 `spaceIds`，返回「保留 / 设置」两种意图，非法一律 `{ok:false}`：
 *
 * - 缺键：设置类接口（PUT）必填、生成类接口（POST）表示「保留现有范围」；
 * - `null`：清除范围（不限制）；
 * - 非空整数数组：设成这个范围，去重后升序存储；
 * - 空数组、非数组、非整数元素：失败（空数组会变成「什么都看不见」，按规格回 400）。
 *
 * id 是否属于主人当前可见空间不在这里判（见 `ownerVisibleSpaceIds`）。
 */
export function parseTokenScopeInput(
  body: unknown,
  options: { required: boolean }
): TokenScopeInput {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    // 没有请求体（生成类接口允许）：保留现有范围。
    return options.required ? { ok: false } : { ok: true, action: "keep" }
  }
  if (!Object.hasOwn(body, "spaceIds")) {
    return options.required ? { ok: false } : { ok: true, action: "keep" }
  }
  const value = (body as { spaceIds: unknown }).spaceIds
  if (value === null) return { ok: true, action: "set", scope: null }
  if (!Array.isArray(value)) return { ok: false }
  const ids = new Set<number>()
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry <= 0) {
      return { ok: false }
    }
    ids.add(entry)
  }
  if (ids.size === 0) return { ok: false }
  return {
    ok: true,
    action: "set",
    scope: [...ids].sort((a, b) => a - b)
  }
}

/**
 * 令牌主人当前可见的空间 id 集合：站点管理员 = 全部空间，其余人 = 自己是成员的空间
 * （任一角色都算）。复用 `db/queries/spaces.ts` 的两支查询，不另写 SQL。
 */
export async function ownerVisibleSpaceIds(
  db: D1Database,
  prefix: string,
  userId: number,
  isSiteAdmin: boolean
): Promise<Set<number>> {
  const spaces = isSiteAdmin
    ? await listAllSpaces(db, prefix)
    : await listSpacesForUser(db, prefix, userId)
  return new Set(spaces.map((space) => space.id))
}

/** 范围是否全部落在主人可见空间内（`null` 恒通过）：不满足就整单 400，不部分写入。 */
export function isScopeWithinSpaces(
  scope: TokenScope,
  visible: ReadonlySet<number>
): boolean {
  if (scope === null) return true
  return scope.every((spaceId) => visible.has(spaceId))
}

/** 令牌范围是否允许某个空间（`null` 恒允许）：写/读侧判定用的纯谓词。 */
export function tokenScopeAllows(scope: TokenScope, spaceId: number): boolean {
  return scope === null || scope.includes(spaceId)
}

/**
 * 令牌的有效可见空间 = 主人可见空间 ∩ 范围，顺序沿用 `SPACE_ORDER`（默认空间在前，
 * 其余按名称大小写不敏感、再按创建时间）。读侧的空间列表接口直接映射它。
 */
export async function listTokenVisibleSpaces(
  db: D1Database,
  prefix: string,
  token: { userId: number; isSiteAdmin: boolean; scope: TokenScope }
): Promise<SpaceRow[]> {
  const spaces = token.isSiteAdmin
    ? await listAllSpaces(db, prefix)
    : await listSpacesForUser(db, prefix, token.userId)
  if (token.scope === null) return spaces
  const allowed = new Set(token.scope)
  return spaces.filter((space) => allowed.has(space.id))
}
