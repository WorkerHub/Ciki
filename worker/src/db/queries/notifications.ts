import { notificationsTable, usersTable } from "../../lib/tables"

export interface NotificationRow {
  id: number
  recipient_id: number
  actor_id: number
  type: string
  page_id: number
  comment_id: number
  page_title: string
  excerpt: string
  created_at: string
  read_at: string | null
}

export interface NotificationListRow extends NotificationRow {
  actor_username: string | null
  actor_avatar_key: string | null
}

export interface InsertNotificationInput {
  recipientId: number
  actorId: number
  type: "comment" | "reply"
  pageId: number
  commentId: number
  pageTitle: string
  excerpt: string
  createdAt: string
}

export async function insertNotifications(
  db: D1Database,
  prefix: string,
  items: InsertNotificationInput[]
): Promise<void> {
  if (items.length === 0) return
  const table = notificationsTable(prefix)
  const sql = `INSERT INTO ${table}
    (recipient_id, actor_id, type, page_id, comment_id, page_title, excerpt, created_at, read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`

  if (items.length === 1) {
    const item = items[0]
    await db
      .prepare(sql)
      .bind(
        item.recipientId,
        item.actorId,
        item.type,
        item.pageId,
        item.commentId,
        item.pageTitle,
        item.excerpt,
        item.createdAt
      )
      .run()
    return
  }

  const stmts = items.map((item) =>
    db
      .prepare(sql)
      .bind(
        item.recipientId,
        item.actorId,
        item.type,
        item.pageId,
        item.commentId,
        item.pageTitle,
        item.excerpt,
        item.createdAt
      )
  )
  await db.batch(stmts)
}

export async function listNotifications(
  db: D1Database,
  prefix: string,
  recipientId: number,
  options: { limit: number; offset: number }
): Promise<NotificationListRow[]> {
  const notifications = notificationsTable(prefix)
  const users = usersTable(prefix)
  const sql = `SELECT n.id, n.recipient_id, n.actor_id, n.type, n.page_id, n.comment_id,
          n.page_title, n.excerpt, n.created_at, n.read_at,
          u.username AS actor_username,
          u.avatar_key AS actor_avatar_key
     FROM ${notifications} n
     LEFT JOIN ${users} u ON u.id = n.actor_id
    WHERE n.recipient_id = ?
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT ? OFFSET ?`

  const rows = await db
    .prepare(sql)
    .bind(recipientId, options.limit, options.offset)
    .all<NotificationListRow>()

  return rows.results
}

export async function countUnreadNotifications(
  db: D1Database,
  prefix: string,
  recipientId: number
): Promise<number> {
  const table = notificationsTable(prefix)
  const sql = `SELECT COUNT(*) AS count
     FROM ${table}
    WHERE recipient_id = ? AND read_at IS NULL`

  const row = await db.prepare(sql).bind(recipientId).first<{ count: number }>()
  return row?.count ?? 0
}

export async function findNotificationById(
  db: D1Database,
  prefix: string,
  id: number
): Promise<NotificationRow | null> {
  const table = notificationsTable(prefix)
  const sql = `SELECT id, recipient_id, actor_id, type, page_id, comment_id,
          page_title, excerpt, created_at, read_at
     FROM ${table}
    WHERE id = ?`

  return db.prepare(sql).bind(id).first<NotificationRow>()
}

export async function markNotificationRead(
  db: D1Database,
  prefix: string,
  id: number,
  recipientId: number,
  readAt: string
): Promise<boolean> {
  const table = notificationsTable(prefix)
  const sql = `UPDATE ${table}
      SET read_at = COALESCE(read_at, ?)
    WHERE id = ? AND recipient_id = ?`

  const res = await db.prepare(sql).bind(readAt, id, recipientId).run()
  return (res.meta.changes ?? 0) > 0
}

export async function markAllNotificationsRead(
  db: D1Database,
  prefix: string,
  recipientId: number,
  readAt: string
): Promise<number> {
  const table = notificationsTable(prefix)
  const sql = `UPDATE ${table}
      SET read_at = ?
    WHERE recipient_id = ? AND read_at IS NULL`

  const res = await db.prepare(sql).bind(readAt, recipientId).run()
  return res.meta.changes ?? 0
}
