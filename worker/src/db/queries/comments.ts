/**
 * 评论表的读写（规格「页尾评论」§一）：SQL 只管事实，能力判定在 core/comment-access.ts。
 *
 * 读取一律「整页一次取全」（小圈子量级、不分页），并把作者信息 LEFT JOIN 出来：
 * 用户可被管理员彻底删除，而评论保留（不级联删评论），所以 JOIN 必须容忍作者缺失。
 * 已软删的评论也在返回集合里——串结构要靠它们判断「占位保留还是整条消失」。
 */
import { commentsTable, usersTable } from "../../lib/tables"

export interface CommentRow {
  id: string
  page_id: string
  parent_id: string | null
  author_id: string
  body_md: string
  created_at: string
  edited_at: string | null
  deleted_at: string | null
}

/** 列表行：评论本体 + 作者的展示字段（作者已被删除时两个字段都是 NULL）。 */
export interface CommentListRow extends CommentRow {
  author_username: string | null
  author_avatar_key: string | null
}

const SELECT_WITH_AUTHOR = (prefix: string): string =>
  `SELECT c.id, c.page_id, c.parent_id, c.author_id, c.body_md, c.created_at,
          c.edited_at, c.deleted_at,
          u.username AS author_username,
          u.avatar_key AS author_avatar_key
     FROM ${commentsTable(prefix)} c
     LEFT JOIN ${usersTable(prefix)} u ON u.id = c.author_id`

/**
 * 整页评论（含已软删行），时间正序。
 *
 * 次键用 `rowid` 而不是主键：`created_at` 是毫秒 ISO 串，同一毫秒内的连续发表只有
 * 写入次序能定序，这正是「回复按时间平铺」要的稳定顺序（主键是随机 UUID，不可用）。
 */
export async function listPageComments(
  db: D1Database,
  prefix: string,
  pageId: string
): Promise<CommentListRow[]> {
  const rows = await db
    .prepare(
      `${SELECT_WITH_AUTHOR(prefix)} WHERE c.page_id = ? ORDER BY c.created_at, c.rowid`
    )
    .bind(pageId)
    .all<CommentListRow>()
  return rows.results
}

/** 单条（含作者展示字段）；不属于该页或不存在都返回 null，调用方按 404 处理。 */
export async function getCommentWithAuthor(
  db: D1Database,
  prefix: string,
  pageId: string,
  commentId: string
): Promise<CommentListRow | null> {
  const row = await db
    .prepare(`${SELECT_WITH_AUTHOR(prefix)} WHERE c.id = ? AND c.page_id = ?`)
    .bind(commentId, pageId)
    .first<CommentListRow>()
  return row ?? null
}

export interface NewComment {
  id: string
  pageId: string
  /** 顶层评论为 null；回复恒为所在顶层评论的 id（已在路由层归一）。 */
  parentId: string | null
  authorId: string
  bodyMd: string
  createdAt: string
}

export async function insertComment(
  db: D1Database,
  prefix: string,
  comment: NewComment
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ${commentsTable(prefix)}
        (id, page_id, parent_id, author_id, body_md, created_at, edited_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`
    )
    .bind(
      comment.id,
      comment.pageId,
      comment.parentId,
      comment.authorId,
      comment.bodyMd,
      comment.createdAt
    )
    .run()
}

/**
 * 改正文：只动 `body_md` 与 `edited_at`，`created_at` 不动。
 *
 * `deleted_at IS NULL` 写在 WHERE 里：删掉的评论不能再编辑，也不存在「先读后写」
 * 的时间窗。返回改动行数，0 行由调用方译成 409。
 */
export async function updateCommentBody(
  db: D1Database,
  prefix: string,
  commentId: string,
  bodyMd: string,
  editedAt: string
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE ${commentsTable(prefix)} SET body_md = ?, edited_at = ?
        WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(bodyMd, editedAt, commentId)
    .run()
  return result.meta.changes
}

/** 软删（幂等）：重复删除命中 0 行也算成功，不覆盖首次的 `deleted_at`。 */
export async function softDeleteComment(
  db: D1Database,
  prefix: string,
  commentId: string,
  deletedAt: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE ${commentsTable(prefix)} SET deleted_at = ?
        WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(deletedAt, commentId)
    .run()
}
