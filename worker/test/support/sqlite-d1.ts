/**
 * 最小 D1 替身：用 Node 内置 `node:sqlite` 跑真实 SQLite（D1 就是 SQLite，
 * 迁移、FTS5、递归 CTE、UNIQUE 约束都按真实行为验证）。
 *
 * 与 eNotify 的版本相比补了 `batch()`（含事务回滚），因为页面写入、索引同步与
 * revision 都依赖 `db.batch()` 的原子性。
 */
// @ts-expect-error node:sqlite ships with Node but is not in the Workers type set.
import { DatabaseSync } from "node:sqlite"

interface PreparedLike {
  _sql: string
  _args: unknown[]
  first: <T>() => Promise<T | null>
  all: <T>() => Promise<{ results: T[] }>
  run: () => Promise<{
    success: true
    meta: { changes: number; last_row_id: number }
  }>
  bind: (...args: unknown[]) => PreparedLike
}

export class SqliteD1 {
  readonly db = new DatabaseSync(":memory:")

  prepare(sql: string): PreparedLike {
    const db = this.db
    const runStatement = (args: unknown[]) =>
      db.prepare(sql).run(...(args as never[]))

    const make = (args: unknown[]): PreparedLike => ({
      _sql: sql,
      _args: args,
      bind: (...next: unknown[]) => make(next),
      first: async <T>() =>
        (db.prepare(sql).get(...(args as never[])) ?? null) as T | null,
      all: async <T>() => ({
        results: db.prepare(sql).all(...(args as never[])) as T[]
      }),
      run: async () => {
        const result = runStatement(args)
        return {
          success: true as const,
          meta: {
            changes: Number(result.changes),
            last_row_id: Number(result.lastInsertRowid)
          }
        }
      }
    })

    return make([])
  }

  /** D1 的 batch 是事务：任一语句失败整体回滚。 */
  async batch(statements: PreparedLike[]) {
    this.db.exec("BEGIN")
    try {
      const results = []
      for (const statement of statements) {
        results.push(await statement.run())
      }
      this.db.exec("COMMIT")
      return results
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql)
  }
}
