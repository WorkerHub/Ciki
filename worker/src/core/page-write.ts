/**
 * 页面写入的单一写路径：页面行 + revision + FTS 索引在同一个 `db.batch()`
 * 事务里完成。
 *
 * `/api/pages` 的新建/保存/回滚与 `/api/import/pages` 的导入都走这里，
 * 保证「导入更新同名页 = 与正常保存同一路径」：都追加一条 revision、都同步
 * 搜索索引，没有第二套写法。
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

/** 覆盖既有页面的内容（保存/回滚/导入更新共用），追加 revision 并同步 FTS。 */
export async function savePageContent(
  db: D1Database,
  prefix: string,
  existing: PageRow,
  options: PageWriteOptions
): Promise<PageRow> {
  const { content, userId, now } = options
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
