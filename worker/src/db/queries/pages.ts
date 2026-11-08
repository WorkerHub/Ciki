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
  created_by: string
  updated_by: string
  created_at: string
  updated_at: string
  deleted_at: string | null
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

export function insertPage(
  db: D1Database,
  prefix: string,
  page: PageRow
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ${pagesTable(prefix)}
        (id, space_id, parent_id, title, sort_order, content_json, content_html, content_text, created_by, updated_by, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .bind(
      page.id,
      page.space_id,
      page.parent_id,
      page.title,
      page.sort_order,
      page.content_json,
      page.content_html,
      page.content_text,
      page.created_by,
      page.updated_by,
      page.created_at,
      page.updated_at
    )
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
    updated_by: string
    updated_at: string
  }
): D1PreparedStatement {
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
