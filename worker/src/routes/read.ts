/**
 * 只读接口（一期）：供 Muse 的自定义连接器接入，**只有读，没有任何写接口**。
 *
 * 鉴权只认只读令牌（`Authorization: Bearer`，见 middleware/read-token.ts）；权限等于
 * 令牌所属用户本人的读权限：站点管理员可见全部空间，其余人只见自己是成员的空间，
 * 与站内页面树/搜索同一口径（SQL 层过滤，非成员空间连标题都不会出现在响应里）。
 *
 * 三个接口的字段是**冻结契约**，按规格逐字使用 snake_case（`parent_id` / `updated_at`
 * / `created_at` / `content_json`）——这是本仓「响应字段一律 camelCase」通则的唯一例外，
 * 连接器按此对接，别在实现里顺手改成 camelCase。
 *
 * 软删页面（`deleted_at` 非空）在三处一律排除：树、搜索、单页。
 */
import { Hono } from "hono"
import { getPageRow } from "../db/queries/pages"
import { resolveSpaceRole } from "../core/space-access"
import { makeSnippet, toMatchQuery } from "../lib/fts"
import { toPlainText } from "../lib/sanitize"
import { pagesFtsTable, pagesTable, spaceMembersTable } from "../lib/tables"
import { getTablePrefix } from "../lib/table-prefix"
import { resolvePageMarkdown } from "../lib/tiptap-markdown"
import { readTokenMiddleware } from "../middleware/read-token"
import type { HonoEnv } from "../types"

export const readRoutes = new Hono<HonoEnv>()

// 整段只认只读令牌：会话 Cookie 在这里无效（职责分离，见中间件注释）。
readRoutes.use("*", readTokenMiddleware)

/** 搜索上限（规格定版：20 条，不分页）。 */
export const READ_SEARCH_LIMIT = 20

interface TreeRow {
  id: string
  title: string
  parent_id: string | null
  updated_at: string
}

/**
 * 全部未删页面的扁平表（不分页、不建树）：`parent_id` 给调用方自己拼层级。
 *
 * 排序按「空间 → 同级顺序 → 创建时间」，与站内页面树一致，连接器拿到的顺序稳定。
 */
readRoutes.get("/tree", async (c) => {
  const prefix = getTablePrefix(c.env)
  const siteAdmin = c.get("role") === "admin"
  const membershipFilter = siteAdmin
    ? ""
    : `AND p.space_id IN (
         SELECT space_id FROM ${spaceMembersTable(prefix)} WHERE user_id = ?
       )`
  const stmt = c.env.DB.prepare(
    `SELECT p.id AS id, p.title AS title, p.parent_id AS parent_id,
            p.updated_at AS updated_at
       FROM ${pagesTable(prefix)} p
      WHERE p.deleted_at IS NULL
        ${membershipFilter}
      ORDER BY p.space_id, p.sort_order, p.created_at`
  )
  const rows = siteAdmin
    ? await stmt.all<TreeRow>()
    : await stmt.bind(c.get("userId")).all<TreeRow>()

  return c.json(
    rows.results.map((row) => ({
      id: row.id,
      title: toPlainText(row.title),
      parent_id: row.parent_id,
      updated_at: row.updated_at
    }))
  )
})

interface SearchHitRow {
  id: string
  title: string
  contentText: string
  updatedAt: string
}

/**
 * 全文搜索：复用 FTS5 索引、同一支查询构造与 bm25 排序（`routes/search.ts` 的口径），
 * 上限固定 20 条。命中片段是纯文本（不含 HTML），由调用方自行高亮。
 */
readRoutes.get("/search", async (c) => {
  const query = (c.req.query("q") ?? "").trim()
  const match = toMatchQuery(query)
  if (!match) return c.json([])

  const prefix = getTablePrefix(c.env)
  const fts = pagesFtsTable(prefix)
  const siteAdmin = c.get("role") === "admin"
  const membershipFilter = siteAdmin
    ? ""
    : `AND p.space_id IN (
         SELECT space_id FROM ${spaceMembersTable(prefix)} WHERE user_id = ?
       )`
  const stmt = c.env.DB.prepare(
    `SELECT f.page_id AS id,
            p.title AS title,
            p.content_text AS contentText,
            p.updated_at AS updatedAt
       FROM ${fts} f
       JOIN ${pagesTable(prefix)} p ON p.id = f.page_id AND p.deleted_at IS NULL
      WHERE ${fts} MATCH ?
        ${membershipFilter}
      ORDER BY bm25(${fts}, 0.0, 10.0, 1.0)
      LIMIT ?`
  )
  const hits = siteAdmin
    ? await stmt.bind(match, READ_SEARCH_LIMIT).all<SearchHitRow>()
    : await stmt
        .bind(match, c.get("userId"), READ_SEARCH_LIMIT)
        .all<SearchHitRow>()

  return c.json(
    hits.results.map((row) => ({
      id: row.id,
      title: toPlainText(row.title),
      snippet: makeSnippet(row.contentText || row.title, query),
      updated_at: row.updatedAt
    }))
  )
})

/**
 * 单页正文。
 *
 * 默认给 `markdown`（即 `content_md`；回填完成前按需现生成，不会报错也不会是空文档）；
 * `?format=json` 时改给 `content_json`（真源原文），两者不并存。
 *
 * 不存在、已软删、或所在空间不是令牌用户的可见空间，一律 404——不泄露页面存在性，
 * 与站内页面直链口径一致。
 */
readRoutes.get("/pages/:id", async (c) => {
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const row = await getPageRow(db, prefix, c.req.param("id"))
  if (!row || row.deleted_at) return c.json({ error: "Page not found" }, 404)

  const role = await resolveSpaceRole(
    db,
    prefix,
    row.space_id,
    c.get("userId"),
    c.get("role") === "admin"
  )
  if (!role) return c.json({ error: "Page not found" }, 404)

  const base = {
    id: row.id,
    title: toPlainText(row.title),
    parent_id: row.parent_id,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
  if (c.req.query("format") === "json") {
    return c.json({ ...base, content_json: row.content_json })
  }
  return c.json({ ...base, markdown: resolvePageMarkdown(row) })
})
