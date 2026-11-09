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
 */
import {
  insertPage,
  maxSortOrder,
  updatePageContent,
  type PageRow
} from "../db/queries/pages"
import { insertRevision, type RevisionRow } from "../db/queries/revisions"
import { indexPageStatements } from "../lib/fts"
import type { PageContent } from "../lib/page-input"

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
    created_at: createdAt
  }
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

  await db.batch([
    insertPage(db, prefix, row),
    insertRevision(db, prefix, newRevision(row.id, content, userId, now)),
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

  await db.batch([
    updatePageContent(db, prefix, {
      id: existing.id,
      title: content.title,
      content_json: content.contentJson,
      content_html: content.contentHtml,
      content_text: content.contentText,
      updated_by: userId,
      updated_at: now
    }),
    insertRevision(db, prefix, newRevision(existing.id, content, userId, now)),
    ...indexPageStatements(db, prefix, {
      id: existing.id,
      title: content.title,
      contentText: content.contentText
    })
  ])

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
