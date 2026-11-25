import {
  cleanUsername,
  isEmailConflict,
  isUsernameConflict,
  usernameWithSuffix
} from "../../core/identity"
import { DEFAULT_LANGUAGE, type Language } from "../../core/language"
import { usersTable } from "../../lib/tables"

export type UserKind = "human" | "agent"

export interface UserRow {
  /** 整数自增主键；对外身份是 `username`，内部引用一律用这个数字。 */
  id: number
  email: string
  password_hash: string
  username: string
  avatar_key: string
  bio?: string
  theme_style?: string
  role: "admin" | "user"
  is_active: number
  approval_status: "pending" | "approved" | "rejected"
  email_verified: number
  language: string
  kind: UserKind
  owner_user_id: number | null
  created_at: string
  updated_at: string
}

/**
 * 注册：用户表为空时首个用户是 admin、直接批准并激活，并且直接视为已验证邮箱
 * （首个管理员是站点的主人，不能因为没有 SMTP 就把自己锁在门外）；其余用户一律
 * 按 `emailVerificationRequired` 决定是否待验证。单条语句判定“是否首个用户”，避免
 * 并发下出现两个管理员。
 *
 * `language` 是界面语言（自助注册按注册页当前语言传入，缺省 `zh`）；管理员建号走
 * `createApprovedUser`，那里固定 `zh`（i18n 规格 §2.6），本单不给建号表单加语言项。
 *
 * 返回新用户的整数 id（`meta.last_row_id`）。
 */
