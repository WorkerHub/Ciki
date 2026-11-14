/**
 * 只读接口（二期）：供 Muse 的自定义连接器接入，**只有读，没有任何写接口**。
 *
 * 鉴权只认 `Authorization: Bearer`，可以是**只读令牌**或**读写令牌**（二期 §3.1，两种令牌
 * 都计入 `read` 桶），见 middleware/read-token.ts。权限 = 令牌所属用户本人的读权限
 * **∩ 令牌空间范围**（§2.5）：站点管理员可见全部空间、其余人只见自己是成员的空间，
 * 与站内页面树/搜索同一口径（SQL 层过滤，非成员空间连标题都不会出现在响应里）；范围是
 * 叠在成员过滤之上的一层，只收窄不放大，且对站点管理员同样生效。
 *
 * 四个接口（`spaces` / `tree` / `search` / `pages/:id`）的字段是**冻结契约**，按规格逐字
 * 使用 snake_case（`parent_id` / `space_id` / `sort_order` / `updated_at` / `created_at` /
 * `content_json`）——这是本仓「响应字段一律 camelCase」通则的唯一例外，连接器按此对接，
 * 别在实现里顺手改成 camelCase。id 已随 ID 重构改为整数。
 *
 * 正文分工：默认 `markdown` 与树/搜索都只读 D1；`?format=json` 按 `content_hash`
 * 从内容桶取（连接器要原文时才走这一步）。
 *
 * 软删页面（`deleted_at` 非空）在三处一律排除：树、搜索、单页。
 * 范围外的页面与空间一律按不存在处理（四接口一致）：tree / search 不返回该空间的行，
 * `pages/:id` 回 404，`/spaces` 不列出，均不泄露存在性。
 */
import { Hono } from "hono"
import type { Context } from "hono"
import { getPageRow } from "../db/queries/pages"
import { readContent } from "../core/content-store"
import { resolveSpaceRole } from "../core/space-access"
import { listTokenVisibleSpaces, tokenScopeAllows } from "../core/token-scope"
import { makeSnippet, toMatchQuery } from "../lib/fts"
import { parseId } from "../lib/http"
import { toPlainText } from "../lib/sanitize"
import { pagesFtsTable, pagesTable, spaceMembersTable } from "../lib/tables"
import { getTablePrefix } from "../lib/table-prefix"
import { readTokenMiddleware } from "../middleware/read-token"
import type { HonoEnv } from "../types"

export const readRoutes = new Hono<HonoEnv>()

// 整段只认令牌（只读令牌或读写令牌）：会话 Cookie 在这里无效（职责分离，见中间件注释）。
readRoutes.use("*", readTokenMiddleware)

/** 搜索上限（规格定版：20 条，不分页）。 */
export const READ_SEARCH_LIMIT = 20

/** 一段 WHERE 片段 + 它自己的绑定值（树的成员过滤与范围过滤各一段）。 */
interface SpaceFilter {
  sql: string
  binds: number[]
}

/**
 * 树 / 搜索共用的空间过滤（§2.5：「在现行权限过滤之外再叠一层范围过滤」）。
 *
 * 返回两段：①成员过滤（现行口径，站点管理员为空）；②令牌范围过滤
 * （`null` = 不限制，SQL 原样、零额外查询；数组 = `space_id IN (...)`）。
 * 两者用 `AND` 叠加，范围只收窄、不替代成员过滤。
 */
function spaceFilters(c: Context<HonoEnv>, prefix: string): SpaceFilter[] {
  const filters: SpaceFilter[] = []

  if (c.get("role") !== "admin") {
    filters.push({
      sql: `AND p.space_id IN (
         SELECT space_id FROM ${spaceMembersTable(prefix)} WHERE user_id = ?
       )`,
      binds: [c.get("userId")]
    })
  }

  const scope = c.get("tokenScope")
  if (scope !== null) {
    // 空集不会落库（getTokenScope 无行即回 null），防御性地当作「什么都看不见」。
    filters.push(
      scope.length === 0
        ? { sql: "AND 1 = 0", binds: [] }
        : {
            sql: `AND p.space_id IN (${scope.map(() => "?").join(", ")})`,
            binds: scope
          }
    )
  }

  return filters
}

/** 过滤段的绑定值摊平成一次 `bind` 要的数组（顺序与 SQL 里出现的顺序一致）。 */
function filterBinds(filters: SpaceFilter[]): number[] {
  return filters.flatMap((filter) => filter.binds)
}

