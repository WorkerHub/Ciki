import { pagesFtsTable, pagesTable, revisionsTable } from "../../lib/tables"

export interface PageRow {
  id: string
  space_id: string
  parent_id: string | null
  title: string
  sort_order: number
  content_json: string
  content_html: string
  content_text: string
  /**
   * 派生出来的 Markdown（规格一期）：列由迁移 `schema_v4` 补上，所以**升级前的库
   * 没有这一列**——`SELECT *` 读出来是 `undefined`，写它的语句先经
   * {@link hasContentMdColumn} 探一次。空串与 NULL 同义：尚未回填/尚未生成。
   */
  content_md?: string | null
  created_by: string
  updated_by: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

/**
 * `pages.content_md` 探列结果的 isolate 级缓存：**只缓存「为真」**，口径同
 * `db/queries/revisions.ts` 的 `hasGzipColumn`。
 *
 * 迁移只会加这一列、绝不删，所以一旦探到就永远为真；缓存「假」会在管理员点完升级
 * 之后继续按旧形态写，那样新存的页面就没有 MD。
 */
let contentMdColumnReady = false

/** 仅供测试模拟「升级前的库」：清掉缓存，让下一次探列真的去问数据库。 */
export function resetContentMdColumnCache(): void {
  contentMdColumnReady = false
}

/** 直接问数据库（不读缓存）。迁移 `schema_v4` 用它，它本身就要负责「列到底在不在」。 */
export async function probeContentMdColumn(
  db: D1Database,
  prefix: string
): Promise<boolean> {
  const columns = await db
    .prepare(`PRAGMA table_info(${pagesTable(prefix)})`)
    .all<{ name: string }>()
  const ready = columns.results.some((column) => column.name === "content_md")
  if (ready) contentMdColumnReady = true
  return ready
}

/**
 * `pages.content_md` 列是否就绪（迁移 `schema_v4` 已跑）。
 *
 * 部署后、管理员点「检查并升级数据库」之前这列还不存在：写路径据此继续按旧形态写，
 * 保存不会因为缺列而失败；读路径遇到无 MD 的行走按需现生成。
 */
export async function hasContentMdColumn(
  db: D1Database,
  prefix: string
): Promise<boolean> {
  if (contentMdColumnReady) return true
  return probeContentMdColumn(db, prefix)
}

/** 列表/树只用元数据，避免把每页最多 2MB 的正文读进 D1 结果集。 */
export type PageSummaryRow = Pick<
  PageRow,
  "id" | "parent_id" | "title" | "sort_order" | "updated_at"
>
export type PageChildRow = Pick<
  PageRow,
  "id" | "parent_id" | "sort_order" | "created_at"
>
export type TrashRow = Pick<
  PageRow,
  "id" | "parent_id" | "title" | "deleted_at" | "updated_at"
>
/** 恢复时重建 FTS 索引只需要这几个字段。 */
export type RestoreRow = Pick<PageRow, "id" | "title" | "content_text">

/** 递归子树 CTE（含根，不按删除状态过滤）。 */
function subtreeCte(prefix: string): string {
  return `WITH RECURSIVE sub(id) AS (
    SELECT id FROM ${pagesTable(prefix)} WHERE id = ?
    UNION ALL
    SELECT p.id FROM ${pagesTable(prefix)} p JOIN sub ON p.parent_id = sub.id
  )`
}

export async function listPageRows(
  db: D1Database,
  prefix: string,
  spaceId: string
): Promise<PageSummaryRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, parent_id, title, sort_order, updated_at
         FROM ${pagesTable(prefix)}
        WHERE deleted_at IS NULL AND space_id = ?
        ORDER BY sort_order, created_at`
    )
    .bind(spaceId)
    .all<PageSummaryRow>()
  return rows.results
}

export async function getPageRow(
  db: D1Database,
  prefix: string,
  id: string
): Promise<PageRow | null> {
  return db
    .prepare(`SELECT * FROM ${pagesTable(prefix)} WHERE id = ?`)
    .bind(id)
    .first<PageRow>()
}

export async function listChildren(
  db: D1Database,
  prefix: string,
  spaceId: string,
  parentId: string | null
): Promise<PageChildRow[]> {
  const table = pagesTable(prefix)
  const columns = "id, parent_id, sort_order, created_at"
  const sql =
    parentId === null
      ? `SELECT ${columns} FROM ${table} WHERE space_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY sort_order, created_at`
      : `SELECT ${columns} FROM ${table} WHERE space_id = ? AND parent_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at`
  const stmt = db.prepare(sql)
  const rows =
    parentId === null
      ? await stmt.bind(spaceId).all<PageChildRow>()
      : await stmt.bind(spaceId, parentId).all<PageChildRow>()
  return rows.results
}

export async function maxSortOrder(
  db: D1Database,
  prefix: string,
  spaceId: string,
  parentId: string | null
): Promise<number> {
  const table = pagesTable(prefix)
  const sql =
    parentId === null
      ? `SELECT MAX(sort_order) AS max FROM ${table} WHERE space_id = ? AND parent_id IS NULL`
      : `SELECT MAX(sort_order) AS max FROM ${table} WHERE space_id = ? AND parent_id = ?`
  const stmt = db.prepare(sql)
  const row =
    parentId === null
      ? await stmt.bind(spaceId).first<{ max: number | null }>()
      : await stmt.bind(spaceId, parentId).first<{ max: number | null }>()
  return (row?.max ?? -1) + 1
}

/**
 * 同父级下的同名未删页面（导入 conflict="update" 的冲突判定）：
 * 同名多页时取排序最前的一条。
 */
export async function findSiblingByTitle(
  db: D1Database,
  prefix: string,
  spaceId: string,
  parentId: string | null,
  title: string
): Promise<PageRow | null> {
  const table = pagesTable(prefix)
  const sql =
    parentId === null
      ? `SELECT * FROM ${table} WHERE space_id = ? AND parent_id IS NULL AND title = ? AND deleted_at IS NULL ORDER BY sort_order, created_at LIMIT 1`
      : `SELECT * FROM ${table} WHERE space_id = ? AND parent_id = ? AND title = ? AND deleted_at IS NULL ORDER BY sort_order, created_at LIMIT 1`
  const stmt = db.prepare(sql)
  const row =
    parentId === null
      ? await stmt.bind(spaceId, title).first<PageRow>()
      : await stmt.bind(spaceId, parentId, title).first<PageRow>()
  return row ?? null
}

/**
 * 新建页面行。
 *
 * `includeMd` 由调用方经 {@link hasContentMdColumn} 算好（升级前没有该列）：<br>
 * true 时 SQL 带上 `content_md`，false 时按旧形态写——旧形态不写空串，让回填仍能
 * 认出「这行还没有 MD」（`content_md IS NULL`）。
 */
export function insertPage(
  db: D1Database,
  prefix: string,
  page: PageRow,
  includeMd: boolean
): D1PreparedStatement {
  const columns = includeMd
    ? "id, space_id, parent_id, title, sort_order, content_json, content_html, content_text, content_md, created_by, updated_by, created_at, updated_at, deleted_at"
    : "id, space_id, parent_id, title, sort_order, content_json, content_html, content_text, created_by, updated_by, created_at, updated_at, deleted_at"
  const values = includeMd
    ? "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL"
    : "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL"
  const bound = [
    page.id,
    page.space_id,
    page.parent_id,
    page.title,
    page.sort_order,
    page.content_json,
    page.content_html,
    page.content_text,
    ...(includeMd ? [page.content_md ?? ""] : []),
    page.created_by,
    page.updated_by,
    page.created_at,
    page.updated_at
  ]
  return db
    .prepare(
      `INSERT INTO ${pagesTable(prefix)} (${columns}) VALUES (${values})`
    )
    .bind(...bound)
}

export function updatePageContent(
  db: D1Database,
  prefix: string,
  page: {
    id: string
    title: string
    content_json: string
    content_html: string
    content_text: string
    content_md: string
    updated_by: string
    updated_at: string
  },
  includeMd: boolean
): D1PreparedStatement {
  if (!includeMd) {
    return db
      .prepare(
        `UPDATE ${pagesTable(prefix)}
            SET title = ?, content_json = ?, content_html = ?, content_text = ?,
                updated_by = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`
      )
      .bind(
        page.title,
        page.content_json,
        page.content_html,
        page.content_text,
        page.updated_by,
        page.updated_at,
        page.id
      )
  }
  return db
    .prepare(
      `UPDATE ${pagesTable(prefix)}
          SET title = ?, content_json = ?, content_html = ?, content_text = ?,
              content_md = ?, updated_by = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(
      page.title,
      page.content_json,
      page.content_html,
      page.content_text,
      page.content_md,
      page.updated_by,
      page.updated_at,
      page.id
    )
}

