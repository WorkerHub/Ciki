/**
 * 账本式迁移执行器：每个迁移只执行一次，失败可见（不吞错）。
 *
 * 表名一律经 tables.ts 的 migrationsTable() 解析；账本本身也属于本项目
 * （带 TABLE_PREFIX），换前缀即换一套账本。
 */
import { getMigrations } from "./migrations"
import { migrationsTable } from "./tables"

export type LedgerMigrationStatus = "applied" | "skipped"

export interface LedgerMigrationResult {
  name: string
  status: LedgerMigrationStatus
}

/** 建账本表（幂等），返回表名。 */
export async function ensureLedgerTable(
  db: D1Database,
  prefix: string
): Promise<string> {
  const ledger = migrationsTable(prefix)
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
