/**
 * schema_v3 的结构补齐与数据回填（只动 users 表）。
 *
 * SQLite 没有 `ADD COLUMN IF NOT EXISTS`，三列只能先 `PRAGMA table_info` 判断再
 * 逐列补；回填只写新列里仍然为空的值（`WHERE col = ''`），不触碰任何既有数据，
 * 所以既能重复执行，也能在失败后从断点续跑（账本只在整个迁移成功后记账）。
 */
import { defaultUsernameFromEmail, generatePublicId } from "../core/identity"
import { usersTable } from "./tables"

const IDENTITY_COLUMNS: Array<[name: string, definition: string]> = [
  ["username", "TEXT NOT NULL DEFAULT ''"],
  ["public_id", "TEXT NOT NULL DEFAULT ''"],
  ["avatar_key", "TEXT NOT NULL DEFAULT ''"]
]

interface IdentityRow {
  id: string
  email: string
  username: string
  public_id: string
}

/** 补齐 users 的身份列并回填存量行。可重复执行，绝不覆盖已有值。 */
export async function prepareIdentitySchema(
  db: D1Database,
  prefix: string
): Promise<void> {
  const table = usersTable(prefix)

  const columns = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>()
  if (columns.results.length === 0) {
    throw new Error(`migration schema_v3 requires table ${table}`)
  }

  const present = new Set(columns.results.map((column) => column.name))
  for (const [name, definition] of IDENTITY_COLUMNS) {
    if (present.has(name)) continue
    await db
      .prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
      .run()
  }

  const rows = await db
    .prepare(`SELECT id, email, username, public_id FROM ${table}`)
    .all<IdentityRow>()

  // public_id 的唯一索引在回填之后才建，这里先按库里已有的值去重。
  const taken = new Set(
    rows.results.map((row) => row.public_id).filter((value) => value !== "")
  )
  const statements: D1PreparedStatement[] = []
  for (const row of rows.results) {
    if (!row.username) {
      statements.push(
        db
          .prepare(
            `UPDATE ${table} SET username = ? WHERE id = ? AND username = ''`
          )
          .bind(defaultUsernameFromEmail(row.email), row.id)
      )
    }
    if (!row.public_id) {
      let candidate = generatePublicId()
      while (taken.has(candidate)) candidate = generatePublicId()
      taken.add(candidate)
      statements.push(
        db
          .prepare(
            `UPDATE ${table} SET public_id = ? WHERE id = ? AND public_id = ''`
          )
          .bind(candidate, row.id)
      )
    }
  }
  if (statements.length > 0) await db.batch(statements)
}
