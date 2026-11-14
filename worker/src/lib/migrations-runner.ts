/**
 * 账本式迁移执行器：每个迁移只执行一次，失败可见（不吞错）。
 *
 * 表名一律经 tables.ts 的 migrationsTable() 解析；账本本身也属于本项目
 * （带 TABLE_PREFIX），换前缀即换一套账本。账本名自规格 §4.4 起带前导下划线
 * （`_<前缀>schema_migrations`），旧版无下划线的账本由 ensureLedgerTable() 改名承接。
 *
 * 一条迁移的执行口径固定为「prepare → sql → 记账」：三阶段全部成功才记账，失败立
 * 即抛出、不记账也不继续后续迁移（下次 setup 重跑，各阶段都必须幂等）。迁移可以用
 * `supersedes` 声明自己取代的旧账本记录，此时记账是「删旧行 + 写本行」的单次
 * `db.batch()`（D1 的事务单位）：要么账本整体收敛，要么一行不动，重跑结果一致。
 */
import { getMigrations } from "./migrations"
import type { Migration, MigrationContext } from "./migrations"
import { DEFAULT_LANGUAGE, type Language } from "../core/language"
import { MigrationRejectedError } from "./schema-shape"
import { getTablePrefix } from "./table-prefix"
import { legacyMigrationsTable, migrationsTable } from "./tables"
import type { Env } from "../types"

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
 * 记账：`supersedes` 非空时把「本条自己的旧同名行 + 被取代的旧行」与本条记账放进
 * 同一个 `db.batch()`（D1 的事务单位）——账本只会整体收敛，中断后重跑不会留下
 * 半截记录。没有 `supersedes` 就是一条普通 INSERT（本条此前没记过账）。
 */
async function recordMigration(
  db: D1Database,
  ledger: string,
  migration: Migration
): Promise<void> {
  const supersedes = migration.supersedes ?? []
  const insert = db
    .prepare(`INSERT INTO ${ledger} (name) VALUES (?)`)
    .bind(migration.name)
  if (supersedes.length === 0) {
    await insert.run()
    return
  }
  // 旧版增量链时代的账本里本来就有同名 `schema_v1` 行，删掉再写，账本才只剩一行。
  const retired = [migration.name, ...supersedes]
  const placeholders = retired.map(() => "?").join(", ")
  await db.batch([
    db
      .prepare(`DELETE FROM ${ledger} WHERE name IN (${placeholders})`)
      .bind(...retired),
    insert
  ])
}

/** 执行选项：目前只有建库语言（只影响全新库播种的默认空间名）。 */
export interface MigrationRunOptions {
  /** 播种默认空间用的语言；缺省 `zh`（与 §2.3 末级回退一致）。 */
  language?: Language
}

/**
 * 执行所有未记账的迁移。每条迁移按「prepare → sql → 记账」执行，三阶段全部成功
 * 才记账；失败立即抛出，不记录该迁移、也不继续后续迁移（下次 setup 会重跑它，
 * 各阶段都是幂等的）。
 *
 * 入参是整个 Env：迁移可能要用内容桶、加密钥等绑定，只给 `db + prefix` 表达不了。
 * 语言只进 `getMigrations`（播种的 name 值），不入账本——同一库的账本与结构不因
 * 语言不同而不同。
 */
export async function runLedgerMigrations(
  env: Env,
  options: MigrationRunOptions = {}
): Promise<LedgerMigrationResult[]> {
  const db = env.DB
  const prefix = getTablePrefix(env)
  const language = options.language ?? DEFAULT_LANGUAGE
  const ledger = await ensureLedgerTable(db, prefix)

  const recorded = await db
    .prepare(`SELECT name FROM ${ledger}`)
    .all<{ name: string }>()
  const applied = new Set(recorded.results.map((row) => row.name))

  const results: LedgerMigrationResult[] = []
  for (const migration of getMigrations(prefix, language)) {
    const context: MigrationContext = { db, prefix, env, applied }
    // 缺省按账本行判定；`schema_v1` 还要看账本是否收敛、结构是否真是基线。
    const done = migration.isApplied
      ? await migration.isApplied(context)
      : applied.has(migration.name)
    if (done) {
      // 结构已就绪但账本缺这一行（迁移提交后、记账前中断的自愈路径）：补记账，
      // 让账本与结构收敛；此时没有执行任何迁移语句。
      if (!applied.has(migration.name)) {
        await recordMigration(db, ledger, migration)
        for (const name of [migration.name, ...(migration.supersedes ?? [])]) {
          applied.delete(name)
        }
        applied.add(migration.name)
        results.push({ name: migration.name, status: "applied" })
        continue
      }
      results.push({ name: migration.name, status: "skipped" })
      continue
    }
    try {
      if (migration.prepare) await migration.prepare(context)
      if (migration.apply) {
        await migration.apply(context)
      } else {
        if (splitStatements(migration.sql).length === 0) {
          throw new Error(
            "migration has neither sql statements nor an apply step"
          )
        }
        for (const statement of splitStatements(migration.sql)) {
          await db.prepare(statement).run()
        }
      }
      await recordMigration(db, ledger, migration)
      // 记账后账本已变：本条自己的旧同名行与被 `supersedes` 声明的旧行都不在了。
      // 不同步这个快照的话，后面的迁移会拿「记账前」的旧账本判自己是否已应用——
      // 旧 v8 账本里的 `schema_v2` 只代表增量链时代那一版，新 v2 还没跑却被当成
      // skipped，令牌两张表就永远建不出来。
      for (const name of [migration.name, ...(migration.supersedes ?? [])]) {
        applied.delete(name)
      }
      applied.add(migration.name)
    } catch (err) {
      // 形态/账本不被接受是可预期的操作错误：信息本身就是操作指引，原样上抛。
      if (err instanceof MigrationRejectedError) throw err
      throw migrationError(migration.name, err)
    }
    results.push({ name: migration.name, status: "applied" })
  }

  return results
}
