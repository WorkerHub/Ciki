import { user2faTable } from "../../lib/tables"

export interface TotpRow {
  user_id: number
  totp_secret: string | null
  totp_enabled: number
  email_otp_enabled: number
  updated_at: string
}

export async function getTotp(
  db: D1Database,
  prefix: string,
  userId: number
): Promise<TotpRow | null> {
  return db
    .prepare(`SELECT * FROM ${user2faTable(prefix)} WHERE user_id = ?`)
    .bind(userId)
    .first<TotpRow>()
}

export async function upsertTotp(
  db: D1Database,
  prefix: string,
  userId: number,
  data: { totp_secret: string | null; totp_enabled: number }
): Promise<void> {
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO ${user2faTable(prefix)} (user_id, totp_secret, totp_enabled, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         totp_secret = excluded.totp_secret,
         totp_enabled = excluded.totp_enabled,
         updated_at = excluded.updated_at`
    )
    .bind(userId, data.totp_secret, data.totp_enabled, now)
    .run()
}

/**
 * 只改邮箱验证码开关：INSERT … ON CONFLICT 里不回写 `totp_secret` / `totp_enabled`，
 * 所以启用或停用邮箱 2FA 不会动到已有的 TOTP 配置（两列互不干扰）。
 */
export async function setEmailOtpEnabled(
  db: D1Database,
  prefix: string,
  userId: number,
  enabled: boolean
): Promise<void> {
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO ${user2faTable(prefix)} (user_id, email_otp_enabled, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         email_otp_enabled = excluded.email_otp_enabled,
         updated_at = excluded.updated_at`
    )
    .bind(userId, enabled ? 1 : 0, now)
    .run()
}

export async function deleteTotp(
  db: D1Database,
  prefix: string,
  userId: number
): Promise<void> {
  await db
    .prepare(`DELETE FROM ${user2faTable(prefix)} WHERE user_id = ?`)
    .bind(userId)
    .run()
}
