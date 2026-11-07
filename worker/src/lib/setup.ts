/**
 * setup / 数据库维护：初始化与升级的唯一入口（规格 §5A.6、§8）。
 *
 * 语义：
 * - 前缀冲突守卫先跑：库里已在**另一个**前缀下存在本项目的 users+pages 时，
 *   409 中止，绝不在新前缀下另建第二套空表。
 * - 已初始化再走一遍只做幂等迁移（全部 skipped）与缺失默认设置的补齐。
 * - 首次初始化播种默认设置，其中 setup_page_enabled=0 即“初始化完成显式写关”
 *   （只门控页面，不门控 X-Setup-Secret 接口）。
 */
import { getTablePrefix } from "./table-prefix"
import {
  migrationsTable,
  pagesFtsTable,
  pagesTable,
  settingsTable,
  usersTable
} from "./tables"
import {
  runLedgerMigrations,
  type LedgerMigrationResult
} from "./migrations-runner"
import type { Env } from "../types"

export type SetupResult =
  | {
      success: true
      tablePrefix: string
      migrations: LedgerMigrationResult[]
    }
  | {
      success: false
      code: "PREFIX_CONFLICT"
      error: string
      resolvedPrefix: string
      detectedPrefixes: string[]
    }

/** 初始化完成后写入的站点设置默认值（INSERT OR IGNORE，不覆盖已有值）。 */
export const DEFAULT_SETTINGS: Record<string, string> = {
  setup_page_enabled: "0",
  registration_enabled: "true",
  registration_approval_required: "true",
  require_2fa: "false"
}

/**
 * 从 sqlite_master 的表名里识别“本项目已初始化的前缀”。
 *
 * 判定依据是 ciki 专属的三件套：同一前缀下 `users` + `pages` +
 * `pages_fts`（FTS5 虚拟表，其他项目基本不会同名同前缀地凑齐）。只看
 * users+pages 会在共享 workerhub 库里误伤其他项目，也挡不住误判。
 */
export function detectTablePrefixes(tableNames: string[]): Set<string> {
  const present = new Set(tableNames)
  const candidates = new Set<string>()
  for (const name of present) {
    if (name === "users") candidates.add("")
    else if (name.endsWith("_users")) {
      candidates.add(name.slice(0, -"users".length))
    }
  }
  const detected = new Set<string>()
  for (const prefix of candidates) {
    if (present.has(pagesTable(prefix)) && present.has(pagesFtsTable(prefix))) {
      detected.add(prefix)
    }
  }
  return detected
}

async function listTables(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all<{ name: string }>()
  return rows.results.map((row) => row.name)
}

/** 是否已初始化：本项目（当前前缀）的 system_settings 表存在。 */
export async function isInitialized(
  db: D1Database,
  prefix: string
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .bind(settingsTable(prefix))
    .first<{ name: string }>()
  return row !== null
}

async function seedDefaultSettings(
  db: D1Database,
  prefix: string
): Promise<void> {
  const now = new Date().toISOString()
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO ${settingsTable(prefix)} (key, value, updated_at) VALUES (?, ?, ?)`
      )
      .bind(key, value, now)
      .run()
  }
}

export type SetupConflict = {
  resolvedPrefix: string
  detectedPrefixes: string[]
  reason: "foreign-prefix" | "table-collision"
}

/**
 * 当前前缀下若已有一张不是 ciki 结构的 users 表，迁移里的
 * `CREATE TABLE IF NOT EXISTS` 会静默复用它——按冲突处理，不动任何表。
 * 部分失败的本项目迁移（users 已有 ciki 列但缺 pages）不算冲突，可以续跑修复。
 */
async function hasForeignUsersTable(
  db: D1Database,
  prefix: string
): Promise<boolean> {
  const existing = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .bind(usersTable(prefix))
    .first<{ name: string }>()
  if (!existing) return false
  const pages = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .bind(pagesTable(prefix))
    .first<{ name: string }>()
  if (pages) return false
  const columns = await db
    .prepare(`PRAGMA table_info(${usersTable(prefix)})`)
    .all<{ name: string }>()
  const names = new Set(columns.results.map((column) => column.name))
  return !(
    names.has("password_hash") &&
    names.has("approval_status") &&
    names.has("role")
  )
}

/**
 * 只读前缀冲突探测：库里已在另一个前缀下初始化、或当前前缀被别人的同名表
 * 占用时返回冲突信息。setup 路由在限流（会建计数表）之前先调它，保证冲突时
 * 一个表都不写。
 */
export async function findForeignPrefixConflict(
  env: Env
): Promise<SetupConflict | null> {
  const prefix = getTablePrefix(env)
  const detected = [...detectTablePrefixes(await listTables(env.DB))].sort()
  if (detected.length > 0 && !detected.includes(prefix)) {
    return {
      resolvedPrefix: prefix,
      detectedPrefixes: detected,
      reason: "foreign-prefix"
    }
  }
  if (await hasForeignUsersTable(env.DB, prefix)) {
    return {
      resolvedPrefix: prefix,
      detectedPrefixes: [prefix],
      reason: "table-collision"
    }
  }
  return null
}

function prefixConflict(conflict: SetupConflict): SetupResult {
  const { resolvedPrefix, detectedPrefixes, reason } = conflict
  const error =
    reason === "table-collision"
      ? `TABLE_PREFIX collision: a table "${usersTable(resolvedPrefix)}" already exists ` +
        `but it is not ciki's schema (missing password_hash/approval_status/role), so ` +
        `CREATE TABLE IF NOT EXISTS would silently reuse it. Remove or rename that table, ` +
        `or choose another TABLE_PREFIX, then run setup again.`
      : `TABLE_PREFIX mismatch: this database is already initialized under a different ` +
        `table prefix (detected by users+pages+pages_fts: ${detectedPrefixes.join(", ")}), ` +
        `but TABLE_PREFIX resolves to "${resolvedPrefix}". Set TABLE_PREFIX explicitly to ` +
        `keep the existing tables, or migrate the tables to the new prefix before retrying setup.`
  return {
    success: false,
    code: "PREFIX_CONFLICT",
    error,
    resolvedPrefix,
    detectedPrefixes
  }
}

/** 初始化或升级当前前缀下的数据库。 */
export async function runSetup(env: Env): Promise<SetupResult> {
  const prefix = getTablePrefix(env)
  const db = env.DB

  const conflict = await findForeignPrefixConflict(env)
  if (conflict) {
    return prefixConflict(conflict)
  }

  const migrations = await runLedgerMigrations(db, prefix)
  await seedDefaultSettings(db, prefix)

  return { success: true, tablePrefix: prefix, migrations }
}

/** 供测试与 setup 状态查询使用：当前前缀是否已有业务表。 */
export async function hasBusinessTables(
  db: D1Database,
  prefix: string
): Promise<boolean> {
  const tables = await listTables(db)
  return (
    tables.includes(usersTable(prefix)) && tables.includes(pagesTable(prefix))
  )
}

/** 供测试断言账本确实建在当前前缀下。 */
export function ledgerName(prefix: string): string {
  return migrationsTable(prefix)
}
