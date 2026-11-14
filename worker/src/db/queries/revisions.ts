/**
 * `page_revisions` 的全部 SQL（新基线：整数主键 + 页内 `version_no`）。
 *
 * 正文不在本表：每条版本只有 `content_hash`，指向 `ciki-content` 里的
 * `content/<sha256>` 对象（与页面当前正文共用同一套对象，同内容天然复用）。
 * 查看版本时按需从 R2 取 JSON 再渲染 HTML，不再有 gzip 列、也不再有 HTML/纯文本列。
 *
 * 排序口径是**全站唯一**的「新 → 旧」定义：`version_no DESC`（页内单调递增，写入时
 * 由 SQL 取 `MAX(version_no)+1`）。列表、修剪、删版本、「最新一条不许删」都用它，
 * 改一处必须一起改。
 */
import { revisionsTable } from "../../lib/tables"

export interface RevisionRow {
  id: number
  page_id: number
  version_no: number
  title: string
  content_hash: string
  editor_id: number
  created_at: string
}

/** 元数据行（列表用，不碰正文）。 */
export type RevisionSummaryRow = Pick<
  RevisionRow,
  "id" | "version_no" | "title" | "editor_id" | "created_at"
>

/**
 * 追加一条版本（新建页面的首条版本也走这里：此前没有版本行，算出来就是 1）。
 *
 * `page_id` 一律由调用方显式传入：自增 id 只认页面 INSERT 的返回值，不从语句在
 * batch 里的位置推断（`last_insert_rowid()` 会被上一条 INSERT 覆盖）。
 *
 * `version_no` 由同一条语句里的子查询发号（`MAX(version_no)+1`）：单语句原子，
 * 唯一索引 `(page_id, version_no)` 再兜并发（撞了整批事务回滚，不会写出半条）。
 */
export function insertRevision(
  db: D1Database,
  prefix: string,
  revision: {
    page_id: number
    title: string
    content_hash: string
    editor_id: number
    created_at: string
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ${revisionsTable(prefix)}
        (page_id, version_no, title, content_hash, editor_id, created_at)
       VALUES (?, (SELECT COALESCE(MAX(version_no), 0) + 1
                     FROM ${revisionsTable(prefix)} WHERE page_id = ?),
               ?, ?, ?, ?)`
    )
    .bind(
      revision.page_id,
      revision.page_id,
      revision.title,
      revision.content_hash,
      revision.editor_id,
      revision.created_at
    )
}

/** 版本列表（只看元数据；正文按需从 R2 取）。 */
export async function listRevisions(
  db: D1Database,
  prefix: string,
  pageId: number
): Promise<RevisionSummaryRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, version_no, title, editor_id, created_at
         FROM ${revisionsTable(prefix)}
        WHERE page_id = ?
        ORDER BY version_no DESC`
    )
    .bind(pageId)
    .all<RevisionSummaryRow>()
  return rows.results
}

/** 按「第 N 版」取一条版本（含 `content_hash` 指针）。 */
export async function getRevision(
  db: D1Database,
  prefix: string,
  pageId: number,
  versionNo: number
): Promise<RevisionRow | null> {
  return db
    .prepare(
      `SELECT * FROM ${revisionsTable(prefix)} WHERE page_id = ? AND version_no = ?`
    )
    .bind(pageId, versionNo)
    .first<RevisionRow>()
}

/** 该页最大的 `version_no`（没有版本时 null）＝最新一条。 */
export async function latestVersionNo(
  db: D1Database,
  prefix: string,
  pageId: number
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT MAX(version_no) AS max FROM ${revisionsTable(prefix)} WHERE page_id = ?`
    )
    .bind(pageId)
    .first<{ max: number | null }>()
  return row?.max ?? null
}

/**
 * 删一条版本行（限该页），返回删除条数。
 *
 * 「最新一条不许删」写进了 `WHERE`：即使删之前查到的「最新」在中间被并发保存顶掉，
 * 数据库这一句也只会删「此刻确实不是最新」的那条，不存在先读后写的时间窗。返回 0
 * 有两种可能——行不存在/不属于该页，或者它就是最新一条，由调用方再查一次区分。
 */
export async function deleteRevision(
  db: D1Database,
  prefix: string,
  pageId: number,
  versionNo: number
): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM ${revisionsTable(prefix)}
        WHERE page_id = ?1 AND version_no = ?2
          AND version_no <> (
            SELECT MAX(version_no) FROM ${revisionsTable(prefix)}
             WHERE page_id = ?1
          )`
    )
    .bind(pageId, versionNo)
    .run()
  return result.meta.changes
}

/**
 * 单页修剪语句：保留该页最新 `keep` 条，其余删除。
 *
 * 放进写入路径的 `db.batch()` 里执行，与「插入新版本」是同一个事务；也供按页批量
 * 「只留最新一条」使用。`version_no` 单调递增，所以「刚插入的那条一定在保留集里」
 * 不需要额外排除。
 */
export function trimPageRevisionStatement(
  db: D1Database,
  prefix: string,
  pageId: number,
  keep: number
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM ${revisionsTable(prefix)}
        WHERE page_id = ?1
          AND version_no IN (
            SELECT version_no FROM ${revisionsTable(prefix)}
             WHERE page_id = ?1
             ORDER BY version_no DESC
             LIMIT -1 OFFSET ?2
          )`
    )
    .bind(pageId, keep)
}

/**
 * 全站修剪语句：每条页面留下最新 `keep` 条，其余一次删净。
 *
 * 单条 set-based DELETE（一次往返、原子），所以返回的 `meta.changes` 就是「删了多少条」。
 */
export function pruneRevisionsStatement(
  db: D1Database,
  prefix: string,
  keep: number
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM ${revisionsTable(prefix)}
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                     PARTITION BY page_id
                     ORDER BY version_no DESC
                   ) AS rn
              FROM ${revisionsTable(prefix)}
          )
          WHERE rn <= ?1
        )`
    )
    .bind(keep)
}

/** 版本总条数（全站修剪预告用）。 */
export async function countRevisions(
  db: D1Database,
  prefix: string
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM ${revisionsTable(prefix)}`)
    .first<{ count: number }>()
  return row?.count ?? 0
}

/**
 * 按 `keep` 修剪时会被删掉的条数（全站修剪的二次确认文案用）。
 *
 * 口径与 {@link pruneRevisionsStatement} 完全对应：每页 `COUNT(*) - keep` 之和，
 * 只算超过 `keep` 的页面。
 */
export async function countPrunableRevisions(
  db: D1Database,
  prefix: string,
  keep: number
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(count - ?1), 0) AS total FROM (
         SELECT COUNT(*) AS count
           FROM ${revisionsTable(prefix)}
          GROUP BY page_id
         HAVING COUNT(*) > ?1
       )`
    )
    .bind(keep)
    .first<{ total: number }>()
  return row?.total ?? 0
}
