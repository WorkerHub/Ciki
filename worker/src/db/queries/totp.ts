import { user2faTable } from "../../lib/tables"

export interface TotpRow {
  user_id: string
  totp_secret: string | null
  totp_enabled: number
  updated_at: string
}

export async function getTotp(
  db: D1Database,
  prefix: string,
  userId: string
): Promise<TotpRow | null> {
  return db
    .prepare(`SELECT * FROM ${user2faTable(prefix)} WHERE user_id = ?`)
    .bind(userId)
    .first<TotpRow>()
}

export async function upsertTotp(
  db: D1Database,
  prefix: string,
  userId: string,
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

export async function deleteTotp(
  db: D1Database,
  prefix: string,
  userId: string
): Promise<void> {
  await db
    .prepare(`DELETE FROM ${user2faTable(prefix)} WHERE user_id = ?`)
    .bind(userId)
    .run()
}
