/**
 * 页尾评论（规格「Ciki 页尾评论」§一、§二）：挂在页面维度下，与页面同一条会话中间件。
 *
 * 权限只有两条口径：
 * - 读/发表/预览 = 与 `GET /api/pages/:id` 同一把尺子（`getPageRow` + 页面未软删 +
 *   `resolveSpaceRole` 拿到任一角色）；非成员与页面不存在同口径 404，不泄露存在性。
 * - 编辑 = 作者本人；删除 = 作者本人、该页所属空间 `admin`、站点管理员
 *   （判定在 core/comment-access.ts，本站点管理员已归一到 `admin`）。
 *
 * 串只有一级：回复的目标若是回复，写库前归一到它所属的顶层评论（`parent_id` 永远是
 * 顶层 id），所以不存在二级嵌套，回复按时间平铺在所属顶层之下。
 *
 * HTML 在这里现算（`renderCommentHtml` → `sanitizeCommentHtml`），库里只存 Markdown
 * 原文；列表、预览、发表/编辑的响应共用同一条链，前端不做二次渲染。
 */
import { Hono } from "hono"
import type { Context } from "hono"
import { canDeleteComment, canEditComment } from "../core/comment-access"
import { resolveSpaceRole, type SpaceRole } from "../core/space-access"
import {
  getCommentWithAuthor,
  insertComment,
  listPageComments,
  softDeleteComment,
  updateCommentBody,
  type CommentListRow
} from "../db/queries/comments"
import { getPageRow, type PageRow } from "../db/queries/pages"
import {
  normalizeCommentBody,
  previewCommentBody,
  type CommentBodyResult
} from "../lib/comment-input"
import { renderCommentHtml } from "../lib/comment-render"
import { parseId, readJsonBody, readParentId } from "../lib/http"
import { getTablePrefix } from "../lib/table-prefix"
import type { HonoEnv } from "../types"

export const commentRoutes = new Hono<HonoEnv>()

/** 作者被管理员彻底删除后评论仍在：名字回落到兜底文案（不级联删评论）。 */
const DELETED_AUTHOR_NAME = "已注销用户"

interface CommentDto {
  id: number
  parentId: number | null
  authorId: number
  authorName: string
  authorAvatarUrl: string | null
  bodyMd: string
  html: string
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
  canEdit: boolean
  canDelete: boolean
}

interface ThreadDto extends CommentDto {
  replies: CommentDto[]
}

interface Viewer {
  userId: number
  role: SpaceRole
}

function pageNotFound(c: Context<HonoEnv>) {
  return c.json({ error: "Page not found" }, 404)
}

function commentNotFound(c: Context<HonoEnv>) {
  return c.json({ error: "Comment not found", code: "COMMENT_NOT_FOUND" }, 404)
}

function commentDeleted(c: Context<HonoEnv>) {
  return c.json({ error: "Comment is deleted", code: "COMMENT_DELETED" }, 409)
}

function forbidden(c: Context<HonoEnv>) {
  return c.json({ error: "Forbidden" }, 403)
}

/** 正文校验失败 → 契约状态码（超限 413，其余 400）。 */
function badBody(parsed: Extract<CommentBodyResult, { ok: false }>) {
  const status = parsed.code === "PAYLOAD_TOO_LARGE" ? 413 : 400
  return {
    status,
    body: { error: parsed.error, ...(parsed.code ? { code: parsed.code } : {}) }
  } as const
}

function isSiteAdmin(c: Context<HonoEnv>): boolean {
  return c.get("role") === "admin"
}

/**
 * 页面 + 当前用户在该页所属空间的有效角色。
 *
 * 页面不存在、已软删（进了回收站）与非成员一律 null → 调用方回 404：评论随页面不可见，
 * 恢复后原样回来，不需要在评论表上加任何联动列。
 */
async function commentTarget(
  c: Context<HonoEnv>,
  pageId: number
): Promise<{ page: PageRow; role: SpaceRole } | null> {
  const prefix = getTablePrefix(c.env)
  const page = await getPageRow(c.env.DB, prefix, pageId)
  if (!page || page.deleted_at) return null
  const role = await resolveSpaceRole(
    c.env.DB,
    prefix,
    page.space_id,
    c.get("userId"),
    isSiteAdmin(c)
  )
  if (!role) return null
  return { page, role }
}