/**
 * 令牌的**有效可见空间**（§1）：主人可见空间 ∩ 令牌范围，排序沿用站内空间列表的
 * `SPACE_ORDER`（默认空间在前 → 名称大小写不敏感 → 创建时间）。
 *
 * 每项只给 `id` / `name` / `slug` 三个键（精确键集合，接入方按此对接）；`slug` 用来拼
 * 站内地址 `/s/<slug>/…`。
 */
readRoutes.get("/spaces", async (c) => {
  const spaces = await listTokenVisibleSpaces(c.env.DB, getTablePrefix(c.env), {
    userId: c.get("userId"),
    isSiteAdmin: c.get("role") === "admin",
    scope: c.get("tokenScope")
  })
  return c.json({
    spaces: spaces.map((space) => ({
      id: space.id,
      name: space.name,
      slug: space.slug
    }))
  })
})

interface TreeRow {
  id: number
  title: string
  parent_id: number | null
  space_id: number
  sort_order: number
  updated_at: string
}

/**
 * 全部未删页面的扁平表（不分页、不建树）：`parent_id` 给调用方自己拼层级。
 *
 * 排序按「空间 → 同级顺序 → 创建时间」，与站内页面树一致，连接器拿到的顺序稳定。
 */
readRoutes.get("/tree", async (c) => {
  const prefix = getTablePrefix(c.env)
  const filters = spaceFilters(c, prefix)
  const where = filters.map((filter) => filter.sql).join("\n        ")
  const binds = filterBinds(filters)
  const stmt = c.env.DB.prepare(
    `SELECT p.id AS id, p.title AS title, p.parent_id AS parent_id,
            p.space_id AS space_id, p.sort_order AS sort_order,
            p.updated_at AS updated_at
       FROM ${pagesTable(prefix)} p
      WHERE p.deleted_at IS NULL
        ${where}
      ORDER BY p.space_id, p.sort_order, p.created_at`
  )
  const rows = await (binds.length > 0
    ? stmt.bind(...binds)
    : stmt
  ).all<TreeRow>()

  return c.json(
    rows.results.map((row) => ({
      id: row.id,
      title: toPlainText(row.title),
      parent_id: row.parent_id,
      space_id: row.space_id,
      sort_order: row.sort_order,
      updated_at: row.updated_at
    }))
  )
})

interface SearchHitRow {
  id: number
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
  const filters = spaceFilters(c, prefix)
  const where = filters.map((filter) => filter.sql).join("\n        ")
  const stmt = c.env.DB.prepare(
    `SELECT CAST(f.page_id AS INTEGER) AS id,
            p.title AS title,
            p.content_text AS contentText,
            p.updated_at AS updatedAt
       FROM ${fts} f
       JOIN ${pagesTable(prefix)} p ON p.id = CAST(f.page_id AS INTEGER)
        AND p.deleted_at IS NULL
      WHERE ${fts} MATCH ?
        ${where}
      ORDER BY bm25(${fts}, 0.0, 10.0, 1.0)
      LIMIT ?`
  )
  const rows = await stmt
    .bind(match, ...filterBinds(filters), READ_SEARCH_LIMIT)
    .all<SearchHitRow>()

  return c.json(
    rows.results.map((row) => ({
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
 * 默认给 `markdown`（即落库的 `content_md`，热路径只读 D1）；`?format=json` 时改给
 * `content_json`（按 `content_hash` 从内容桶取原文），两者不并存。
 *
 * 不存在、已软删、或所在空间不在令牌的有效可见范围（非成员或范围外），一律 404——
 * 不泄露页面存在性，与站内页面直链口径一致。先判范围（纯谓词、不查库），再算成员角色。
 */
readRoutes.get("/pages/:id", async (c) => {
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const id = parseId(c.req.param("id"))
  if (id === null) return c.json({ error: "Page not found" }, 404)
  const row = await getPageRow(db, prefix, id)
  if (!row || row.deleted_at) return c.json({ error: "Page not found" }, 404)
  if (!tokenScopeAllows(c.get("tokenScope"), row.space_id)) {
    return c.json({ error: "Page not found" }, 404)
  }

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
    space_id: row.space_id,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
  if (c.req.query("format") === "json") {
    try {
      return c.json({
        ...base,
        content_json: await readContent(c.env, row.content_hash)
      })
    } catch {
      return c.json(
        { error: "Page content unavailable", code: "CONTENT_MISSING" },
        500
      )
    }
  }
  return c.json({ ...base, markdown: row.content_md })
})
