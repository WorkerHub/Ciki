/**
 * 评论通知业务逻辑（规格「Ciki 评论通知」§产生）：
 *
 * 规则：
 * 1. 接收人集合 = { 页面创建者 } ∪ { 父评论作者（回复时） } − { 评论者本人 } − { agent 账号 }。
 * 2. 同一人只写一条（其为父评论作者时 type 取 reply，否则 comment）。
 * 3. 评论者是 agent 时照常通知人类接收人；agent 账号永不作为接收人。
 * 4. 评论纯文本截断 100 字快照存入 excerpt，页面标题存入 page_title 快照。
 */
import {
  insertNotifications,
  type InsertNotificationInput
} from "../db/queries/notifications"
import { toPlainText } from "../lib/sanitize"
import { usersTable } from "../lib/tables"

export interface CreateCommentNotificationsInput {
  db: D1Database
  prefix: string
  page: { id: number; title: string; created_by: number }
  commentId: number
  commenterId: number
  html: string
  parentAuthorId: number | null
  createdAt?: string
}

export async function createCommentNotifications(
  input: CreateCommentNotificationsInput
): Promise<void> {
  const { db, prefix, page, commentId, commenterId, html, parentAuthorId } =
    input

  const recipients = new Map<number, "comment" | "reply">()

  // 页面创建者（若非评论者本人）
  if (page.created_by > 0 && page.created_by !== commenterId) {
    recipients.set(page.created_by, "comment")
  }

  // 父评论作者（若非评论者本人，且其为父评论作者时 type 取 reply 覆盖 comment）
  if (parentAuthorId && parentAuthorId > 0 && parentAuthorId !== commenterId) {
    recipients.set(parentAuthorId, "reply")
  }

  if (recipients.size === 0) return

  // 排除 Agent 账号与不存在的用户
  const candidateIds = Array.from(recipients.keys())
  const placeholders = candidateIds.map(() => "?").join(", ")
  const rows = await db
    .prepare(
      `SELECT id, kind FROM ${usersTable(prefix)} WHERE id IN (${placeholders})`
    )
    .bind(...candidateIds)
    .all<{ id: number; kind: string }>()

  const humanUserIds = new Set(
    rows.results.filter((r) => r.kind !== "agent").map((r) => r.id)
  )

  for (const id of candidateIds) {
    if (!humanUserIds.has(id)) {
      recipients.delete(id)
    }
  }

  if (recipients.size === 0) return

  // 纯文本截断 100 字
  const plainText = toPlainText(html)
  const excerpt = [...plainText].slice(0, 100).join("")
  const now = input.createdAt ?? new Date().toISOString()

  const items: InsertNotificationInput[] = Array.from(recipients.entries()).map(
    ([recipientId, type]) => ({
      recipientId,
      actorId: commenterId,
      type,
      pageId: page.id,
      commentId,
      pageTitle: page.title,
      excerpt,
      createdAt: now
    })
  )

  await insertNotifications(db, prefix, items)
}