/** 库行 → DTO；已软删的评论不给正文（占位只显示「该评论已删除」），也不给操作。 */
function toDto(row: CommentListRow, viewer: Viewer): CommentDto {
  const deleted = row.deleted_at !== null
  return {
    id: row.id,
    parentId: row.parent_id,
    authorId: row.author_id,
    authorName: row.author_username ?? DELETED_AUTHOR_NAME,
    authorAvatarUrl: row.author_avatar_key
      ? `/api/files/${row.author_avatar_key}`
      : null,
    bodyMd: deleted ? "" : row.body_md,
    html: deleted ? "" : renderCommentHtml(row.body_md),
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    canEdit: !deleted && canEditComment(row.author_id, viewer.userId),
    canDelete:
      !deleted && canDeleteComment(viewer.role, row.author_id, viewer.userId)
  }
}

/**
 * 整页 → 串结构（顶层正序，各自回复正序平铺）。
 *
 * 软删的呈现口径（规格 §四）：
 * - 无存活回复的评论整条不返回（顶层与回复都一样）；
 * - 有存活回复的顶层评论保留占位（`deletedAt` 非空、正文为空），串结构不断；
 * - `total` 只数未删除的顶层 + 未删除的回复，与占位条数无关。
 */
function buildThreads(
  rows: CommentListRow[],
  viewer: Viewer
): { total: number; threads: ThreadDto[] } {
  const tops: CommentListRow[] = []
  const repliesByParent = new Map<number, CommentListRow[]>()
  for (const row of rows) {
    if (row.parent_id === null) {
      tops.push(row)
      continue
    }
    const bucket = repliesByParent.get(row.parent_id)
    if (bucket) bucket.push(row)
    else repliesByParent.set(row.parent_id, [row])
  }

  let total = 0
  const threads: ThreadDto[] = []
  for (const top of tops) {
    const replies = (repliesByParent.get(top.id) ?? []).filter(
      (row) => row.deleted_at === null
    )
    if (top.deleted_at !== null && replies.length === 0) continue
    if (top.deleted_at === null) total += 1
    total += replies.length
    threads.push({
      ...toDto(top, viewer),
      replies: replies.map((row) => toDto(row, viewer))
    })
  }
  return { total, threads }
}

// ── 列表 ────────────────────────────────────────────────────────────────────

commentRoutes.get("/:id/comments", async (c) => {
  const pageId = parseId(c.req.param("id"))
  if (pageId === null) return pageNotFound(c)
  const target = await commentTarget(c, pageId)
  if (!target) return pageNotFound(c)

  const prefix = getTablePrefix(c.env)
  const rows = await listPageComments(c.env.DB, prefix, target.page.id)
  const viewer: Viewer = { userId: c.get("userId"), role: target.role }
  return c.json(buildThreads(rows, viewer))
})

// ── 预览 ────────────────────────────────────────────────────────────────────

/**
 * 发表/编辑前的预览：与列表同一条渲染净化链，不写库。
 *
 * 允许空正文（回空串）——「空正文不许提交」由发表接口与前端按钮把关，预览不该报错。
 * 必须注册在 `/:id/comments/:commentId` 之前的口径这里不冲突：后者只收 PUT/DELETE。
 */
commentRoutes.post("/:id/comments/preview", async (c) => {
  const pageId = parseId(c.req.param("id"))
  if (pageId === null) return pageNotFound(c)
  const target = await commentTarget(c, pageId)
  if (!target) return pageNotFound(c)

  const body = await readJsonBody<Record<string, unknown>>(c)
  const parsed = previewCommentBody(body?.bodyMd)
  if (!parsed.ok) {
    const { status, body: errorBody } = badBody(parsed)
    return c.json(errorBody, status)
  }
  return c.json({ html: parsed.html })
})

// ── 发表 ────────────────────────────────────────────────────────────────────