export async function createUserFirstIsAdmin(
  db: D1Database,
  prefix: string,
  data: {
    email: string
    username: string
    password_hash: string
    approvalStatus: "pending" | "approved"
    language?: Language
    emailVerificationRequired: boolean
  }
): Promise<number> {
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
         CASE WHEN (SELECT COUNT(*) FROM ${table}) = 0 THEN 1
              WHEN ? = 1 THEN 0 ELSE 1 END,
         ?, ?, ?`
    )
    .bind(
      data.email,
      data.username,
      data.password_hash,
      active,
      data.approvalStatus,
      data.emailVerificationRequired ? 1 : 0,
      data.language ?? DEFAULT_LANGUAGE,
      now,
      now
    )
    .run()
  return result.meta.last_row_id
}

/**
 * 管理员直接建号：强制已批准、已激活、邮箱已验证，语言固定 `zh`（本单不给建号
 * 表单加语言项，新用户登录后自改）。返回新用户的整数 id。
 */
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

/** Agent 账号专用的无法比对成功的密码哈希标记。 */
export const AGENT_UNVERIFIABLE_PASSWORD_HASH = "!agent-unusable-hash"

/**
 * 创建 Agent 身份（Task #74）：
 * - kind 固定为 'agent'，role 固定为 'user'（禁止设为 admin）；
 * - owner_user_id 必须指向一个激活的人类用户（人类账号，is_active=1）；
 * - 账号默认处于激活（is_active=1）且已批准（approved）状态，邮箱已验证（email_verified=1）；
 * - 分配内部占位邮箱（未显式提供时推导自最终分配的 username，如 <username>@internal）与不可逆的密码哈希；
 * - 自动分配或使用提供的唯一用户名。
 */
export async function createAgentUser(
  db: D1Database,
  prefix: string,
  data: {
    owner_user_id: number
    username?: string
    email?: string
    avatar_key?: string
  }
): Promise<number> {
  const owner = await findUserById(db, prefix, data.owner_user_id)
  if (!owner) {
    throw new Error("Owner user not found")
  }
  if (owner.kind !== "human") {
    throw new Error("Owner must be a human user")
  }
  if (owner.is_active !== 1) {
    throw new Error("Owner must be an active user")
  }

  if (data.email) {
    const existing = await findUserByEmail(db, prefix, data.email)
    if (existing) {
      throw new Error("Email already taken")
    }
  }

  const uuid = crypto.randomUUID()
  const baseUsername = data.username?.trim()
    ? cleanUsername(data.username)
    : `agent-${uuid.slice(0, 8)}`
  const passwordHash = AGENT_UNVERIFIABLE_PASSWORD_HASH
  const now = new Date().toISOString()

  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = usernameWithSuffix(baseUsername, attempt)
    if (await usernameTaken(db, prefix, candidate)) continue
    const email = data.email ?? `${candidate}@internal`
    try {
      const result = await db
        .prepare(
          `INSERT INTO ${usersTable(prefix)}
            (email, username, password_hash, role, is_active, approval_status,
             email_verified, language, kind, owner_user_id, avatar_key, created_at, updated_at)
           VALUES (?, ?, ?, 'user', 1, 'approved', 1, ?, 'agent', ?, ?, ?, ?)`
        )
        .bind(
          email,
          candidate,
          passwordHash,
          owner.language ?? DEFAULT_LANGUAGE,
          owner.id,
          data.avatar_key ?? "",
          now,
          now
        )
        .run()
      return result.meta.last_row_id
    } catch (err) {
      if (isUsernameConflict(err)) continue
      if (!data.email && isEmailConflict(err)) continue
      throw err
    }
  }
  throw new Error("Could not allocate a unique username for agent")
}

/**
 * 长式 Agent 占位邮箱正则（Task #109 / 改动二）：
 * 匹配 agent-<36位uuid>@internal（严格 8-4-4-4-12 十六进制 uuid）
 */
export const LONG_AGENT_EMAIL_REGEX =
  /^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@internal$/

export interface RepairAgentEmailsResult {
  matchedCount: number
  updatedCount: number
  residualCount: number
}

/**
 * Agent 占位邮箱存量刷短：一次性数据修复（Task #109）
 * - 对象：仅 kind='agent' 且 email 为长式占位形态（匹配 agent-<36位uuid>@internal）的行；
 *   真人邮箱与任何非该形态的值一律不碰。
 * - 动作：逐行把 email 更新为 `<该行 username>@internal`。
 * - 幂等：可重复执行、第二遍为 no-op。
 * - 报数：执行前先报命中行数、执行后复查长式占位残留为 0 并回报实际更新行数。
 */
export async function repairAgentEmails(
  db: D1Database,
  prefix: string
): Promise<RepairAgentEmailsResult> {
  const table = usersTable(prefix)

  // 1. 扫描候选 agent 行
  const candidates = await db
    .prepare(`SELECT id, username, email FROM ${table} WHERE kind = 'agent'`)
    .all<{ id: number; username: string; email: string }>()

  // 严格匹配长式占位形态
  const targets = (candidates.results ?? []).filter(
    (row) => row.email && LONG_AGENT_EMAIL_REGEX.test(row.email)
  )
  const matchedCount = targets.length

  let updatedCount = 0
  if (targets.length > 0) {
    const statements = targets.map((row) =>
      db
        .prepare(
          `UPDATE ${table}
              SET email = ?
            WHERE id = ? AND kind = 'agent' AND email = ?`
        )
        .bind(`${row.username}@internal`, row.id, row.email)
    )

    for (let i = 0; i < statements.length; i += 50) {
      const chunk = statements.slice(i, i + 50)
      const batchResults = await db.batch(chunk)
      for (const res of batchResults) {
        updatedCount += res.meta.changes ?? 0
      }
    }
  }

  // 2. 复查长式占位残留
  const verifyRows = await db
    .prepare(`SELECT email FROM ${table} WHERE kind = 'agent'`)
    .all<{ email: string }>()

  const residualCount = (verifyRows.results ?? []).filter(
    (row) => row.email && LONG_AGENT_EMAIL_REGEX.test(row.email)
  ).length

  return {
    matchedCount,
    updatedCount,
    residualCount
  }
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

export interface UserAuthorSummary {
  id: number
  username: string
  avatar_key: string
  kind: UserKind
  owner_name: string | null
}

export async function findUsersByIds(
  db: D1Database,
  prefix: string,
  ids: number[]
): Promise<Map<number, UserAuthorSummary>> {
  const uniqueIds = Array.from(new Set(ids.filter((id) => id > 0)))
  if (uniqueIds.length === 0) return new Map()
  const placeholders = uniqueIds.map(() => "?").join(", ")
  const rows = await db
    .prepare(
      `SELECT u.id, u.username, u.avatar_key, u.kind,
              CASE WHEN u.kind = 'agent' THEN o.username ELSE NULL END AS owner_name
         FROM ${usersTable(prefix)} u
         LEFT JOIN ${usersTable(prefix)} o ON o.id = u.owner_user_id
        WHERE u.id IN (${placeholders})`
    )
    .bind(...uniqueIds)
    .all<UserAuthorSummary>()
  const map = new Map<number, UserAuthorSummary>()
  for (const row of rows.results) {
    map.set(row.id, row)
  }
  return map
}

/**
 * 用户名是否已被别人占用：大小写不敏感（与唯一索引的 COLLATE NOCASE 同口径），
 * 空串不参与唯一约束。`excludeUserId` 用于改名——改成自己当前的名字（含只改
 * 大小写）不算撞名。
 */
export async function usernameTaken(
  db: D1Database,
  prefix: string,
  username: string,
  excludeUserId = 0
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS taken FROM ${usersTable(prefix)}
        WHERE username <> '' AND username = ? COLLATE NOCASE AND id <> ?
        LIMIT 1`
    )
    .bind(username, excludeUserId)
    .first<{ taken: number }>()
  return row !== null
}

const UPDATABLE = new Set([
  "email",
  "password_hash",
  "is_active",
  "approval_status",
  "role",
  "username",
  "avatar_key",
  "language",
  "bio",
  "theme_style"
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

export async function listAgentsByOwner(
  db: D1Database,
  prefix: string,
  ownerUserId: number
): Promise<UserRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM ${usersTable(prefix)}
        WHERE kind = 'agent' AND owner_user_id = ?
        ORDER BY created_at ASC, id ASC`
    )
    .bind(ownerUserId)
    .all<UserRow>()
  return rows.results
}

export async function findAgentByOwner(
  db: D1Database,
  prefix: string,
  ownerUserId: number,
  agentId: number
): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT * FROM ${usersTable(prefix)}
        WHERE id = ? AND kind = 'agent' AND owner_user_id = ?`
    )
    .bind(agentId, ownerUserId)
    .first<UserRow>()
}
