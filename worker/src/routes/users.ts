import { Hono } from "hono"
import { parseId } from "../lib/http"
import { getTablePrefix } from "../lib/table-prefix"
import {
  pagesTable,
  spaceMembersTable,
  spacesTable,
  usersTable
} from "../lib/tables"
import type { HonoEnv } from "../types"

export const userRoutes = new Hono<HonoEnv>()

export interface AuthorProfileDto {
  id: number
  username: string
  avatarUrl: string | null
  isAgent: boolean
  ownerName: string | null
  createdAt: string
}

export interface AuthorPageItem {
  id: number
  title: string
  spaceName: string
  createdAt: string
  updatedAt: string
}

export interface AuthorPagesResponse {
  pages: AuthorPageItem[]
  total: number
  page: number
  limit: number
  hasMore: boolean
}

/**
 * GET /api/users/:id/profile
 *
 * 公开作者资料（需登录会话）：
 * - 返回 { id, username, avatarUrl, isAgent, ownerName, createdAt }
 * - ownerName 仅 agent 时有值（且 owner 存在时）；人类用户或 owner 不存在时为 null
 * - 用户不存在或 id 非规范正整数回 404
 * - 绝不返回 email、password_hash、role、email_verified 等敏感字段
 */
userRoutes.get("/:id/profile", async (c) => {
  const prefix = getTablePrefix(c.env)
  const id = parseId(c.req.param("id"))
  if (id === null) return c.json({ error: "User not found" }, 404)

  const row = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.avatar_key, u.kind, u.created_at,
            CASE WHEN u.kind = 'agent' THEN o.username ELSE NULL END AS owner_name
       FROM ${usersTable(prefix)} u
       LEFT JOIN ${usersTable(prefix)} o ON o.id = u.owner_user_id
      WHERE u.id = ?`
  )
    .bind(id)
    .first<{
      id: number
      username: string
      avatar_key: string
      kind: string
      created_at: string
      owner_name: string | null
    }>()

  if (!row) return c.json({ error: "User not found" }, 404)

  const isAgent = row.kind === "agent"
  const profile: AuthorProfileDto = {
    id: row.id,
    username: row.username,
    avatarUrl: row.avatar_key ? `/api/files/${row.avatar_key}` : null,
    isAgent,
    ownerName: isAgent ? (row.owner_name ?? null) : null,
    createdAt: row.created_at
  }

  return c.json(profile)
})

/**
 * GET /api/users/:id/pages
 *
 * 作者创建的页面列表（需登录会话）：
 * - 仅含当前查看者有权访问的空间内的页面（复用现行空间可见性判定）
 * - 站点管理员全空间；普通用户只看自己是 space_members 成员的空间
 * - 软删页面（deleted_at IS NOT NULL）排除，不泄露标题且不计入 total
 * - 必须分页，按 updatedAt 倒序（相同按 id 倒序）
 * - 字段：id、title、spaceName、createdAt、updatedAt
 */
userRoutes.get("/:id/pages", async (c) => {
  const prefix = getTablePrefix(c.env)
  const id = parseId(c.req.param("id"))
  if (id === null) return c.json({ error: "User not found" }, 404)

  const user = await c.env.DB.prepare(
    `SELECT id FROM ${usersTable(prefix)} WHERE id = ?`
  )
    .bind(id)
    .first<{ id: number }>()

  if (!user) return c.json({ error: "User not found" }, 404)

  const rawLimit = Number.parseInt(c.req.query("limit") ?? "20", 10)
  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1),
    100
  )

  let offset = 0
  let page = 1
  const offsetParam = c.req.query("offset")
  const pageParam = c.req.query("page")

  if (offsetParam !== undefined) {
    const parsedOffset = Number.parseInt(offsetParam, 10)
    offset = Math.max(Number.isFinite(parsedOffset) ? parsedOffset : 0, 0)
    page = Math.floor(offset / limit) + 1
  } else if (pageParam !== undefined) {
    const parsedPage = Number.parseInt(pageParam, 10)
    page = Math.max(Number.isFinite(parsedPage) ? parsedPage : 1, 1)
    offset = (page - 1) * limit
  }

  const pages = pagesTable(prefix)
  const spaces = spacesTable(prefix)
  const members = spaceMembersTable(prefix)
  const siteAdmin = c.get("role") === "admin"
  const viewerUserId = c.get("userId")

  const membershipFilter = siteAdmin
    ? ""
    : `AND p.space_id IN (
         SELECT space_id FROM ${members} WHERE user_id = ?
       )`

  const countSql = `SELECT COUNT(*) AS total
    FROM ${pages} p
    JOIN ${spaces} s ON s.id = p.space_id
   WHERE p.created_by = ?
     AND p.deleted_at IS NULL
     ${membershipFilter}`

  const countStmt = c.env.DB.prepare(countSql)
  const countRow = siteAdmin
    ? await countStmt.bind(id).first<{ total: number }>()
    : await countStmt.bind(id, viewerUserId).first<{ total: number }>()

  const total = countRow?.total ?? 0

  const listSql = `SELECT p.id,
          p.title,
          s.name AS space_name,
          p.created_at,
          p.updated_at
     FROM ${pages} p
     JOIN ${spaces} s ON s.id = p.space_id
    WHERE p.created_by = ?
      AND p.deleted_at IS NULL
      ${membershipFilter}
    ORDER BY p.updated_at DESC, p.id DESC
    LIMIT ? OFFSET ?`

  const listStmt = c.env.DB.prepare(listSql)
  const rows = siteAdmin
    ? await listStmt.bind(id, limit, offset).all<{
        id: number
        title: string
        space_name: string
        created_at: string
        updated_at: string
      }>()
    : await listStmt.bind(id, viewerUserId, limit, offset).all<{
        id: number
        title: string
        space_name: string
        created_at: string
        updated_at: string
      }>()

  const items: AuthorPageItem[] = rows.results.map((r) => ({
    id: r.id,
    title: r.title,
    spaceName: r.space_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))

  const response: AuthorPagesResponse = {
    pages: items,
    total,
    page,
    limit,
    hasMore: offset + items.length < total
  }

  return c.json(response)
})
