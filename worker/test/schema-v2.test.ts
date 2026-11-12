/**
 * `schema_v2`（`write_tokens` + `token_space_scopes`）的迁移演练：纯追加、幂等。
 *
 * 逐项对应验收（规格 §6）：
 * - 全新安装直接含两表与 `write_tokens.token_hash` 唯一索引；
 * - 存量 v1 库升级＝只建两表，现有业务数据逐行零变化；
 * - 重复执行全部 skipped，账本不增行；
 * - 旧 v8 账本（增量链时代的 `schema_v2` 行）一次跑完「基线手术 + 新 v2」，
 *   两张新表不会因为旧账本行被误判为「已应用」而漏建。
 */
import { describe, expect, it } from "vitest"
import { getMigrations } from "../src/lib/migrations"
import { runSetup } from "../src/lib/setup"
import { migrationsTable, tableName } from "../src/lib/tables"
import { makeContext } from "./support/app"
import type { TestContext } from "./support/app"
import { createV8Database, rowsOf, seedV8Database } from "./support/v8-schema"

const PREFIX = "ciki_"
const MIGRATION_NAMES = getMigrations(PREFIX).map((migration) => migration.name)
const V2_TABLES = ["write_tokens", "token_space_scopes"].map((name) =>
  tableName(PREFIX, name)
)
const V2_INDEX = tableName(PREFIX, "write_tokens_token_hash")

function migrationList(status: "applied" | "skipped") {
  return MIGRATION_NAMES.map((name) => ({ name, status }))
}

function tableNames(ctx: TestContext): string[] {
  return (
    ctx.db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name)
}

function indexNames(ctx: TestContext): string[] {
  return (
    ctx.db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name)
}

function ledgerNames(ctx: TestContext): string[] {
  return (
    ctx.db.db
      .prepare(`SELECT name FROM ${migrationsTable(PREFIX)} ORDER BY name`)
      .all() as Array<{ name: string }>
  ).map((row) => row.name)
}

async function setup(ctx: TestContext) {
  const result = await runSetup(ctx.env)
  if (!result.success) throw new Error(result.error)
  return result
}

/** 初始化的库（v1 + v2 都在）。 */
async function setupContext(): Promise<TestContext> {
  const ctx = makeContext()
  await setup(ctx)
  return ctx
}

/**
 * 把库退回「只有 schema_v1」的样子：删掉 v2 的两张表（索引随表一起删）与账本行。
 * 这等价于升级到本版之前的存量库。
 */
async function backToV1Only(ctx: TestContext): Promise<void> {
  for (const name of V2_TABLES) {
    await ctx.db.exec(`DROP TABLE ${name}`)
  }
  await ctx.db
    .prepare(`DELETE FROM ${migrationsTable(PREFIX)} WHERE name = ?`)
    .bind("schema_v2")
    .run()
}

/** 存量业务数据：两张令牌表 + 空间/成员各一行（与 v2 无关，升级必须一字不动）。 */
async function seedBusinessRows(ctx: TestContext): Promise<void> {
  const now = "2026-01-01T00:00:00.000Z"
  await ctx.db.db
    .prepare(
      "INSERT INTO ciki_read_tokens (user_id, token_hash, created_at) VALUES (1, ?, ?)"
    )
    .run("a".repeat(64), now)
  await ctx.db.db
    .prepare(
      "INSERT INTO ciki_import_tokens (user_id, token_hash, created_at) VALUES (2, ?, ?)"
    )
    .run("b".repeat(64), now)
}

describe("schema_v2：纯追加的两张令牌表", () => {
  it("全新安装：两表与唯一索引在位，账本两条", async () => {
    const ctx = makeContext()
    const result = await setup(ctx)

    expect(result.migrations).toEqual(migrationList("applied"))
    expect(ledgerNames(ctx)).toEqual(MIGRATION_NAMES)
    const tables = tableNames(ctx)
    for (const name of V2_TABLES) expect(tables).toContain(name)
    expect(indexNames(ctx)).toContain(V2_INDEX)
  })

  it("write_tokens 与 read_tokens 逐列一致；token_space_scopes 三列联合主键 + 种类 CHECK", async () => {
    const ctx = await setupContext()
    const columnsOf = (name: string) =>
      (
        ctx.db.db
          .prepare(`PRAGMA table_info(${tableName(PREFIX, name)})`)
          .all() as Array<{
          name: string
          type: string
          pk: number
          notnull: number
        }>
      ).map(({ name, type, pk, notnull }) => ({ name, type, pk, notnull }))

    expect(columnsOf("write_tokens")).toEqual(columnsOf("read_tokens"))

    const scopeColumns = columnsOf("token_space_scopes")
    expect(scopeColumns.map((column) => column.name)).toEqual([
      "token_kind",
      "user_id",
      "space_id"
    ])
    // 三列联合主键：pk 依次为 1/2/3。
    expect(scopeColumns.map((column) => column.pk)).toEqual([1, 2, 3])

    // token_kind 只收 read / write。
    expect(() =>
      ctx.db.db
        .prepare(
          "INSERT INTO ciki_token_space_scopes (token_kind, user_id, space_id) VALUES ('bogus', 1, 1)"
        )
        .run()
    ).toThrow()
  })

  it("存量 v1 库升级：只建两表，业务数据逐行零变化；重复执行全 skipped", async () => {
    const ctx = makeContext()
    await setup(ctx)
    await seedBusinessRows(ctx)
    const beforeRead = rowsOf(ctx.db, tableName(PREFIX, "read_tokens"))
    const beforeImport = rowsOf(ctx.db, tableName(PREFIX, "import_tokens"))
    const beforeSpaces = rowsOf(ctx.db, tableName(PREFIX, "spaces"))

    await backToV1Only(ctx)
    expect(tableNames(ctx)).not.toContain(V2_TABLES[0])
    expect(ledgerNames(ctx)).toEqual(["schema_v1"])

    const upgraded = await setup(ctx)
    expect(upgraded.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v2", status: "applied" }
    ])
    expect(ledgerNames(ctx)).toEqual(MIGRATION_NAMES)
    for (const name of V2_TABLES) expect(tableNames(ctx)).toContain(name)
    expect(indexNames(ctx)).toContain(V2_INDEX)

    // 数据零变化：两张令牌表、空间与成员逐行一字不差。
    expect(rowsOf(ctx.db, tableName(PREFIX, "read_tokens"))).toEqual(beforeRead)
    expect(rowsOf(ctx.db, tableName(PREFIX, "import_tokens"))).toEqual(
      beforeImport
    )
    expect(rowsOf(ctx.db, tableName(PREFIX, "spaces"))).toEqual(beforeSpaces)

    const again = await setup(ctx)
    expect(again.migrations).toEqual(migrationList("skipped"))
    expect(ledgerNames(ctx)).toEqual(MIGRATION_NAMES)
  })

  it("旧 v8 账本：一次跑完基线手术与新增量，两表建出、账本收敛为两条", async () => {
    const ctx = makeContext()
    await createV8Database(ctx)
    await seedV8Database(ctx)
    const beforeUsers = rowsOf(ctx.db, tableName(PREFIX, "users"))

    const result = await setup(ctx)
    expect(result.migrations).toEqual(migrationList("applied"))
    expect(ledgerNames(ctx)).toEqual(MIGRATION_NAMES)
    for (const name of V2_TABLES) expect(tableNames(ctx)).toContain(name)
    expect(rowsOf(ctx.db, tableName(PREFIX, "users"))).toEqual(beforeUsers)
  })
})
