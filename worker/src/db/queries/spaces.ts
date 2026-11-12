/**
 * 空间与成员的数据访问：可见性、角色、成员管理、管理面统计都在这里。
 *
 * 权限判定不写在 SQL 注释里：路由层拿 `role` 后再决定 404/403（见
 * core/space-access.ts）。本文件只负责“查得到/查不到”。
 *
 * 空间主键是整数自增；`slug` 是 URL 段（`/s/<slug>/…`），创建时由空间名生成、
 * 之后不随改名变化。slug 的唯一性由唯一索引兜底。
 */
import {
  pagesTable,
  spaceMembersTable,
  spacesTable,
  usersTable
} from "../../lib/tables"

export type SpaceRole = "admin" | "editor" | "viewer"

export interface SpaceRow {
  id: number
  slug: string
  name: string
  description: string
  is_default: number
  created_by: number
  created_at: string
  updated_at: string
}

export type SpaceWithRoleRow = SpaceRow & { role: SpaceRole }

export interface SpaceMemberRow {
  space_id: number
  user_id: number
  role: SpaceRole
  created_at: string
}

export interface SpaceMemberViewRow {
  user_id: number
  username: string
  email: string
  role: SpaceRole
  created_at: string
}

export interface MemberCandidateRow {
  user_id: number
  username: string
  email: string
}

export interface SpaceOverviewRow extends SpaceRow {
  page_count: number
  trashed_page_count: number
  member_count: number
}

const SPACE_ORDER =
  "ORDER BY s.is_default DESC, s.name COLLATE NOCASE, s.created_at"

/** 站点管理员：全部空间。 */
export async function listAllSpaces(
  db: D1Database,
  prefix: string
): Promise<SpaceRow[]> {
  const rows = await db
    .prepare(`SELECT s.* FROM ${spacesTable(prefix)} s ${SPACE_ORDER}`)
    .all<SpaceRow>()
  return rows.results
}

/** 普通用户：仅自己是成员的空间，附带有效角色。 */
export async function listSpacesForUser(
  db: D1Database,
  prefix: string,
  userId: number
): Promise<SpaceWithRoleRow[]> {
  const rows = await db
    .prepare(
      `SELECT s.*, m.role AS role
         FROM ${spacesTable(prefix)} s
         JOIN ${spaceMembersTable(prefix)} m
           ON m.space_id = s.id AND m.user_id = ?
        ${SPACE_ORDER}`
    )
    .bind(userId)
    .all<SpaceWithRoleRow>()
  return rows.results
}

/** 导入令牌可用空间：站点管理员看全部，其余人看 admin/editor。 */
export async function listEditableSpaces(
  db: D1Database,
  prefix: string,
  userId: number
): Promise<SpaceWithRoleRow[]> {
  const rows = await db
    .prepare(
      `SELECT s.*, m.role AS role
         FROM ${spacesTable(prefix)} s
         JOIN ${spaceMembersTable(prefix)} m
           ON m.space_id = s.id AND m.user_id = ?
        WHERE m.role IN ('admin', 'editor')
        ${SPACE_ORDER}`
    )
    .bind(userId)
    .all<SpaceWithRoleRow>()
  return rows.results
}

/**
 * 全新安装的默认空间改名：只在「默认空间仍是播种名」且「还没有任何用户」时生效。
 *
 * 两个守卫保证存量库永不被改：有用户的空间（存量安装）不动；用户改过名的空间
 * 也不动。setup 重试时若上次改名失败，条件仍成立，可以安全重跑。
 */
export async function renameUnusedDefaultSpace(
  db: D1Database,
  prefix: string,
  fromName: string,
  toName: string,
  now: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE ${spacesTable(prefix)}
          SET name = ?, updated_at = ?
        WHERE is_default = 1 AND name = ?
          AND NOT EXISTS (SELECT 1 FROM ${usersTable(prefix)})`
    )
    .bind(toName, now, fromName)
    .run()
  return (result.meta.changes ?? 0) > 0
}

export async function findSpaceById(
  db: D1Database,
  prefix: string,
  id: number
): Promise<SpaceRow | null> {
  return db
    .prepare(`SELECT * FROM ${spacesTable(prefix)} WHERE id = ?`)
    .bind(id)
    .first<SpaceRow>()
}

export async function findDefaultSpace(
  db: D1Database,
  prefix: string
): Promise<SpaceRow | null> {
  return db
    .prepare(
      `SELECT * FROM ${spacesTable(prefix)} WHERE is_default = 1 LIMIT 1`
    )
    .first<SpaceRow>()
}

/** 某个 slug 是否已被占用（创建空间时定 slug 用）。 */
export async function isSpaceSlugTaken(
  db: D1Database,
  prefix: string,
  slug: string
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS hit FROM ${spacesTable(prefix)} WHERE slug = ?`)
    .bind(slug)
    .first<{ hit: number }>()
  return row !== null
}

