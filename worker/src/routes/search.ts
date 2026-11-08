/**
 * 全文搜索：FTS5 MATCH 取命中，JOIN 页面与空间，一次带回标题/片段/所属空间。
 *
 * 搜索范围是当前用户可见的全部空间（站点管理员为全部空间）：非成员空间的页面
 * 在 SQL 层就被过滤，标题与片段都不会出现在响应里。软删页面天然不在索引里，
 * 这里再以 `deleted_at IS NULL` 兜底。
 */
import { Hono } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import {
  pagesFtsTable,
  pagesTable,
  spaceMembersTable,
  spacesTable
} from "../lib/tables"
import { makeSnippet, toMatchQuery } from "../lib/fts"
import { toPlainText } from "../lib/sanitize"
import type { HonoEnv } from "../types"

export const searchRoutes = new Hono<HonoEnv>()

interface SearchHitRow {
  pageId: string
  title: string
  contentText: string
  updatedAt: string
  spaceId: string
  spaceName: string
}

searchRoutes.get("/", async (c) => {
  const query = (c.req.query("q") ?? "").trim()
  const requested = Number.parseInt(c.req.query("limit") ?? "20", 10)
  const limit = Math.min(
    Math.max(Number.isFinite(requested) ? requested : 20, 1),
    50
  )

  const match = toMatchQuery(query)
  if (!match) return c.json({ query, results: [] })

  const prefix = getTablePrefix(c.env)
  const fts = pagesFtsTable(prefix)
  const pages = pagesTable(prefix)
  const spaces = spacesTable(prefix)
  const members = spaceMembersTable(prefix)
  const siteAdmin = c.get("role") === "admin"

  const membershipFilter = siteAdmin
    ? ""
    : `AND p.space_id IN (
         SELECT space_id FROM ${members} WHERE user_id = ?
       )`
  const stmt = c.env.DB.prepare(
    `SELECT f.page_id AS pageId,
            p.title AS title,
            p.content_text AS contentText,
            p.updated_at AS updatedAt,
            p.space_id AS spaceId,
            s.name AS spaceName
       FROM ${fts} f
       JOIN ${pages} p ON p.id = f.page_id AND p.deleted_at IS NULL
       JOIN ${spaces} s ON s.id = p.space_id
      WHERE ${fts} MATCH ?
        ${membershipFilter}
      ORDER BY bm25(${fts}, 0.0, 10.0, 1.0)
      LIMIT ?`
  )
  const hits = siteAdmin
    ? await stmt.bind(match, limit).all<SearchHitRow>()
    : await stmt.bind(match, c.get("userId"), limit).all<SearchHitRow>()

  const results = hits.results.map((row) => ({
    pageId: row.pageId,
    title: toPlainText(row.title),
    snippet: makeSnippet(row.contentText || row.title, query),
    updatedAt: row.updatedAt,
    spaceId: row.spaceId,
    spaceName: toPlainText(row.spaceName)
  }))

  return c.json({ query, results })
})
