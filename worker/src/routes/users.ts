import { Hono } from "hono"
import { renderCommentHtml } from "../lib/comment-render"
import { parseId } from "../lib/http"
import { toPlainText } from "../lib/sanitize"
import { getTablePrefix } from "../lib/table-prefix"
import {
  commentsTable,
  pagesTable,
  revisionsTable,
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
  bio: string
  docCount: number
  commentCount: number
  isAgent: boolean
  ownerName: string | null
  createdAt: string
}

export interface AuthorActivityEvent {
  id: string
  type: "page_created" | "page_edited" | "comment"
  pageId: number
  pageTitle: string
  spaceName: string
  commentId?: number
  excerpt?: string
  createdAt: string
}

export interface AuthorActivityResponse {
  events: AuthorActivityEvent[]
  hasMore: boolean
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
    `SELECT u.id, u.username, u.avatar_key, u.kind, u.bio, u.created_at,
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
      bio: string | null
      created_at: string
      owner_name: string | null
    }>()

  if (!row) return c.json({ error: "User not found" }, 404)

  const isAgent = row.kind === "agent"
  const bio = isAgent ? "" : (row.bio ?? "")

  const siteAdmin = c.get("role") === "admin"
  const viewerUserId = c.get("userId")

  const pages = pagesTable(prefix)
  const spaces = spacesTable(prefix)
  const members = spaceMembersTable(prefix)
  const comments = commentsTable(prefix)

  const membershipFilter = siteAdmin
    ? ""
    : `AND p.space_id IN (
         SELECT space_id FROM ${members} WHERE user_id = ?
       )`

  const docCountSql = `SELECT COUNT(*) AS total
    FROM ${pages} p
    JOIN ${spaces} s ON s.id = p.space_id
   WHERE p.created_by = ?
     AND p.deleted_at IS NULL
     ${membershipFilter}`

  const commentCountSql = `SELECT COUNT(*) AS total
    FROM ${comments} c
    JOIN ${pages} p ON p.id = c.page_id
    JOIN ${spaces} s ON s.id = p.space_id
   WHERE c.author_id = ?
     AND c.deleted_at IS NULL
     AND p.deleted_at IS NULL
     ${membershipFilter}`

  const docStmt = c.env.DB.prepare(docCountSql)
  const commentStmt = c.env.DB.prepare(commentCountSql)

  const [docRow, commentRow] = await Promise.all([
    siteAdmin
      ? docStmt.bind(id).first<{ total: number }>()
      : docStmt.bind(id, viewerUserId).first<{ total: number }>(),
    siteAdmin
      ? commentStmt.bind(id).first<{ total: number }>()
      : commentStmt.bind(id, viewerUserId).first<{ total: number }>()
  ])

  const profile: AuthorProfileDto = {
    id: row.id,
    username: row.username,
    avatarUrl: row.avatar_key ? `/api/files/${row.avatar_key}` : null,
    bio,
    docCount: docRow?.total ?? 0,
    commentCount: commentRow?.total ?? 0,
    isAgent,
    ownerName: isAgent ? (row.owner_name ?? null) : null,
    createdAt: row.created_at
  }

  return c.json(profile)
})

/**
 * GET /api/users/:id/activity
 *
 * 作者动态流（需登录会话）：
 * - 事件三类：新建文档（page_created）、编辑文档（page_edited，version_no > 1）、发表评论（comment）
 * - 权限过滤（硬线）：仅含当前查看者有权访问的空间内的事件；无权空间标题与评论零泄露
 * - 软删除过滤：已软删文档（deleted_at IS NOT NULL）排除；已软删评论排除；所属文档已软删的评论亦排除
 * - 合并倒序：按 createdAt DESC 倒序，以稳定次级键保证翻页不重不漏
 * - 分页：沿用 /pages 的 limit(默认20, 1-100)/offset/page 口径 + hasMore
 */
userRoutes.get("/:id/activity", async (c) => {
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

  const siteAdmin = c.get("role") === "admin"
  const viewerUserId = c.get("userId")

  const pages = pagesTable(prefix)
  const spaces = spacesTable(prefix)
  const members = spaceMembersTable(prefix)
  const revisions = revisionsTable(prefix)
  const comments = commentsTable(prefix)

  const membershipFilter = siteAdmin
    ? ""
    : `AND p.space_id IN (
         SELECT space_id FROM ${members} WHERE user_id = ?
       )`

  const sql = `SELECT 'page_created' AS event_type,
         ('page-' || p.id) AS unique_id,
         p.id AS page_id,
         p.title AS page_title,
         s.name AS space_name,
         NULL AS comment_id,
         NULL AS body_md,
         p.created_at AS created_at
    FROM ${pages} p
    JOIN ${spaces} s ON s.id = p.space_id
   WHERE p.created_by = ?
     AND p.deleted_at IS NULL
     ${membershipFilter}

   UNION ALL

  SELECT 'page_edited' AS event_type,
         ('revision-' || r.id) AS unique_id,
         p.id AS page_id,
         p.title AS page_title,
         s.name AS space_name,
         NULL AS comment_id,
         NULL AS body_md,
         r.created_at AS created_at
    FROM ${revisions} r
    JOIN ${pages} p ON p.id = r.page_id
    JOIN ${spaces} s ON s.id = p.space_id
   WHERE r.editor_id = ?
     AND r.version_no > 1
     AND p.deleted_at IS NULL
     ${membershipFilter}

   UNION ALL

  SELECT 'comment' AS event_type,
         ('comment-' || c.id) AS unique_id,
         p.id AS page_id,
         p.title AS page_title,
         s.name AS space_name,
         c.id AS comment_id,
         c.body_md AS body_md,
         c.created_at AS created_at
    FROM ${comments} c
    JOIN ${pages} p ON p.id = c.page_id
    JOIN ${spaces} s ON s.id = p.space_id
   WHERE c.author_id = ?
     AND c.deleted_at IS NULL
     AND p.deleted_at IS NULL
     ${membershipFilter}

   ORDER BY created_at DESC, unique_id DESC
   LIMIT ? OFFSET ?`

  const stmt = c.env.DB.prepare(sql)
  const bindings = siteAdmin
    ? [id, id, id, limit + 1, offset]
    : [id, viewerUserId, id, viewerUserId, id, viewerUserId, limit + 1, offset]

  const rows = await stmt.bind(...bindings).all<{
    event_type: "page_created" | "page_edited" | "comment"
    unique_id: string
    page_id: number
    page_title: string
    space_name: string
    comment_id: number | null
    body_md: string | null
    created_at: string
  }>()

  const hasMore = rows.results.length > limit
  const items = rows.results.slice(0, limit)

  const events: AuthorActivityEvent[] = items.map((row) => {
    if (row.event_type === "comment") {
      const plainText = toPlainText(renderCommentHtml(row.body_md ?? ""))
      const excerpt = [...plainText].slice(0, 100).join("")
      return {
        id: row.unique_id,
        type: "comment",
        pageId: row.page_id,
        pageTitle: row.page_title,
        spaceName: row.space_name,
        commentId: row.comment_id ?? undefined,
        excerpt,
        createdAt: row.created_at
      }
    }
    return {
      id: row.unique_id,
      type: row.event_type,
      pageId: row.page_id,
      pageTitle: row.page_title,
      spaceName: row.space_name,
      createdAt: row.created_at
    }
  })

  const response: AuthorActivityResponse = {
    events,
    hasMore
  }

  return c.json(response)
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