/**
 * 全部已占用的 slug（一次查完，供批量发号用：迁移与建空间都按集合判重）。
 *
 * 空间数量是人工量级（几十个），一次读全比逐个 slug 查询更省往返，也避免在
 * 循环里发起多次 await。
 */
export async function listSpaceSlugs(
  db: D1Database,
  prefix: string
): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT slug FROM ${spacesTable(prefix)}`)
    .all<{ slug: string }>()
  return rows.results.map((row) => row.slug)
}

/**
 * 插入空间。
 *
 * `slug` 先写一个临时值（`tmp-<随机>`），因为定稿 slug 的兜底形态 `space-<id>`
 * 要等自增 id 出来才知道；路由拿到 `meta.last_row_id` 后用 {@link updateSpaceSlug}
 * 改成定稿值。临时值带随机后缀，不可能与既有 slug 撞。
 */
export function insertSpace(
  db: D1Database,
  prefix: string,
  space: {
    name: string
    description: string
    is_default: number
    created_by: number
    created_at: string
    updated_at: string
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ${spacesTable(prefix)}
        (slug, name, description, is_default, created_by, created_at, updated_at)
       VALUES ('tmp-' || lower(hex(randomblob(8))), ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      space.name,
      space.description,
      space.is_default,
      space.created_by,
      space.created_at,
      space.updated_at
    )
}

export function updateSpaceSlug(
  db: D1Database,
  prefix: string,
  id: number,
  slug: string
): D1PreparedStatement {
  return db
    .prepare(`UPDATE ${spacesTable(prefix)} SET slug = ? WHERE id = ?`)
    .bind(slug, id)
}

/** 改名/改简介：**不动 slug**（规格：创建后不随改名自动变）。 */
export async function updateSpace(
  db: D1Database,
  prefix: string,
  id: number,
  patch: { name?: string; description?: string; updatedAt: string }
): Promise<void> {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.name !== undefined) {
    sets.push("name = ?")
    values.push(patch.name)
  }
  if (patch.description !== undefined) {
    sets.push("description = ?")
    values.push(patch.description)
  }
  if (sets.length === 0) return
  sets.push("updated_at = ?")
  values.push(patch.updatedAt)
  values.push(id)
  await db
    .prepare(
      `UPDATE ${spacesTable(prefix)} SET ${sets.join(", ")} WHERE id = ?`
    )
    .bind(...values)
    .run()
}

/** 删除空间连同成员行（只允许对无页面的空间调用，见路由层）。 */
export function deleteSpaceStatements(
  db: D1Database,
  prefix: string,
  id: number
): D1PreparedStatement[] {
  return [
    db
      .prepare(`DELETE FROM ${spaceMembersTable(prefix)} WHERE space_id = ?`)
      .bind(id),
    db.prepare(`DELETE FROM ${spacesTable(prefix)} WHERE id = ?`).bind(id)
  ]
}

export async function listSpaceMembers(
  db: D1Database,
  prefix: string,
  spaceId: number
): Promise<SpaceMemberViewRow[]> {
  const rows = await db
    .prepare(
      `SELECT m.user_id, m.role, m.created_at,
              u.username, u.email
         FROM ${spaceMembersTable(prefix)} m
         JOIN ${usersTable(prefix)} u ON u.id = m.user_id
        WHERE m.space_id = ?
        ORDER BY CASE m.role
                   WHEN 'admin' THEN 0
                   WHEN 'editor' THEN 1
                   ELSE 2
                 END,
                 u.username COLLATE NOCASE`
    )
    .bind(spaceId)
    .all<SpaceMemberViewRow>()
  return rows.results
}

export async function findSpaceMember(
  db: D1Database,
  prefix: string,
  spaceId: number,
  userId: number
): Promise<SpaceMemberRow | null> {
  return db
    .prepare(
      `SELECT * FROM ${spaceMembersTable(prefix)}
        WHERE space_id = ? AND user_id = ?`
    )
    .bind(spaceId, userId)
    .first<SpaceMemberRow>()
}

export function insertSpaceMember(
  db: D1Database,
  prefix: string,
  member: SpaceMemberRow
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ${spaceMembersTable(prefix)}
        (space_id, user_id, role, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .bind(member.space_id, member.user_id, member.role, member.created_at)
}

export async function updateSpaceMemberRole(
  db: D1Database,
  prefix: string,
  spaceId: number,
  userId: number,
  role: SpaceRole
): Promise<void> {
  await db
    .prepare(
      `UPDATE ${spaceMembersTable(prefix)} SET role = ?
        WHERE space_id = ? AND user_id = ?`
    )
    .bind(role, spaceId, userId)
    .run()
}

export async function deleteSpaceMember(
  db: D1Database,
  prefix: string,
  spaceId: number,
  userId: number
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM ${spaceMembersTable(prefix)}
        WHERE space_id = ? AND user_id = ?`
    )
    .bind(spaceId, userId)
    .run()
}

