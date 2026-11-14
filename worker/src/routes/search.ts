/**
 * 全文搜索：FTS5 MATCH 取命中，JOIN 页面与空间，一次带回标题/片段/所属空间。
 *
 * 搜索范围是当前用户可见的全部空间（站点管理员为全部空间）：非成员空间的页面
 * 在 SQL 层就被过滤，标题与片段都不会出现在响应里。软删页面天然不在索引里，
 * 这里再以 `deleted_at IS NULL` 兜底。
 *
 * 纯数字查询额外按页面编号精确看一眼（见 {@link parsePageIdQuery}）：命中的那篇
 * 置顶，与 FTS 结果按 pageId 去重。编号不保证出现在标题或正文里，所以这一步走
 * 主键而不是索引；可见性与软删口径与 FTS 路径完全一致。
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
  pageId: number
  title: string
  contentText: string
  updatedAt: string
  spaceId: number
  spaceName: string
}

/**
 * 「纯数字 = 页面编号」的判定：十进制正整数且落在安全整数范围内。
 * 与前端 `lib/routes.ts` 的 `parseIdParam` 同口径（不认符号、小数点、空串），
 * 超出安全整数（或 `0`）一律不做精确查，仍按原 FTS 路径走。
 */
function parsePageIdQuery(query: string): number | null {
  if (!/^\d+$/.test(query)) return null
  const id = Number(query)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** 结果行的对外形态：标题与空间名剥标签，片段是纯文本。 */
function toSearchResult(row: SearchHitRow, query: string) {
  return {
    pageId: row.pageId,
    title: toPlainText(row.title),
    snippet: makeSnippet(row.contentText || row.title, query),
    updatedAt: row.updatedAt,
    spaceId: row.spaceId,
    spaceName: toPlainText(row.spaceName)
  }
}

searchRoutes.get("/", async (c) => {
  const query = (c.req.query("q") ?? "").trim()
  const requested = Number.parseInt(c.req.query("limit") ?? "20", 10)
  const limit = Math.min(
    Math.max(Number.isFinite(requested) ? requested : 20, 1),
    50
  )

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

  // 编号精确查：命中就置顶，未命中不影响任何非数字查询
  const exactId = parsePageIdQuery(query)
  let exactResult: ReturnType<typeof toSearchResult> | null = null
  if (exactId !== null) {
    const exactStmt = c.env.DB.prepare(
      `SELECT CAST(p.id AS INTEGER) AS pageId,
              p.title AS title,
              p.content_text AS contentText,
              p.updated_at AS updatedAt,
              p.space_id AS spaceId,
              s.name AS spaceName
         FROM ${pages} p
         JOIN ${spaces} s ON s.id = p.space_id
        WHERE p.id = ?
          AND p.deleted_at IS NULL
          ${membershipFilter}`
    )
    const exactRow = siteAdmin
      ? await exactStmt.bind(exactId).first<SearchHitRow>()
      : await exactStmt.bind(exactId, c.get("userId")).first<SearchHitRow>()
    if (exactRow) exactResult = toSearchResult(exactRow, query)
  }

  const match = toMatchQuery(query)
  if (!match) {
    return c.json({ query, results: exactResult ? [exactResult] : [] })
  }

  const stmt = c.env.DB.prepare(
    `SELECT CAST(f.page_id AS INTEGER) AS pageId,
            p.title AS title,
            p.content_text AS contentText,
            p.updated_at AS updatedAt,
            p.space_id AS spaceId,
            s.name AS spaceName
       FROM ${fts} f
       JOIN ${pages} p ON p.id = CAST(f.page_id AS INTEGER)
        AND p.deleted_at IS NULL
       JOIN ${spaces} s ON s.id = p.space_id
      WHERE ${fts} MATCH ?
        ${membershipFilter}
      ORDER BY bm25(${fts}, 0.0, 10.0, 1.0)
      LIMIT ?`
  )
  const hits = siteAdmin
    ? await stmt.bind(match, limit).all<SearchHitRow>()
    : await stmt.bind(match, c.get("userId"), limit).all<SearchHitRow>()

  const merged = hits.results
    .map((row) => toSearchResult(row, query))
    .filter((result) => result.pageId !== exactResult?.pageId)
  const results = (exactResult ? [exactResult, ...merged] : merged).slice(
    0,
    limit
  )

  return c.json({ query, results })
})
