/**
 * 站内通知接口（规格「Ciki 评论通知」§接口）：
 * 仅限真人会话，令牌不可用。
 *
 * - GET /api/notifications?limit&offset：按时间倒序
 * - GET /api/notifications/unread-count：未读计数
 * - POST /api/notifications/:id/read：标单条已读，仅限本人
 * - POST /api/notifications/read-all：全部标已读
 */
import { Hono } from "hono"
import {
  countUnreadNotifications,
  findNotificationById,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationListRow
} from "../db/queries/notifications"
import { parseId } from "../lib/http"
import { getTablePrefix } from "../lib/table-prefix"
import type { HonoEnv } from "../types"
import { DELETED_AUTHOR_NAME } from "./comments"

export const notificationRoutes = new Hono<HonoEnv>()

export interface NotificationDto {
  id: number
  recipientId: number
  actorId: number
  actorName: string
  actorAvatarUrl: string | null
  type: "comment" | "reply"
  pageId: number
  commentId: number
  pageTitle: string
  excerpt: string
  read: boolean
  isRead: boolean
  readAt: string | null
  createdAt: string
}

function toDto(row: NotificationListRow): NotificationDto {
  const isRead = row.read_at !== null
  return {
    id: row.id,
    recipientId: row.recipient_id,
    actorId: row.actor_id,
    actorName: row.actor_username ?? DELETED_AUTHOR_NAME,
    actorAvatarUrl: row.actor_avatar_key
      ? `/api/files/${row.actor_avatar_key}`
      : null,
    type: row.type as "comment" | "reply",
    pageId: row.page_id,
    commentId: row.comment_id,
    pageTitle: row.page_title,
    excerpt: row.excerpt,
    read: isRead,
    isRead,
    readAt: row.read_at,
    createdAt: row.created_at
  }
}

// ── 列表 ────────────────────────────────────────────────────────────────────

notificationRoutes.get("/", async (c) => {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")

  const limitParam = Number.parseInt(c.req.query("limit") ?? "20", 10)
  const offsetParam = Number.parseInt(c.req.query("offset") ?? "0", 10)

  const limit = Math.min(
    Math.max(Number.isFinite(limitParam) ? limitParam : 20, 1),
    100
  )
  const offset = Math.max(Number.isFinite(offsetParam) ? offsetParam : 0, 0)

  const rows = await listNotifications(c.env.DB, prefix, userId, {
    limit,
    offset
  })

  return c.json(rows.map(toDto))
})

// ── 未读计数 ────────────────────────────────────────────────────────────────

notificationRoutes.get("/unread-count", async (c) => {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")

  const count = await countUnreadNotifications(c.env.DB, prefix, userId)
  return c.json({ count, unreadCount: count })
})

// ── 标单条已读 ──────────────────────────────────────────────────────────────

notificationRoutes.post("/:id/read", async (c) => {
  const id = parseId(c.req.param("id"))
  if (id === null) return c.json({ error: "Notification not found" }, 404)

  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const notification = await findNotificationById(c.env.DB, prefix, id)

  if (!notification) {
    return c.json({ error: "Notification not found" }, 404)
  }

  if (notification.recipient_id !== userId) {
    return c.json({ error: "Forbidden" }, 403)
  }

  const now = new Date().toISOString()
  await markNotificationRead(c.env.DB, prefix, id, userId, now)
  return c.json({ success: true })
})

// ── 全部标已读 ──────────────────────────────────────────────────────────────

notificationRoutes.post("/read-all", async (c) => {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const now = new Date().toISOString()

  await markAllNotificationsRead(c.env.DB, prefix, userId, now)
  return c.json({ success: true })
})
