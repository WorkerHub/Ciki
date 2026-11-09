/**
 * 账本式迁移执行器：每个迁移只执行一次，失败可见（不吞错）。
 *
 * 表名一律经 tables.ts 的 migrationsTable() 解析；账本本身也属于本项目
 * （带 TABLE_PREFIX），换前缀即换一套账本。账本名自规格 §4.4 起带前导下划线
 * （`_<前缀>schema_migrations`），旧版无下划线的账本由 ensureLedgerTable() 改名承接。
 */
import { getMigrations } from "./migrations"
import { legacyMigrationsTable, migrationsTable } from "./tables"

export type LedgerMigrationStatus = "applied" | "skipped"

export interface LedgerMigrationResult {
  name: string
  status: LedgerMigrationStatus
}

/**
 * 账本处置只能中止、不能猜的异常（规格 §4.4）：新旧账本同时存在，或旧账本
 * 不是 ciki 的账本结构（不敢改名别人的表）。
 *
 * setup 层把它转成 409 汇报；执行器绝不自行合并、删除或覆盖其中任何一张。
 */
export class LedgerConflictError extends Error {
  /** 涉及的表名（新账本在前，旧账本在后）。 */
  readonly ledgers: string[]

  constructor(message: string, ledgers: string[]) {
    super(message)
    this.name = "LedgerConflictError"
    this.ledgers = ledgers
  }
}

async function tableExists(db: D1Database, name: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .bind(name)
    .first<{ name: string }>()
  return row !== null
}

/** 旧账本必须是本执行器建出的形状（至少要有 name 列），否则不敢改名。 */
async function hasLedgerShape(db: D1Database, table: string): Promise<boolean> {
  const columns = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>()
  return columns.results.some((column) => column.name === "name")
}

/**
 * 备好账本表（幂等），返回生效的账本表名。
 *
 * 规格 §4.4 的三种情形：
 * - 新账本在、旧账本不在 → 直接用新账本（新建的库与已承接完成的库都走这里）；
 * - 新账本不在、旧账本在 → `ALTER TABLE … RENAME TO …` 改名承接，已应用记录
 *   原地保留，之后照常跑迁移（全部 skipped）；
 * - 两者都不在 → 按现行 DDL 新建新账本。
 *
 * 改名后旧表名消失，之后的 setup 都命中第一种情形（那条 CREATE IF NOT EXISTS 是幂等空操作），
 * 所以改名只发生一次、记录不会丢。新旧同存或旧账本结构不符时抛
 * LedgerConflictError 中止，一个表都不动。
 */
export async function ensureLedgerTable(
  db: D1Database,
  prefix: string
): Promise<string> {
  const ledger = migrationsTable(prefix)
  const legacy = legacyMigrationsTable(prefix)
  const ledgerExists = await tableExists(db, ledger)
  const legacyExists = await tableExists(db, legacy)

  // 新旧同存：不猜哪一份是权威，一个都不动。
  if (ledgerExists && legacyExists) {
    throw new LedgerConflictError(
      `Migration ledger conflict: both "${ledger}" and the legacy ledger "${legacy}" exist. ` +
        `Setup will not merge or delete either one; keep exactly one (normally the ` +
        `"_"-less legacy table is the stale copy after a failed rename), then run setup again.`,
      [ledger, legacy]
    )
  }

  if (legacyExists) {
    // 旧账本不是本执行器建出的形状就不改名：宁可按冲突中止，也不碰别人的表。
    if (!(await hasLedgerShape(db, legacy))) {
      throw new LedgerConflictError(
        `Migration ledger conflict: legacy table "${legacy}" exists but has no "name" column, ` +
          `so it is not a ciki migration ledger and will not be renamed. ` +
          `Rename or remove it by hand, then run setup again.`,
        [ledger, legacy]
      )
    }
    // 存量承接：旧账本改名到新表名，已应用记录随表一起搬过去。
    await db.prepare(`ALTER TABLE ${legacy} RENAME TO ${ledger}`).run()
    console.info(`Migration ledger adopted: ${legacy} -> ${ledger}`)
    return ledger
  }

  // 新旧都不在：按现行 DDL 新建；新账本已在时这条 CREATE 也只是幂等空操作。
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${ledger} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))`
    )
    .run()
  return ledger
}

/** 按 `;` 切分成可单独执行的语句。 */
export function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function migrationError(name: string, err: unknown): Error {
  const reason = err instanceof Error ? err.message : String(err)
  return new Error(`Migration "${name}" failed: ${reason}`, { cause: err })
}

/**
 * 执行所有未记账的迁移。每条迁移按「prepare → sql → 记账」执行，三阶段全部成功
 * 才记账；失败立即抛出，不记录该迁移、也不继续后续迁移（下次 setup 会重跑它，
 * 各阶段都是幂等的）。
 */
export async function runLedgerMigrations(
  db: D1Database,
  prefix: string
): Promise<LedgerMigrationResult[]> {
  const ledger = await ensureLedgerTable(db, prefix)

  const recorded = await db
    .prepare(`SELECT name FROM ${ledger}`)
    .all<{ name: string }>()
  const applied = new Set(recorded.results.map((row) => row.name))

  const results: LedgerMigrationResult[] = []
  for (const migration of getMigrations(prefix)) {
    if (applied.has(migration.name)) {
      results.push({ name: migration.name, status: "skipped" })
      continue
    }
    try {
      if (migration.prepare) await migration.prepare(db, prefix)
      for (const statement of splitStatements(migration.sql)) {
        await db.prepare(statement).run()
      }
      await db
        .prepare(`INSERT INTO ${ledger} (name) VALUES (?)`)
        .bind(migration.name)
        .run()
    } catch (err) {
      throw migrationError(migration.name, err)
    }
    results.push({ name: migration.name, status: "applied" })
  }

  return results
}
