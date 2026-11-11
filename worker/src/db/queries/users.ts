import { usersTable } from "../../lib/tables"

export interface UserRow {
  /** 整数自增主键；对外身份是 `username`，内部引用一律用这个数字。 */
  id: number
  email: string
  password_hash: string
  username: string
  avatar_key: string
  role: "admin" | "user"
  is_active: number
  approval_status: "pending" | "approved" | "rejected"
  email_verified: number
  base_currency: string
  timezone: string
  language: string
  theme: string
  created_at: string
  updated_at: string
}

/**
 * 注册：用户表为空时首个用户是 admin、直接批准并激活；否则按审批开关落
 * pending 或直接批准。单条语句判定“是否首个用户”，避免并发下出现两个管理员。
 *
 * 返回新用户的整数 id（`meta.last_row_id`），调用方不必再查一次。
 */
export async function createUserFirstIsAdmin(
  db: D1Database,
  prefix: string,
  data: {
    email: string
    username: string
    password_hash: string
    approvalStatus: "pending" | "approved"
  }
): Promise<number> {
  const table = usersTable(prefix)
  const now = new Date().toISOString()
  const active = data.approvalStatus === "approved" ? 1 : 0
  const result = await db
    .prepare(
      `INSERT INTO ${table}
        (email, username, password_hash, role, is_active, approval_status, email_verified, base_currency, timezone, language, theme, created_at, updated_at)
       SELECT ?, ?, ?,
         CASE WHEN (SELECT COUNT(*) FROM ${table}) = 0 THEN 'admin' ELSE 'user' END,
         CASE WHEN (SELECT COUNT(*) FROM ${table}) = 0 THEN 1 ELSE ? END,
         CASE WHEN (SELECT COUNT(*) FROM ${table}) = 0 THEN 'approved' ELSE ? END,
         0, 'CNY', 'UTC', 'zh', 'system', ?, ?`
    )
    .bind(
      data.email,
      data.username,
      data.password_hash,
      active,
      data.approvalStatus,
      now,
      now
    )
    .run()
  return result.meta.last_row_id
}

/** 管理员直接建号：强制已批准、已激活。返回新用户的整数 id。 */
export async function createApprovedUser(
  db: D1Database,
  prefix: string,
  data: {
    email: string
    username: string
    password_hash: string
    role: "admin" | "user"
  }
): Promise<number> {
  const now = new Date().toISOString()
  const result = await db
    .prepare(
      `INSERT INTO ${usersTable(prefix)}
        (email, username, password_hash, role, is_active, approval_status, email_verified, base_currency, timezone, language, theme, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 'approved', 0, 'CNY', 'UTC', 'zh', 'system', ?, ?)`
    )
    .bind(data.email, data.username, data.password_hash, data.role, now, now)
    .run()
  return result.meta.last_row_id
}

export async function findUserByEmail(
  db: D1Database,
  prefix: string,
  email: string
): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT * FROM ${usersTable(prefix)} WHERE email = ? COLLATE NOCASE`
    )
    .bind(email.trim())
    .first<UserRow>()
}

export async function findUserById(
  db: D1Database,
  prefix: string,
  id: number
): Promise<UserRow | null> {
  return db
    .prepare(`SELECT * FROM ${usersTable(prefix)} WHERE id = ?`)
    .bind(id)
    .first<UserRow>()
}

const UPDATABLE = new Set([
  "email",
  "password_hash",
  "is_active",
  "approval_status",
  "role",
  "username",
  "avatar_key"
])

export async function updateUser(
  db: D1Database,
  prefix: string,
  id: number,
  data: Record<string, unknown>
): Promise<void> {
  const entries = Object.entries(data).filter(([col]) => UPDATABLE.has(col))
  if (entries.length === 0) return
  const now = new Date().toISOString()
  const setClauses = entries.map(([col]) => `${col} = ?`).join(", ")
  await db
    .prepare(
      `UPDATE ${usersTable(prefix)} SET ${setClauses}, updated_at = ? WHERE id = ?`
    )
    .bind(...entries.map(([, value]) => value), now, id)
    .run()
}

export async function listUsers(
  db: D1Database,
  prefix: string
): Promise<UserRow[]> {
  const rows = await db
    .prepare(`SELECT * FROM ${usersTable(prefix)} ORDER BY created_at DESC`)
    .all<UserRow>()
  return rows.results
}

export async function countUsers(
  db: D1Database,
  prefix: string
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM ${usersTable(prefix)}`)
    .first<{ count: number }>()
  return row?.count ?? 0
}

export async function deleteUser(
  db: D1Database,
  prefix: string,
  id: number
): Promise<void> {
  await db
    .prepare(`DELETE FROM ${usersTable(prefix)} WHERE id = ?`)
    .bind(id)
    .run()
}
