import { passkeysTable } from "../../lib/tables"

export interface PasskeyRow {
  id: string
  user_id: string
  credential_id: string
  public_key: string
  counter: number
  transports: string
  created_at: string
  last_used_at: string | null
}

export async function listPasskeys(
  db: D1Database,
  prefix: string,
  userId: string
): Promise<PasskeyRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM ${passkeysTable(prefix)} WHERE user_id = ? ORDER BY created_at`
    )
    .bind(userId)
    .all<PasskeyRow>()
  return rows.results
}

export async function countPasskeys(
  db: D1Database,
  prefix: string,
  userId: string
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${passkeysTable(prefix)} WHERE user_id = ?`
    )
    .bind(userId)
    .first<{ count: number }>()
  return row?.count ?? 0
}

export async function findPasskeyByCredentialId(
  db: D1Database,
  prefix: string,
  credentialId: string
): Promise<PasskeyRow | null> {
  return db
    .prepare(`SELECT * FROM ${passkeysTable(prefix)} WHERE credential_id = ?`)
    .bind(credentialId)
    .first<PasskeyRow>()
}

export async function insertPasskey(
  db: D1Database,
  prefix: string,
  data: {
    id: string
    userId: string
    credentialId: string
    publicKey: string
    counter: number
    transports: string
  }
): Promise<void> {
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO ${passkeysTable(prefix)}
        (id, user_id, credential_id, public_key, counter, transports, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .bind(
      data.id,
      data.userId,
      data.credentialId,
      data.publicKey,
      data.counter,
      data.transports,
      now
    )
    .run()
}

export async function updatePasskeyCounter(
  db: D1Database,
  prefix: string,
  id: string,
  counter: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE ${passkeysTable(prefix)} SET counter = ?, last_used_at = ? WHERE id = ?`
    )
    .bind(counter, new Date().toISOString(), id)
    .run()
}

export async function deletePasskey(
  db: D1Database,
  prefix: string,
  userId: string,
  credentialId: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM ${passkeysTable(prefix)} WHERE user_id = ? AND credential_id = ?`
    )
    .bind(userId, credentialId)
    .run()
  return result.meta.changes > 0
}

export async function deleteUserPasskeys(
  db: D1Database,
  prefix: string,
  userId: string
): Promise<void> {
  await db
    .prepare(`DELETE FROM ${passkeysTable(prefix)} WHERE user_id = ?`)
    .bind(userId)
    .run()
}
