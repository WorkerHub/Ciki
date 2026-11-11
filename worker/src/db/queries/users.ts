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
  language: string
  created_at: string
  updated_at: string
}

/**
 * 注册：用户表为空时首个用户是 admin、直接批准并激活，并且直接视为已验证邮箱
 * （首个管理员是站点的主人，不能因为没有 SMTP 就把自己锁在门外）；其余用户一律
 * `email_verified=0`，由注册邮箱验证流程置位。单条语句判定“是否首个用户”，避免
 * 并发下出现两个管理员。
 *
 * `requireEmptyTable` 把「只接受首个用户」也压进同一条语句（`WHERE` 里的 COUNT）：
 * 站点没配发信时调用方传 true，并发注册的第二个请求在写入那一刻就会发现表已非空、
 * 一行都不写（返回 null），由调用方回 503——不能靠插入前的 COUNT 预检，那个窗口里
 * 两个请求会都以为自己是第一个。
 *
 * 返回新用户的整数 id（`meta.last_row_id`）；被 `requireEmptyTable` 拦下时返回 null。
 */
export async function createUserFirstIsAdmin(
  db: D1Database,
  prefix: string,
  data: {
    email: string
    username: string
    password_hash: string
    approvalStatus: "pending" | "approved"
  },
  options: { requireEmptyTable?: boolean } = {}
): Promise<number | null> {
  const table = usersTable(prefix)
  const now = new Date().toISOString()
  const active = data.approvalStatus === "approved" ? 1 : 0
  const result = await db
    .prepare(
      `INSERT INTO ${table}
        (email, username, password_hash, role, is_active, approval_status, email_verified, language, created_at, updated_at)
       SELECT ?, ?, ?,
         CASE WHEN (SELECT COUNT(*) FROM ${table}) = 0 THEN 'admin' ELSE 'user' END,
         CASE WHEN (SELECT COUNT(*) FROM ${table}) = 0 THEN 1 ELSE ? END,
         CASE WHEN (SELECT COUNT(*) FROM ${table}) = 0 THEN 'approved' ELSE ? END,
         CASE WHEN (SELECT COUNT(*) FROM ${table}) = 0 THEN 1 ELSE 0 END,
         'zh', ?, ?
       WHERE ? = 0 OR (SELECT COUNT(*) FROM ${table}) = 0`
    )
    .bind(
      data.email,
      data.username,
      data.password_hash,
      active,
      data.approvalStatus,
      now,
      now,
      options.requireEmptyTable ? 1 : 0
    )
    .run()
  if (result.meta.changes === 0) return null
  return result.meta.last_row_id
}

/** 管理员直接建号：强制已批准、已激活、邮箱已验证。返回新用户的整数 id。 */
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
        (email, username, password_hash, role, is_active, approval_status, email_verified, language, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 'approved', 1, 'zh', ?, ?)`
    )
    .bind(data.email, data.username, data.password_hash, data.role, now, now)
    .run()
  return result.meta.last_row_id
}

/**
 * 注册邮箱验证成功：只置位、只在「还没验证」时生效（重复提交不会改写 updated_at）。
 * 返回是否真的改到了行。
 */
export async function markEmailVerified(
  db: D1Database,
  prefix: string,
  id: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE ${usersTable(prefix)}
          SET email_verified = 1, updated_at = ?
        WHERE id = ? AND email_verified = 0`
    )
    .bind(new Date().toISOString(), id)
    .run()
  return result.meta.changes === 1
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
