/**
 * 页面写入的单一写路径：正文上 R2 + 衍生件/版本/FTS 落 D1。
 *
 * `/api/pages` 的新建/保存/回滚与 `/api/import/pages` 的导入都走这里，
 * 保证「导入更新同名页 = 与正常保存同一路径」：有改动都追加一条版本、都同步
 * 搜索索引，没有第二套写法。
 *
 * 顺序定死（规格「读写路径」）：算 JSON → 算哈希 → PUT 对象 → 单次 `db.batch()`
 * 落衍生件 + `content_hash` + 新版本行。先 R2 后 D1，失败只产孤儿对象（由月度内容 GC
 * 收），绝不允许 D1 指针悬空。正文全等的保存在 PUT 之前就返回：不写行、不追加版本；
 * 只有标题变则原地更新标题与搜索索引（同样不追加版本、不新增对象）。
 *
 * 正文只以 `content/<sha256>` 对象存在（`core/content-store.ts`）；D1 留
 * `content_html` / `content_text` / `content_md` 三件派生件，读页、搜索、MD 下载
 * 全走 D1，热路径不碰 R2。
 *
 * 保留数修剪（规格「保留数设置」）在 `savePageContent` 里落地：新增版本之后，把该页
 * 超出上限的最旧版本删掉，与其他写入语句在同一个 `db.batch()` 事务里。
 */
import {
  insertPage,
  maxSortOrder,
  updatePageContent,
  updatePageTitle,
  type PageRow
} from "../db/queries/pages"
import {
  insertFirstRevision,
  insertRevision,
  trimPageRevisionStatement
} from "../db/queries/revisions"
import { hashContent, putContent, putContentHashed } from "./content-store"
import { firstPageIndexStatement, indexPageStatements } from "../lib/fts"
import { revisionsTable } from "../lib/tables"
import type { PageContent } from "../lib/page-input"
import type { Env } from "../types"
import { readRetentionLimit } from "./revision-retention"

export interface PageWriteOptions {
  content: PageContent
  userId: number
  now: string
}

/**
 * 正文部分（哈希 + HTML + 纯文本）是否全等 = 本次保存是否不需要新版本。
 *
 * **标题不参与**：改名是页级元数据变更，不能长版本（用户口径「改名应零版本增长」）。
 * 比对口径是「服务端归一化后的值」对「上次归一化落库的值」，逐字节严格比较。
 * 不比较 `parent_id` / `space_id` / `sort_order`（这三项不归保存管）。宁可多记一条
 * 版本，也不吞掉真实正文改动。
 */
export function bodyUnchanged(
  existing: PageRow,
  content: PageContent,
  hash: string
): boolean {
  return (
    existing.content_hash === hash &&
    existing.content_html === content.contentHtml &&
    existing.content_text === content.contentText
  )
}

/** 新建页面（追加到同级末尾），同时写首条版本与 FTS。 */
export async function createPage(
  env: Env,
  prefix: string,
  options: PageWriteOptions & { parentId: number | null; spaceId: number }
): Promise<PageRow> {
  const { content, userId, now, parentId, spaceId } = options
  const db = env.DB
  const hash = await putContent(env, content.contentJson)

  const row = {
    space_id: spaceId,
    parent_id: parentId,
    title: content.title,
    sort_order: await maxSortOrder(db, prefix, spaceId, parentId),
    content_hash: hash,
    content_html: content.contentHtml,
    content_text: content.contentText,
    content_md: content.contentMd,
    created_by: userId,
    updated_by: userId,
    created_at: now,
    updated_at: now,
    deleted_at: null
  }

  // 页面行 + 首条版本 + FTS 在同一个事务里：页面 INSERT 之后的语句用
  // `last_insert_rowid()` 取刚分配的整数 id（见 insertFirstRevision 的说明），
  // 所以不会出现「页面建了、版本或索引没写」的半套数据。
  const inserted = await db.batch([
    insertPage(db, prefix, row),
    insertFirstRevision(db, prefix, {
      title: content.title,
      content_hash: hash,
      editor_id: userId,
      created_at: now
    }),
    firstPageIndexStatement(db, prefix, {
      title: content.title,
      contentText: content.contentText
    })
  ])
  const id = inserted[0].meta.last_row_id

  // 自检：D1 文档保证 batch 内语句「顺序、非并发」执行，所以 `last_insert_rowid()`
  // 一定拿到刚插入的页面 id。万一某个运行时不满足（例如 batch 被拆到不同连接），
  // 首条版本或索引就会写错/写空——这里按 id 复核一次，缺什么补什么，绝不留下
  // 「有页面、没版本、搜不到」的静默坏数据（新建是低频操作，多一次查询可接受）。
  const hasFirstRevision = await db
    .prepare(
      `SELECT 1 AS ok FROM ${revisionsTable(prefix)} WHERE page_id = ? LIMIT 1`
    )
    .bind(id)
    .first<{ ok: number }>()
  if (!hasFirstRevision) {
    await db.batch([
      insertRevision(db, prefix, {
        page_id: id,
        title: content.title,
        content_hash: hash,
        editor_id: userId,
        created_at: now
      }),
      ...indexPageStatements(db, prefix, {
        id,
        title: content.title,
        contentText: content.contentText
      })
    ])
  }

  return { id, ...row }
}