export function updatePagePlacement(
  db: D1Database,
  prefix: string,
  id: string,
  spaceId: string,
  parentId: string | null,
  sortOrder: number,
  updatedAt: string
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE ${pagesTable(prefix)} SET space_id = ?, parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ?`
    )
    .bind(spaceId, parentId, sortOrder, updatedAt, id)
}

/**
 * 跨空间移动：整棵后代子树的 space_id 一起改，保持「父子关系只在同空间内」
 * 的不变量。子树的 parent_id 不变，只改归属空间。
 */
export function updateSubtreeSpace(
  db: D1Database,
  prefix: string,
  rootId: string,
  spaceId: string
): D1PreparedStatement {
  return db
    .prepare(
      `${subtreeCte(prefix)} UPDATE ${pagesTable(prefix)} SET space_id = ? WHERE id IN (SELECT id FROM sub)`
    )
    .bind(rootId, spaceId)
}

export function updatePageSortOrder(
  db: D1Database,
  prefix: string,
  id: string,
  sortOrder: number
): D1PreparedStatement {
  return db
    .prepare(`UPDATE ${pagesTable(prefix)} SET sort_order = ? WHERE id = ?`)
    .bind(sortOrder, id)
}

/** 子树全部 id（含根，含已删除节点）。 */
export async function listSubtreeIds(
  db: D1Database,
  prefix: string,
  rootId: string
): Promise<string[]> {
  const rows = await db
    .prepare(`${subtreeCte(prefix)} SELECT id FROM sub`)
    .bind(rootId)
    .all<{ id: string }>()
  return rows.results.map((row) => row.id)
}

/** 子树里指定删除批次的页面（恢复时用）。 */
export async function listSubtreeDeletedRows(
  db: D1Database,
  prefix: string,
  rootId: string,
  deletedAt: string
): Promise<RestoreRow[]> {
  const rows = await db
    .prepare(
      `${subtreeCte(prefix)} SELECT id, title, content_text FROM ${pagesTable(prefix)} WHERE id IN (SELECT id FROM sub) AND deleted_at = ? ORDER BY sort_order`
    )
    .bind(rootId, deletedAt)
    .all<RestoreRow>()
  return rows.results
}

/** 软删整棵子树：一次 UPDATE 统一写同一个 deleted_at，再清 FTS。 */
export function softDeleteSubtree(
  db: D1Database,
  prefix: string,
  rootId: string,
  deletedAt: string
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `${subtreeCte(prefix)} UPDATE ${pagesTable(prefix)} SET deleted_at = ?, updated_at = ? WHERE id IN (SELECT id FROM sub) AND deleted_at IS NULL`
      )
      .bind(rootId, deletedAt, deletedAt),
    db
      .prepare(
        `${subtreeCte(prefix)} DELETE FROM ${pagesFtsTable(prefix)} WHERE page_id IN (SELECT id FROM sub)`
      )
      .bind(rootId)
  ]
}

/** 恢复同一批删除的子树。 */
export function restoreSubtree(
  db: D1Database,
  prefix: string,
  rootId: string,
  deletedAt: string,
  now: string
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `${subtreeCte(prefix)} UPDATE ${pagesTable(prefix)} SET deleted_at = NULL, updated_at = ? WHERE id IN (SELECT id FROM sub) AND deleted_at = ?`
      )
      .bind(rootId, now, deletedAt)
  ]
}

/** 彻底删除：页面 + 全部 revision + FTS 行。 */
export function permanentDeleteSubtree(
  db: D1Database,
  prefix: string,
  rootId: string
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `${subtreeCte(prefix)} DELETE FROM ${revisionsTable(prefix)} WHERE page_id IN (SELECT id FROM sub)`
      )
      .bind(rootId),
    db
      .prepare(
        `${subtreeCte(prefix)} DELETE FROM ${pagesFtsTable(prefix)} WHERE page_id IN (SELECT id FROM sub)`
      )
      .bind(rootId),
    db
      .prepare(
        `${subtreeCte(prefix)} DELETE FROM ${pagesTable(prefix)} WHERE id IN (SELECT id FROM sub)`
      )
      .bind(rootId)
  ]
}

/** 回收站根：父页未删、父页为空，或父页属于更早的另一批删除。 */
export async function listTrashRoots(
  db: D1Database,
  prefix: string,
  spaceId: string
): Promise<TrashRow[]> {
  const table = pagesTable(prefix)
  const rows = await db
    .prepare(
      `SELECT p.id, p.parent_id, p.title, p.deleted_at, p.updated_at FROM ${table} p
        WHERE p.deleted_at IS NOT NULL AND p.space_id = ?
          AND (
            p.parent_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM ${table} parent
               WHERE parent.id = p.parent_id
                 AND parent.deleted_at IS NOT NULL
                 AND parent.deleted_at = p.deleted_at
            )
          )
        ORDER BY p.deleted_at DESC, p.sort_order`
    )
    .bind(spaceId)
    .all<TrashRow>()
  return rows.results
}

/**
 * 迁移用：还有哪些页面缺 `content_md`（`schema_v4` 回填待办）。
 *
 * 与 `listLegacyRevisionsBatch` 同一个取法：不用 id 游标往前扫，每轮只问「当前仍缺
 * MD 的最前面 N 行」。回填写过的行由 `content_md IS NULL` 自然排除，所以并发写入的
 * 新页（id 可能很小）也不会被跳过；`content_json` 为空串的行同样要处理——它们的 MD
 * 就是空串，写进去才能离开待办集，否则每轮都会重扫同一批。
 *
 * 软删页面一并回填：回收站里的页面随时可能被恢复，先把 MD 备好，恢复后立刻可读。
 */
export async function listPagesMissingMarkdownBatch(
  db: D1Database,
  prefix: string,
  limit: number
): Promise<Array<Pick<PageRow, "id" | "content_json" | "content_text">>> {
  const rows = await db
    .prepare(
      `SELECT id, content_json, content_text
         FROM ${pagesTable(prefix)}
        WHERE content_md IS NULL
        ORDER BY id
        LIMIT ?`
    )
    .bind(limit)
    .all<Pick<PageRow, "id" | "content_json" | "content_text">>()
  return rows.results
}

/**
 * 迁移用：给一行补 `content_md`。
 *
 * `AND content_md IS NULL` 保证重复执行不覆盖已回填的值（可中断续跑的前提）；不碰
 * `updated_at` / `updated_by` / 正文列——回填是纯派生，不是一次编辑。
 */
export function backfillContentMdStatement(
  db: D1Database,
  prefix: string,
  pageId: string,
  markdown: string
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE ${pagesTable(prefix)} SET content_md = ?
        WHERE id = ? AND content_md IS NULL`
    )
    .bind(markdown, pageId)
}
