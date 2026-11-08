/**
 * schema_v4 的结构补齐与存量回填（空间模型）。
 *
 * SQLite 没有 `ADD COLUMN IF NOT EXISTS`，`pages.space_id` 只能先 `PRAGMA
 * table_info` 判断再补；默认空间与成员关系用 `INSERT OR IGNORE`，页面回填只写
 * `space_id` 仍为空的行，因此整个 prepare 可重复执行、失败后可从断点续跑。
 *
 * DDL 语句是本文件的唯一真源：migrations.ts 的 schema_v4 正文由同一批语句拼装，
 * 所以账本里记录的 SQL 与 prepare 实际执行的 DDL 不会漂移。
 */
import {
  pagesTable,
  spaceMembersTable,
  spacesTable,
  usersTable
} from "./tables"

/** 默认空间的固定 id：迁移建它、导入缺省落它、删除守卫保护它。 */
export const DEFAULT_SPACE_ID = "space-default"

export const DEFAULT_SPACE_NAME = "默认空间"

/** 迁移正文与 prepare 共用的 DDL（`{prefix}` 由各自渲染）。 */
export const SPACE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS {prefix}spaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS {prefix}space_members (
  space_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, user_id)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS {prefix}spaces_is_default
  ON {prefix}spaces(is_default) WHERE is_default = 1`,
  `CREATE INDEX IF NOT EXISTS {prefix}space_members_user_id
  ON {prefix}space_members(user_id)`,
  `CREATE INDEX IF NOT EXISTS {prefix}pages_space_parent_sort
  ON {prefix}pages(space_id, parent_id, sort_order)`,
  `CREATE INDEX IF NOT EXISTS {prefix}pages_space_deleted
  ON {prefix}pages(space_id, deleted_at)`
]

function render(statement: string, prefix: string): string {
  return statement.replaceAll("{prefix}", prefix)
}

/** 全部空间 DDL（已渲染），prepare 与迁移正文共用。 */
export function spaceSchemaStatements(prefix: string): string[] {
  return SPACE_SCHEMA_STATEMENTS.map((statement) => render(statement, prefix))
}

interface ColumnRow {
  name: string
}

/**
 * 补 `pages.space_id`、建默认空间、回填页面与成员。可重复执行，绝不覆盖既有值。
 */
export async function prepareSpaceSchema(
  db: D1Database,
  prefix: string
): Promise<void> {
  const pages = pagesTable(prefix)

  const columns = await db
    .prepare(`PRAGMA table_info(${pages})`)
    .all<ColumnRow>()
  if (columns.results.length === 0) {
    throw new Error(`migration schema_v4 requires table ${pages}`)
  }
  const hasSpaceId = columns.results.some(
    (column) => column.name === "space_id"
  )

  // 先补列：DDL 里的 pages 空间索引引用 space_id，必须在建索引之前存在。
  if (!hasSpaceId) {
    await db
      .prepare(
        `ALTER TABLE ${pages} ADD COLUMN space_id TEXT NOT NULL DEFAULT ''`
      )
      .run()
  }

  // 建表/索引供默认空间与成员关系落点；SQL 正文随后再跑一遍同样的 DDL（幂等）。
  for (const statement of spaceSchemaStatements(prefix)) {
    await db.prepare(statement).run()
  }

  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT OR IGNORE INTO ${spacesTable(prefix)}
        (id, name, description, is_default, created_by, created_at, updated_at)
       VALUES (?, ?, '', 1,
         COALESCE((SELECT id FROM ${usersTable(prefix)}
                    WHERE role = 'admin' ORDER BY rowid LIMIT 1), ''),
         ?, ?)`
    )
    .bind(DEFAULT_SPACE_ID, DEFAULT_SPACE_NAME, now, now)
    .run()

  // 以实际标记为准（而不是写死常量），即使默认空间曾被人工改 id 也能正确回填。
  const defaultSpace = await db
    .prepare(
      `SELECT id FROM ${spacesTable(prefix)} WHERE is_default = 1 LIMIT 1`
    )
    .first<{ id: string }>()
  const defaultSpaceId = defaultSpace?.id ?? DEFAULT_SPACE_ID

  await db
    .prepare(
      `UPDATE ${pages} SET space_id = ?
        WHERE space_id IS NULL OR space_id = ''`
    )
    .bind(defaultSpaceId)
    .run()

  await db
    .prepare(
      `INSERT OR IGNORE INTO ${spaceMembersTable(prefix)}
        (space_id, user_id, role, created_at)
       SELECT ?, id,
              CASE WHEN role = 'admin' THEN 'admin' ELSE 'editor' END,
              ?
         FROM ${usersTable(prefix)}`
    )
    .bind(defaultSpaceId, now)
    .run()
}