commentRoutes.post("/:id/comments", async (c) => {
  const pageId = parseId(c.req.param("id"))
  if (pageId === null) return pageNotFound(c)
  const target = await commentTarget(c, pageId)
  if (!target) return pageNotFound(c)

  const body = await readJsonBody<Record<string, unknown>>(c)
  const parsed = normalizeCommentBody(body?.bodyMd)
  if (!parsed.ok) {
    const { status, body: errorBody } = badBody(parsed)
    return c.json(errorBody, status)
  }
  const parent = readParentId(body?.parentId)
  if (!parent.ok) {
    return c.json({ error: "parentId must be an integer or null" }, 400)
  }

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  /**
   * 回复归一到顶层：父评论本身是回复时取它的 `parent_id`，永远不产生二级嵌套。
   *
   * 父评论**已软删也接受**（不报 409）：有存活回复的顶层评论在列表里以「该评论已删除」
   * 占位保留，串下再点「回复」时前端提交的正是这个已软删的顶层 id；接住它，新回复照旧
   * 挂在该串下，与规格「串结构保留」一致（占位因为多了一条存活回复而继续保留）。
   * 只有「不存在 / 不属于本页」才是 404。
   */
  let parentId: number | null = null
  if (parent.value !== null) {
    const parentRow = await getCommentWithAuthor(
      db,
      prefix,
      target.page.id,
      parent.value
    )
    if (!parentRow) return commentNotFound(c)
    parentId = parentRow.parent_id ?? parentRow.id
  }

  const id = await insertComment(db, prefix, {
    pageId: target.page.id,
    parentId,
    authorId: c.get("userId"),
    bodyMd: parsed.value.bodyMd,
    createdAt: new Date().toISOString()
  })

  const created = await getCommentWithAuthor(db, prefix, target.page.id, id)
  if (!created) return commentNotFound(c)
  return c.json(
    toDto(created, { userId: c.get("userId"), role: target.role }),
    201
  )
})

// ── 编辑 ────────────────────────────────────────────────────────────────────

commentRoutes.put("/:id/comments/:commentId", async (c) => {
  const pageId = parseId(c.req.param("id"))
  const commentId = parseId(c.req.param("commentId"))
  if (pageId === null || commentId === null) return pageNotFound(c)
  const target = await commentTarget(c, pageId)
  if (!target) return pageNotFound(c)

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const existing = await getCommentWithAuthor(db, prefix, pageId, commentId)
  if (!existing) return commentNotFound(c)
  if (existing.deleted_at) return commentDeleted(c)
  if (!canEditComment(existing.author_id, c.get("userId"))) return forbidden(c)

  const body = await readJsonBody<Record<string, unknown>>(c)
  const parsed = normalizeCommentBody(body?.bodyMd)
  if (!parsed.ok) {
    const { status, body: errorBody } = badBody(parsed)
    return c.json(errorBody, status)
  }

  const changed = await updateCommentBody(
    db,
    prefix,
    commentId,
    parsed.value.bodyMd,
    new Date().toISOString()
  )
  // 0 行 = 读取之后被并发删掉了：按已删除回，不假装写成功。
  if (changed === 0) return commentDeleted(c)

  const updated = await getCommentWithAuthor(db, prefix, pageId, commentId)
  if (!updated) return commentNotFound(c)
  return c.json(toDto(updated, { userId: c.get("userId"), role: target.role }))
})

// ── 删除（软删） ────────────────────────────────────────────────────────────

commentRoutes.delete("/:id/comments/:commentId", async (c) => {
  const pageId = parseId(c.req.param("id"))
  const commentId = parseId(c.req.param("commentId"))
  if (pageId === null || commentId === null) return pageNotFound(c)
  const target = await commentTarget(c, pageId)
  if (!target) return pageNotFound(c)

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const existing = await getCommentWithAuthor(
    db,
    prefix,
    target.page.id,
    commentId
  )
  if (!existing) return commentNotFound(c)
  if (!canDeleteComment(target.role, existing.author_id, c.get("userId"))) {
    return forbidden(c)
  }

  // 幂等：已经删过的再删一次也回成功，不覆盖首次的 deleted_at。
  await softDeleteComment(db, prefix, existing.id, new Date().toISOString())
  return c.json({ success: true })
})
