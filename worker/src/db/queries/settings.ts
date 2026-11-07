import { settingsTable } from "../../lib/tables"

export async function getSetting(
  db: D1Database,
  prefix: string,
  key: string
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM ${settingsTable(prefix)} WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>()
  return row?.value ?? null
}

export async function setSetting(
  db: D1Database,
  prefix: string,
  key: string,
  value: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ${settingsTable(prefix)} (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value, new Date().toISOString())
    .run()
}

export async function getAllSettings(
  db: D1Database,
  prefix: string
): Promise<Record<string, string>> {
  const rows = await db
    .prepare(`SELECT key, value FROM ${settingsTable(prefix)}`)
    .all<{ key: string; value: string }>()
  return Object.fromEntries(rows.results.map((row) => [row.key, row.value]))
}

/** 布尔设置：缺省（未播种/表不存在时由调用方兜底）返回 fallback。 */
export async function getBooleanSetting(
  db: D1Database,
  prefix: string,
  key: string,
  fallback: boolean
): Promise<boolean> {
  const value = await getSetting(db, prefix, key)
  if (value === null) return fallback
  return value === "true"
}
