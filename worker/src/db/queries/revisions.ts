/**
 * `page_revisions` 的全部 SQL。
 *
 * 两种行形态共存（升级前后都读得出来）：
 * - **新形态**：`content_gzip` 存 gzip 压缩的 `content_json`，三列文本（`content_json` /
 *   `content_html` / `content_text`）写空串——它们仍是 NOT NULL，无法在不重建表的前提下
 *   拿掉，故统一填空串表示「这份正文不在这里」。HTML/纯文本由 lib/revision-content.ts
 *   按需从 JSON 生成。
 * - **旧形态**：`content_gzip` 为空，正文在三列文本里（部署后到点升级之间新写的行、
 *   以及迁移尚未转换完的行）。
 *
 * 列 `content_gzip` 由迁移 `schema_v2` 补上，所以**升级前的库没有这一列**：凡是直接
 * 写它的语句，调用方必须先用 {@link hasGzipColumn} 探一次；读侧一律用 `SELECT *`，
 * 拿不到该列时字段就是 `undefined`（按旧形态处理）。
 */
import { revisionsTable } from "../../lib/tables"

export interface RevisionRow {
  id: string
  page_id: string
  title: string
  content_json: string
  content_html: string
  content_text: string
  /** gzip 字节；旧形态行为 null / undefined（列可能还不存在）。 */
  content_gzip?: ArrayBuffer | ArrayBufferView | null
  editor_id: string
  created_at: string
}

/** 元数据行（列表用，不碰正文）。 */
export type RevisionSummaryRow = Pick<
  RevisionRow,
  "id" | "title" | "editor_id" | "created_at"
>

/**
 * `page_revisions.content_gzip` 列是否就绪（迁移 `schema_v2` 已跑）。
 *
 * 部署后、管理员点「检查并升级数据库」之前这一列还不存在：写路径据此继续按旧三列
 * 写，保存不会因为缺列而失败；升级时迁移会把这些行一并转换。
 */
export async function hasGzipColumn(
  db: D1Database,
  prefix: string
): Promise<boolean> {
  const columns = await db
    .prepare(`PRAGMA table_info(${revisionsTable(prefix)})`)
    .all<{ name: string }>()
  return columns.results.some((column) => column.name === "content_gzip")
}

/**
 * 追加一条版本。
 *
 * `gzip` 非空 → 新形态：只落 `content_gzip`，三列文本写空串；`gzip` 为空 → 旧形态：
 * 照旧写三列文本（未升级的库与迁移转换前的行）。
 */
export function insertRevision(
  db: D1Database,
  prefix: string,
  revision: RevisionRow,
  gzip: Uint8Array | null
): D1PreparedStatement {
  const compressed = gzip !== null
  return db
    .prepare(
      `INSERT INTO ${revisionsTable(prefix)}
        (id, page_id, title, content_json, content_html, content_text, editor_id, created_at${compressed ? ", content_gzip" : ""})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?${compressed ? ", ?" : ""})`
    )
    .bind(
      revision.id,
      revision.page_id,
      revision.title,
      compressed ? "" : revision.content_json,
      compressed ? "" : revision.content_html,
      compressed ? "" : revision.content_text,
      revision.editor_id,
      revision.created_at,
      ...(compressed && gzip ? [gzip] : [])
    )
}

/**
 * 版本列表只需要元数据；正文只在查看单个版本时读。
 *
 * 排序口径是**全站唯一**的「新 → 旧」定义：`created_at DESC, rowid DESC`。
 * 修剪（{@link trimPageRevisionStatement}）与「最新一条不许删」（
 * {@link latestRevisionId}）都用它，改一处必须一起改。
 */
export async function listRevisions(
  db: D1Database,
  prefix: string,
  pageId: string
): Promise<RevisionSummaryRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, title, editor_id, created_at
         FROM ${revisionsTable(prefix)}
        WHERE page_id = ?
        ORDER BY created_at DESC, rowid DESC`
    )
    .bind(pageId)
    .all<RevisionSummaryRow>()
  return rows.results
}

/** `SELECT *`：新库带 `content_gzip`，升级前的库没有该列，读出来是 undefined。 */
export async function getRevision(
  db: D1Database,
  prefix: string,
  pageId: string,
  revisionId: string
): Promise<RevisionRow | null> {
  return db
    .prepare(
      `SELECT * FROM ${revisionsTable(prefix)} WHERE id = ? AND page_id = ?`
    )
    .bind(revisionId, pageId)
    .first<RevisionRow>()
}

/** 该页最新一条版本的 id（没有版本时 null）。「最新一条不许删」的判定依据。 */
export async function latestRevisionId(
  db: D1Database,
  prefix: string,
  pageId: string
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM ${revisionsTable(prefix)}
        WHERE page_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1`
    )
    .bind(pageId)
    .first<{ id: string }>()
  return row?.id ?? null
}

