/**
 * 页面写入的单一写路径：页面行 + revision + FTS 索引在同一个 `db.batch()`
 * 事务里完成。
 *
 * `/api/pages` 的新建/保存/回滚与 `/api/import/pages` 的导入都走这里，
 * 保证「导入更新同名页 = 与正常保存同一路径」：有改动都追加一条 revision、都同步
 * 搜索索引，没有第二套写法。
 *
 * 无改动的保存在这里收口：归一化后的内容与库里现存行四列全等时判定为无改动，
 * 不写页面行、不追加 revision、不重建 FTS，原样返回现存行（`updated_at` /
 * `updated_by` 都不动），调用方拿到的响应形状与正常保存一致。
 *
 * 版本正文的落库形态在这里定：`page_revisions.content_gzip` 就绪（迁移 `schema_v2`
 * 已跑）时只写一份 gzip 的 JSON，HTML/纯文本不入版本表；列还不存在时（部署后、管理员
 * 点「检查并升级数据库」之前）按旧三列写——保存不会因为缺列而失败，升级时迁移会把
 * 这些行一并转换。
 *
 * 保留数修剪（规格「保留数设置」）在 `savePageContent` 里落地：新增版本之后，把该页
 * 超出上限的最旧版本删掉，与其他写入语句在同一个 `db.batch()` 事务里。
 */
import {
  insertPage,
  maxSortOrder,
  updatePageContent,
  type PageRow
} from "../db/queries/pages"
import {
  hasGzipColumn,
  insertRevision,
  trimPageRevisionStatement,
  type RevisionRow
} from "../db/queries/revisions"
import { indexPageStatements } from "../lib/fts"
import { gzipText } from "../lib/gzip"
import type { PageContent } from "../lib/page-input"
import { readRetentionLimit } from "./revision-retention"

/**
 * 版本时间戳的单调时钟：保证同一 isolate 内先后写入的版本时间严格递增（毫秒级）。
 *
 * 为什么要它：版本排序一律用 `created_at DESC, id DESC`（不依赖 `rowid`，见
 * db/queries/revisions.ts 的说明），而 `created_at` 只有毫秒精度——连续两次保存很容易
 * 落在同一毫秒，那样「最新一条」就退化成比 UUID 大小，同一个库不同环境还可能给出不同
 * 答案。这里把时间顶到上一版本 +1ms，同一 isolate 内「写入次序 = 排序结果」永远成立。
 * 跨 isolate 的并发写仍可能同毫秒，那属于真正的同时写入，次序本就无定义。
 *
 * 只动版本行的 `created_at`：页面行的 `updated_at` 仍用调用方给的时间，不变。
 */
let lastRevisionAtMs = 0

function nextRevisionTimestamp(now: string): string {
  const requested = Date.parse(now)
  const base = Number.isFinite(requested) ? requested : Date.now()
  const at = Math.max(base, lastRevisionAtMs + 1)
  lastRevisionAtMs = at
  return new Date(at).toISOString()
}

function newRevision(
  pageId: string,
  content: PageContent,
  editorId: string,
  createdAt: string
): RevisionRow {
  return {
    id: crypto.randomUUID(),
    page_id: pageId,
    title: content.title,
    content_json: content.contentJson,
    content_html: content.contentHtml,
    content_text: content.contentText,
    editor_id: editorId,
    created_at: nextRevisionTimestamp(createdAt)
  }
}

/**
 * 一条版本行的 INSERT 语句，形态取决于库是否已有 `content_gzip` 列。
 *
 * 列是否就绪只探一次（命中后由 db/queries/revisions.ts 的 isolate 缓存记住真值）：
 * 升级动作发生在任意请求之外，缓存「假」会让 isolate 继续写旧形态行，所以只缓存真值。
 */
async function revisionStatement(
  db: D1Database,
  prefix: string,
  row: RevisionRow
): Promise<D1PreparedStatement> {
  const gzip = (await hasGzipColumn(db, prefix))
    ? await gzipText(row.content_json)
    : null
  return insertRevision(db, prefix, row, gzip)
}

export interface PageWriteOptions {
  content: PageContent
  userId: string
  now: string
}

/**
 * 归一化后的来稿与库里现存行是否全等（= 本次保存无改动）。
 *
 * 比对口径是「服务端归一化后的值」对「上次归一化落库的值」，逐字节严格比较：
 * 不对库里的值再做一次消毒/取纯文本，也不比较 `parent_id` / `space_id` /
 * `sort_order`（这三项不归保存管）。宁可多记一条 revision，也不吞掉真实改动。
 */
function contentUnchanged(existing: PageRow, content: PageContent): boolean {
  return (
    existing.title === content.title &&
    existing.content_json === content.contentJson &&
    existing.content_html === content.contentHtml &&
    existing.content_text === content.contentText
  )
}

/** 新建页面（追加到同级末尾），同时写首条 revision 与 FTS。 */
export async function createPage(
  db: D1Database,
  prefix: string,
  options: PageWriteOptions & { parentId: string | null; spaceId: string }
): Promise<PageRow> {
  const { content, userId, now, parentId, spaceId } = options
  const row: PageRow = {
    id: crypto.randomUUID(),
    space_id: spaceId,
    parent_id: parentId,
    title: content.title,
    sort_order: await maxSortOrder(db, prefix, spaceId, parentId),
    content_json: content.contentJson,
    content_html: content.contentHtml,
    content_text: content.contentText,
    created_by: userId,
    updated_by: userId,
    created_at: now,
    updated_at: now,
    deleted_at: null
  }

  // 新建页只有这一条版本（保留数下限是 1），不需要修剪。
  await db.batch([
    insertPage(db, prefix, row),
    await revisionStatement(
      db,
      prefix,
      newRevision(row.id, content, userId, now)
    ),
    ...indexPageStatements(db, prefix, {
      id: row.id,
      title: row.title,
      contentText: row.content_text
    })
  ])

  return row
}

/**
 * 覆盖既有页面的内容（保存/回滚/导入更新共用）。
 *
 * 内容与现存行四列全等 → 无改动：不写页面行、不追加 revision、不重建 FTS，
 * 直接返回现存行；否则原样写入并追加一条 revision、同步 FTS。
 */
export async function savePageContent(
  db: D1Database,
  prefix: string,
  existing: PageRow,
  options: PageWriteOptions
): Promise<PageRow> {
  const { content, userId, now } = options
  if (contentUnchanged(existing, content)) return existing

  const revision = newRevision(existing.id, content, userId, now)
  const statements = [
    updatePageContent(db, prefix, {
      id: existing.id,
      title: content.title,
      content_json: content.contentJson,
      content_html: content.contentHtml,
      content_text: content.contentText,
      updated_by: userId,
      updated_at: now
    }),
    await revisionStatement(db, prefix, revision),
    ...indexPageStatements(db, prefix, {
      id: existing.id,
      title: content.title,
      contentText: content.contentText
    })
  ]

  // 修剪与插入同一个事务：要么「新版本进、超出的最旧版本出」一起生效，要么都不生效。
  // 刚插入的这条 id 传进去排除在外，所以「最新一条是当前内容的快照、不可剪」不依赖
  // 时间戳的毫秒精度，同一毫秒连写也不会被剪掉。
  const limit = await readRetentionLimit(db, prefix)
  if (limit !== null) {
    statements.push(
      trimPageRevisionStatement(db, prefix, existing.id, limit, revision.id)
    )
  }

  await db.batch(statements)

  return {
    ...existing,
    title: content.title,
    content_json: content.contentJson,
    content_html: content.contentHtml,
    content_text: content.contentText,
    updated_by: userId,
    updated_at: now
  }
}
