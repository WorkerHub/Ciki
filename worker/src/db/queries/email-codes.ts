/**
 * 邮箱验证码的数据层（#48 契约第 4/5 条）。
 *
 * - 一个 `(user_id, purpose, binding)` 只保留最新一枚码：重发直接 UPSERT 覆盖，
 *   旧码立即作废；每次发码顺带清掉已过期的行。
 * - 库内只有 `code_hash`，不存明文码；`attempts` 用 SQL 原子自增，第 5 次错误
 *   由 `incrementEmailCodeAttempts` 删除该行。
 * - 成功校验用一条带全部条件的 DELETE 原子消费：并发下只有一个请求能删到行，
 *   `meta.changes=1` 才算成功。
 */
import { emailCodesTable } from "../../lib/tables"

/** 验证码用途（#48 契约固定三种）。 */
export type EmailCodePurpose = "password_reset" | "2fa_login" | "2fa_enable"

export const EMAIL_CODE_PURPOSES: readonly EmailCodePurpose[] = [
  "password_reset",
  "2fa_login",
  "2fa_enable"
]

export interface EmailCodeKey {
  userId: number
  purpose: EmailCodePurpose
  /** `2fa_login` 为 `SHA-256(tempToken)`；`password_reset` / `2fa_enable` 为空串。 */
  binding?: string
}

export interface EmailCodeRow {
  user_id: number
  purpose: EmailCodePurpose
  binding: string
  code_hash: string
  attempts: number
  created_at: number
  expires_at: number
}

function bindingOf(key: EmailCodeKey): string {
  return key.binding ?? ""
}

export async function getEmailCode(
  db: D1Database,
  prefix: string,
  key: EmailCodeKey
): Promise<EmailCodeRow | null> {
  return db
    .prepare(
      `SELECT user_id, purpose, binding, code_hash, attempts, created_at, expires_at
         FROM ${emailCodesTable(prefix)}
        WHERE user_id = ? AND purpose = ? AND binding = ?`
    )
    .bind(key.userId, key.purpose, bindingOf(key))
    .first<EmailCodeRow>()
}

/** 写入（或覆盖）一枚验证码，并顺带清掉所有已过期的验证码行。 */
export async function putEmailCode(
  db: D1Database,
  prefix: string,
  row: {
    userId: number
    purpose: EmailCodePurpose
    binding?: string
    codeHash: string
    createdAt: number
    expiresAt: number
  }
): Promise<void> {
  const table = emailCodesTable(prefix)
  await db.batch([
    db.prepare(`DELETE FROM ${table} WHERE expires_at < ?`).bind(row.createdAt),
    db
      .prepare(
        `INSERT INTO ${table}
          (user_id, purpose, binding, code_hash, attempts, created_at, expires_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(user_id, purpose, binding) DO UPDATE SET
           code_hash = excluded.code_hash,
           attempts = 0,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`
      )
      .bind(
        row.userId,
        row.purpose,
        row.binding ?? "",
        row.codeHash,
        row.createdAt,
        row.expiresAt
      )
  ])
}

/**
 * 原子消费：所有条件同时满足才删到行。返回 true 表示本次请求拿到了这枚码
 * （并发重放时只有一个请求能拿到）。
 */
export async function deleteEmailCodeIfMatches(
  db: D1Database,
  prefix: string,
  key: EmailCodeKey & {
    codeHash: string
    now: number
    maxAttempts: number
  }
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM ${emailCodesTable(prefix)}
        WHERE user_id = ? AND purpose = ? AND binding = ?
          AND code_hash = ? AND expires_at > ? AND attempts < ?`
    )
    .bind(
      key.userId,
      key.purpose,
      bindingOf(key),
      key.codeHash,
      key.now,
      key.maxAttempts
    )
    .run()
  return result.meta.changes === 1
}

/**
 * 错误一次：`attempts + 1`；达到 `maxAttempts` 就删除该行（再试也没有意义）。
 * 两条语句放在同一批里，避免“加了计数但没删除”的半截状态。
 */
export async function incrementEmailCodeAttempts(
  db: D1Database,
  prefix: string,
  key: EmailCodeKey & { maxAttempts: number }
): Promise<void> {
  const table = emailCodesTable(prefix)
  await db.batch([
    db
      .prepare(
        `UPDATE ${table} SET attempts = attempts + 1
          WHERE user_id = ? AND purpose = ? AND binding = ?`
      )
      .bind(key.userId, key.purpose, bindingOf(key)),
    db
      .prepare(
        `DELETE FROM ${table}
          WHERE user_id = ? AND purpose = ? AND binding = ? AND attempts >= ?`
      )
      .bind(key.userId, key.purpose, bindingOf(key), key.maxAttempts)
  ])
}

/** 删除某用户的全部验证码；传 purpose 时只删该用途（如启用邮箱 2FA 前清旧码）。 */
export async function deleteUserEmailCodes(
  db: D1Database,
  prefix: string,
  userId: number,
  purpose?: EmailCodePurpose
): Promise<void> {
  const table = emailCodesTable(prefix)
  if (purpose) {
    await db
      .prepare(`DELETE FROM ${table} WHERE user_id = ? AND purpose = ?`)
      .bind(userId, purpose)
      .run()
    return
  }
  await db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId).run()
}
