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
 * 探列结果的 isolate 级缓存：**只缓存「为真」**。
 *
 * 迁移 `schema_v2` 只会加这一列、绝不删，所以一旦探到就永远为真——缓存真值既省掉每次
 * 保存的 `PRAGMA table_info` 往返（D1 子请求很贵），又不会像缓存「假」那样在管理员点完
 * 升级后继续写旧形态行。探到假不缓存：升级动作发生在任意请求之外，本 isolate 必须随时
 * 重新问一次。
 */
let gzipColumnReady = false

/** 仅供测试模拟「升级前的库」：清掉缓存，让下一次探列真的去问数据库。 */
export function resetGzipColumnCache(): void {
  gzipColumnReady = false
}

/**
 * 直接问数据库（不读缓存）。
 *
 * 迁移 `schema_v2` 用它：那一步本身就要负责「列到底在不在」，不能听信请求路径的缓存。
 * 探到列存在就顺手把缓存置真。
 */
export async function probeGzipColumn(
  db: D1Database,
  prefix: string
): Promise<boolean> {
  const columns = await db
    .prepare(`PRAGMA table_info(${revisionsTable(prefix)})`)
    .all<{ name: string }>()
  const ready = columns.results.some((column) => column.name === "content_gzip")
  if (ready) gzipColumnReady = true
  return ready
}

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
  if (gzipColumnReady) return true
  return probeGzipColumn(db, prefix)
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
 * 排序口径是**全站唯一**的「新 → 旧」定义：`created_at DESC, id DESC`。
 * 列表、修剪（{@link trimPageRevisionStatement} / {@link pruneRevisionsStatement}）、
 * 「最新一条不许删」（{@link latestRevisionId} / {@link deleteRevision}）都用它，
 * 改一处必须一起改。
 *
 * 次键用 `id` 而不是 `rowid`：`rowid` 是隐式列，VACUUM 或重建环境（D1 迁移/导出再导入）
 * 不保证稳定，而同一毫秒内写入的多条只靠 `rowid` 才能排出次序。`id` 是主键、任何环境
 * 都一样，所以跨环境的「谁是最新一条」始终是同一个答案。代价是同一毫秒写入时刚写入的
 * 那条不保证排在最前，所以写入路径的修剪额外把刚插入的 id 排除在外
 * （见 {@link trimPageRevisionStatement} 的 `protectRevisionId`）。
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
        ORDER BY created_at DESC, id DESC`
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

/** 该页最新一条版本的 id（没有版本时 null）。与列表同一排序口径。 */
export async function latestRevisionId(
  db: D1Database,
  prefix: string,
  pageId: string
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM ${revisionsTable(prefix)}
        WHERE page_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1`
    )
    .bind(pageId)
    .first<{ id: string }>()
  return row?.id ?? null
}

/**
 * 删一条版本行（限该页），返回删除条数。
 *
 * 「最新一条不许删」写进了 `WHERE`：即使删之前查到的「最新」在中间被并发保存顶掉，
 * 数据库这一句也只会删「此刻确实不是最新」的那条，不存在先读后写的时间窗。返回 0
 * 有两种可能——行不存在/不属于该页，或者它就是最新一条，由调用方再查一次区分
 * （查一次只为选 404 还是 409，不影响删除本身的原子性）。
 */
export async function deleteRevision(
  db: D1Database,
  prefix: string,
  pageId: string,
  revisionId: string
): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM ${revisionsTable(prefix)}
        WHERE id = ?1 AND page_id = ?2
          AND id <> (
            SELECT id FROM ${revisionsTable(prefix)}
             WHERE page_id = ?2
             ORDER BY created_at DESC, id DESC
             LIMIT 1
          )`
    )
    .bind(revisionId, pageId)
    .run()
  return result.meta.changes
}

/**
 * 单页修剪语句：保留该页最新 `keep` 条，其余删除。
 *
 * 放进写入路径的 `db.batch()` 里执行，与「插入新版本」是同一个事务；也供按页批量
 * 「只留最新一条」使用。`LIMIT -1 OFFSET keep` 的次序与 {@link listRevisions} 完全一致。
 *
 * `protectRevisionId`：写入路径把**刚插入的那条**传进来，它永不参与删除。排序次键换成
 * 稳定的 `id` 之后，同一毫秒内写入的多条不保证刚插入的排最前，这条排除就是「最新一条
 * 是当前内容的快照、不可剪」的硬保证；按页批量修剪不针对具体某条，传 `null`。
 */
export function trimPageRevisionStatement(
  db: D1Database,
  prefix: string,
  pageId: string,
  keep: number,
  protectRevisionId: string | null
): D1PreparedStatement {
  const bound =
    protectRevisionId === null
      ? [pageId, keep]
      : [pageId, keep, protectRevisionId]
  const protect = protectRevisionId === null ? "" : "AND id <> ?3"
  return db
    .prepare(
      `DELETE FROM ${revisionsTable(prefix)}
        WHERE page_id = ?1
          AND id IN (
            SELECT id FROM ${revisionsTable(prefix)}
             WHERE page_id = ?1
             ORDER BY created_at DESC, id DESC
             LIMIT -1 OFFSET ?2
          )
          ${protect}`
    )
    .bind(...bound)
}

/**
 * 全站修剪语句：每条页面留下最新 `keep` 条，其余一次删净。
 *
 * 单条 set-based DELETE（一次往返、原子），所以返回的 `meta.changes` 就是「删了多少条」，
 * 与预告数一一对应。排序口径与 {@link trimPageRevisionStatement} 相同（`id DESC`
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
                     ORDER BY created_at DESC, id DESC
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
 * 刻意**不用 id 游标**：`id` 是随机 UUID，与写入先后无关；并发保存可能在迁移期间插进
 * 一条旧形态行（id 可能很小），游标会把它跳过。这里每次只问「当前仍未转换的前 N 行」，
 * 转换过的行由 `content_gzip IS NULL` 自然排除，不论 id 落在哪里都不会漏。
 * `content_json <> ''` 排除没有正文的空行。
 */
export async function listLegacyRevisionsBatch(
  db: D1Database,
  prefix: string,
  limit: number
): Promise<Array<Pick<RevisionRow, "id" | "content_json">>> {
  const rows = await db
    .prepare(
      `SELECT id, content_json
         FROM ${revisionsTable(prefix)}
        WHERE content_gzip IS NULL AND content_json <> ''
        ORDER BY id
        LIMIT ?`
    )
    .bind(limit)
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