export async function countSpaceAdmins(
  db: D1Database,
  prefix: string,
  spaceId: number
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${spaceMembersTable(prefix)}
        WHERE space_id = ? AND role = 'admin'`
    )
    .bind(spaceId)
    .first<{ count: number }>()
  return row?.count ?? 0
}

function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
}

/**
 * 可加入空间的用户：已激活且已批准、还不是成员；q 同时匹配显示名/邮箱。
 */
export async function listMemberCandidates(
  db: D1Database,
  prefix: string,
  spaceId: number,
  query: string
): Promise<MemberCandidateRow[]> {
  const q = query.trim().slice(0, 64)
  const pattern = likePattern(q)
  const filter =
    q === ""
      ? "1 = 1"
      : `(u.username LIKE ? ESCAPE '\\'
          OR u.email LIKE ? ESCAPE '\\')`
  const sql = `SELECT u.id AS user_id, u.username, u.email
     FROM ${usersTable(prefix)} u
    WHERE u.is_active = 1 AND u.approval_status = 'approved'
      AND NOT EXISTS (
        SELECT 1 FROM ${spaceMembersTable(prefix)} m
         WHERE m.space_id = ? AND m.user_id = u.id
      )
      AND ${filter}
    ORDER BY u.username COLLATE NOCASE, u.created_at
    LIMIT 20`
  const stmt = db.prepare(sql)
  const rows =
    q === ""
      ? await stmt.bind(spaceId).all<MemberCandidateRow>()
      : await stmt.bind(spaceId, pattern, pattern).all<MemberCandidateRow>()
  return rows.results
}

export async function countSpacePages(
  db: D1Database,
  prefix: string,
  spaceId: number
): Promise<{ active: number; trashed: number }> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS active,
              COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS trashed
         FROM ${pagesTable(prefix)}
        WHERE space_id = ?`
    )
    .bind(spaceId)
    .first<{ active: number; trashed: number }>()
  return { active: row?.active ?? 0, trashed: row?.trashed ?? 0 }
}

/** 管理面空间总览：页面数（不含/含回收站）与成员数。 */
export async function listSpaceOverviews(
  db: D1Database,
  prefix: string
): Promise<SpaceOverviewRow[]> {
  const rows = await db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM ${pagesTable(prefix)} p
                WHERE p.space_id = s.id AND p.deleted_at IS NULL) AS page_count,
              (SELECT COUNT(*) FROM ${pagesTable(prefix)} p
                WHERE p.space_id = s.id AND p.deleted_at IS NOT NULL) AS trashed_page_count,
              (SELECT COUNT(*) FROM ${spaceMembersTable(prefix)} m
                WHERE m.space_id = s.id) AS member_count
         FROM ${spacesTable(prefix)} s
        ${SPACE_ORDER}`
    )
    .all<SpaceOverviewRow>()
  return rows.results
}

/** 删用户时清掉成员关系（页面 created_by 等历史字段保持原值）。 */
export async function deleteSpaceMembershipsForUser(
  db: D1Database,
  prefix: string,
  userId: number
): Promise<void> {
  await db
    .prepare(`DELETE FROM ${spaceMembersTable(prefix)} WHERE user_id = ?`)
    .bind(userId)
    .run()
}

/**
 * 新用户加入默认空间：站点管理员 `admin`，其余 `editor`。默认空间尚未建立
 * （迁移没跑）时静默跳过，不阻断注册/建号。
 */
export async function joinDefaultSpace(
  db: D1Database,
  prefix: string,
  userId: number,
  siteRole: string
): Promise<void> {
  const space = await findDefaultSpace(db, prefix)
  if (!space) return
  await db
    .prepare(
      `INSERT OR IGNORE INTO ${spaceMembersTable(prefix)}
        (space_id, user_id, role, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .bind(
      space.id,
      userId,
      siteRole === "admin" ? "admin" : "editor",
      new Date().toISOString()
    )
    .run()
}
