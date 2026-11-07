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
 * 判定标准：同一前缀下 `users` 与 `pages` 同时存在；孤立同名表不算。
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
    if (present.has(pagesTable(prefix))) detected.add(prefix)
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

/**
 * 只读前缀冲突探测：库里已在另一个前缀下初始化时返回冲突信息。
 * setup 路由在限流（会建计数表）之前先调它，保证冲突时一个表都不写。
 */
export async function findForeignPrefixConflict(
  env: Env
): Promise<{ resolvedPrefix: string; detectedPrefixes: string[] } | null> {
  const prefix = getTablePrefix(env)
  const detected = [...detectTablePrefixes(await listTables(env.DB))].sort()
  if (detected.length > 0 && !detected.includes(prefix)) {
    return { resolvedPrefix: prefix, detectedPrefixes: detected }
  }
  return null
}

function prefixConflict(
  resolvedPrefix: string,
  detectedPrefixes: string[]
): SetupResult {
  const error =
    `TABLE_PREFIX mismatch: this database is already initialized under a different ` +
    `table prefix (detected: ${detectedPrefixes.join(", ")}), but TABLE_PREFIX resolves to ` +
    `"${resolvedPrefix}". Set TABLE_PREFIX explicitly to keep the existing tables, or migrate ` +
    `the tables to the new prefix before retrying setup.`
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
    return prefixConflict(conflict.resolvedPrefix, conflict.detectedPrefixes)
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