/** 删一条版本行（限该页），返回删除条数：0 表示它不存在或不属于该页。 */
export async function deleteRevision(
  db: D1Database,
  prefix: string,
  pageId: string,
  revisionId: string
): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM ${revisionsTable(prefix)} WHERE id = ? AND page_id = ?`
    )
    .bind(revisionId, pageId)
    .run()
  return result.meta.changes
}

/**
 * 单页修剪语句：保留该页最新 `keep` 条，其余删除。
 *
 * 放进写入路径的 `db.batch()` 里执行，与「插入新版本」是同一个事务；也供按页批量
 * 「只留最新一条」使用。`keep` 由调用方保证 ≥ 1，所以刚写入的最新一条（`rowid` 最大、
 * `created_at` 最新）一定落在保留集合里。
 *
 * `LIMIT -1 OFFSET keep` 的次序与 {@link listRevisions} 完全一致；子查询在 DELETE 执行
 * 前物化，删的是「当时排在 keep 之后的 id」，不会边删边漂。
 */
export function trimPageRevisionStatement(
  db: D1Database,
  prefix: string,
  pageId: string,
  keep: number
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM ${revisionsTable(prefix)}
        WHERE page_id = ?1
          AND id IN (
            SELECT id FROM ${revisionsTable(prefix)}
             WHERE page_id = ?1
             ORDER BY created_at DESC, rowid DESC
             LIMIT -1 OFFSET ?2
          )`
    )
    .bind(pageId, keep)
}

/**
 * 全站修剪语句：每条页面留下最新 `keep` 条，其余一次删净。
 *
 * 单条 set-based DELETE（一次往返、原子），所以返回的 `meta.changes` 就是「删了多少条」，
 * 与预告数一一对应。排序口径与 {@link trimPageRevisionStatement} 相同（`rowid DESC`
 * 兜平同一时刻写入的多条）。
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
                     ORDER BY created_at DESC, rowid DESC
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
 * 口径与 {@link pruneRevisionsStatement} 完全对应：每页 `COUNT(*) - keep` 之和，只算
 * 超过 `keep` 的页面。
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

/**
 * 迁移用：还有哪些行没转成 gzip 形态（旧形态行）。
 *
 * keyset 分页（`id > ?`），`afterId` 传空串取第一页。`content_json <> ''` 排除没有正文
 * 的空行；`content_gzip IS NULL` 让重复执行只处理剩下的行（中断续跑的依据）。
 */
export async function listLegacyRevisionsBatch(
  db: D1Database,
  prefix: string,
  afterId: string,
  limit: number
): Promise<Array<Pick<RevisionRow, "id" | "content_json">>> {
  const rows = await db
    .prepare(
      `SELECT id, content_json
         FROM ${revisionsTable(prefix)}
        WHERE id > ? AND content_gzip IS NULL AND content_json <> ''
        ORDER BY id
        LIMIT ?`
    )
    .bind(afterId, limit)
    .all<Pick<RevisionRow, "id" | "content_json">>()
  return rows.results
}

/**
 * 迁移用：把一行旧形态转换成新形态。
 *
 * 三列文本一并清空（它们的值已由 `content_gzip` 承载，HTML/纯文本可随时从 JSON 生成）；
 * `AND content_gzip IS NULL` 保证重复执行不会覆盖已转换行。
 */
export function backfillRevisionStatement(
  db: D1Database,
  prefix: string,
  revisionId: string,
  gzip: Uint8Array
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE ${revisionsTable(prefix)}
          SET content_gzip = ?, content_json = '', content_html = '', content_text = ''
        WHERE id = ? AND content_gzip IS NULL`
    )
    .bind(gzip, revisionId)
}
