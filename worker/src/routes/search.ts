/**
 * 全文搜索：FTS5 MATCH 取 page_id（标题权重更高），回表用原始 title/content_text
 * 生成纯文本片段。软删页面天然不在索引里，恢复时同批重建。
 */
import { Hono } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import { pagesFtsTable, pagesTable } from "../lib/tables"
import { makeSnippet, toMatchQuery } from "../lib/fts"
import { toPlainText } from "../lib/sanitize"
import type { HonoEnv } from "../types"

export const searchRoutes = new Hono<HonoEnv>()

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

  const hits = await c.env.DB.prepare(
    `SELECT f.page_id AS pageId
       FROM ${fts} f
      WHERE ${fts} MATCH ?
      ORDER BY bm25(${fts}, 0.0, 10.0, 1.0)
      LIMIT ?`
  )
    .bind(match, limit)
    .all<{ pageId: string }>()

  const results: Array<{
    pageId: string
    title: string
    snippet: string
    updatedAt: string
  }> = []

  for (const hit of hits.results) {
    const row = await c.env.DB.prepare(
      `SELECT id, title, content_text AS contentText, updated_at AS updatedAt
         FROM ${pages} WHERE id = ? AND deleted_at IS NULL`
    )
      .bind(hit.pageId)
      .first<{
        id: string
        title: string
        contentText: string
        updatedAt: string
      }>()
    if (!row) continue
    results.push({
      pageId: row.id,
      title: toPlainText(row.title),
      snippet: makeSnippet(row.contentText || row.title, query),
      updatedAt: row.updatedAt
    })
  }

  return c.json({ query, results })
})