/**
 * 只改标题（页级元数据）：不产新版本、不新增/不改 R2 对象，只把标题与 FTS 同批改写。
 * 标题相同是空操作（不写库、不涨 `updated_at`），与「无改动保存」同一口径。
 *
 * 抽出来给 `/api/write/pages/:id` 的 title-only 更新用：那条入口没有正文可重算，
 * 不能为了复用 `savePageContent` 去 R2 取一遍 JSON。
 */
export async function renamePage(
  env: Env,
  prefix: string,
  existing: PageRow,
  options: { title: string; userId: number; now: string }
): Promise<PageRow> {
  if (existing.title === options.title) return existing
  const db = env.DB
  await db.batch([
    updatePageTitle(db, prefix, {
      id: existing.id,
      title: options.title,
      updated_by: options.userId,
      updated_at: options.now
    }),
    ...indexPageStatements(db, prefix, {
      id: existing.id,
      title: options.title,
      contentText: existing.content_text
    })
  ])
  return {
    ...existing,
    title: options.title,
    updated_by: options.userId,
    updated_at: options.now
  }
}

/**
 * 覆盖既有页面的内容（保存/回滚/导入更新共用）。
 *
 * 正文全等（哈希 + HTML + 纯文本）即不产新版本、不上传对象：
 * - 标题也没变 → 完全无改动，直接返回现存行；
 * - 只有标题变了 → 页级元数据原地更新（只写 title + 更新时间，同步 FTS），不写版本行。
 *
 * 正文有改动 → 先 PUT 内容对象，再在一个事务里写页面行 + 新版本 + FTS + 修剪。
 */
export async function savePageContent(
  env: Env,
  prefix: string,
  existing: PageRow,
  options: PageWriteOptions
): Promise<PageRow> {
  const { content, userId, now } = options
  const db = env.DB
  const hash = await hashContent(content.contentJson)

  if (bodyUnchanged(existing, content, hash)) {
    if (existing.title === content.title) return existing
    // 改名：不产新版本、不新增 R2 对象，只把标题当元数据改写（搜索索引跟着换标题）。
    return renamePage(env, prefix, existing, {
      title: content.title,
      userId,
      now
    })
  }

  // 先 R2 后 D1：对象写成功才动库，指针永不悬空。
  await putContentHashed(env, hash, content.contentJson)

  const statements = [
    updatePageContent(db, prefix, {
      id: existing.id,
      title: content.title,
      content_hash: hash,
      content_html: content.contentHtml,
      content_text: content.contentText,
      content_md: content.contentMd,
      updated_by: userId,
      updated_at: now
    }),
    insertRevision(db, prefix, {
      page_id: existing.id,
      title: content.title,
      content_hash: hash,
      editor_id: userId,
      created_at: now
    }),
    ...indexPageStatements(db, prefix, {
      id: existing.id,
      title: content.title,
      contentText: content.contentText
    })
  ]

  // 修剪与插入同一个事务：要么「新版本进、超出的最旧版本出」一起生效，要么都不生效。
  const limit = await readRetentionLimit(db, prefix)
  if (limit !== null) {
    statements.push(trimPageRevisionStatement(db, prefix, existing.id, limit))
  }

  await db.batch(statements)

  return {
    ...existing,
    title: content.title,
    content_hash: hash,
    content_html: content.contentHtml,
    content_text: content.contentText,
    content_md: content.contentMd,
    updated_by: userId,
    updated_at: now
  }
}
