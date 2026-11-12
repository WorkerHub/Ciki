/**
 * `schema_v3`（令牌存储合并）的迁移演练：最终形态、存量搬运、幂等与整单回滚。
 *
 * 逐项对应验收（三期规格 §1 / §2）：
 * - 全新安装一次 setup 即最终形态：`api_tokens` + 多行 `import_tokens` +
 *   `(token_id, space_id)` 的 `token_space_scopes`，旧 read/write 表已删；
 * - 当前生产形态（v1 + v2）升级：read/write 令牌按 kind 合并、hash/时间/吊销原样、
 *   旧范围按 (user_id, kind) 映射到令牌 id、导入令牌变多行并自动命名；
 * - 迁移后旧明文令牌不失效：仍能调 `/api/read/spaces` 与 `/api/import/spaces`；
 * - 重复执行全 skipped、数据不变；
 * - 计数不一致（孤儿 scope 行）时整个 batch 回滚：旧表与账本原样，不留下半成品。
 */
import { describe, expect, it } from "vitest"
import { sha256Hex } from "../src/core/auth"
import { runSetup } from "../src/lib/setup"
import { migrationsTable, tableName } from "../src/lib/tables"
import { makeContext, request } from "./support/app"
import type { TestContext } from "./support/app"
import { createV8Database, rowsOf, seedV8Database } from "./support/v8-schema"

const PREFIX = "ciki_"
const NOW = "2026-03-01T00:00:00.000Z"
const LAST_USED = "2026-03-02T00:00:00.000Z"

const READ_PLAIN = "legacy-read-token"
const WRITE_PLAIN = "legacy-write-token"
const REVOKED_WRITE_PLAIN = "legacy-revoked-write-token"
const IMPORT_PLAIN = "legacy-import-token"

const readTokens = tableName(PREFIX, "read_tokens")
const writeTokens = tableName(PREFIX, "write_tokens")
const importTokens = tableName(PREFIX, "import_tokens")
const apiTokens = tableName(PREFIX, "api_tokens")
const scopes = tableName(PREFIX, "token_space_scopes")

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

function columnsOf(ctx: TestContext, table: string) {
  return (
    ctx.db.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string
      type: string
      pk: number
      notnull: number
    }>
  ).map(({ name, type, pk, notnull }) => ({ name, type, pk, notnull }))
}

/**
 * 当前生产形态的夹具：v1 基线结构 + 账本只有 v1/v2 + v2 的两张令牌表。
 * 令牌用**可回放的明文**灌入（库里只存 SHA-256），升级后直接拿明文调接口验证。
 */
async function v2Context(options: { orphanScope?: boolean } = {}) {
  const context = makeContext()
  const { db } = context
  await createV8Database(context, ["schema_v1", "schema_v2"])

  // schema_v2 的定版 DDL（与 worker/src/lib/migrations.ts 的 v2 语句一致）。
  await db.exec(`CREATE TABLE ${writeTokens} (
  user_id      INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
)`)
  await db.exec(`CREATE UNIQUE INDEX ${tableName(PREFIX, "write_tokens_token_hash")}
  ON ${writeTokens}(token_hash)`)
  await db.exec(`CREATE TABLE ${scopes} (
  token_kind TEXT NOT NULL CHECK (token_kind IN ('read', 'write')),
  user_id    INTEGER NOT NULL,
  space_id   INTEGER NOT NULL,
  PRIMARY KEY (token_kind, user_id, space_id)
)`)

  await seedV8Database(context)

  // 种子里 read / import 令牌是占位 hash；换成真实 SHA-256 以便升级后回放明文。
  await db.db
    .prepare(
      `UPDATE ${readTokens}
          SET token_hash = ?, last_used_at = ?
        WHERE user_id = 2`
    )
    .run(await sha256Hex(READ_PLAIN), LAST_USED)
  await db.db
    .prepare(`UPDATE ${importTokens} SET token_hash = ? WHERE user_id = 1`)
    .run(await sha256Hex(IMPORT_PLAIN))

  // 用户 2 的读写令牌（有效，范围 {space 2}）。
  await db.db
    .prepare(
      `INSERT INTO ${writeTokens}
        (user_id, token_hash, created_at, last_used_at, revoked_at)
       VALUES (2, ?, ?, NULL, NULL)`
    )
    .run(await sha256Hex(WRITE_PLAIN), NOW)
  // 用户 1 的读写令牌（已吊销，升级后仍是吊销状态）。
  await db.db
    .prepare(
      `INSERT INTO ${writeTokens}
        (user_id, token_hash, created_at, last_used_at, revoked_at)
       VALUES (1, ?, ?, NULL, ?)`
    )
    .run(await sha256Hex(REVOKED_WRITE_PLAIN), NOW, LAST_USED)

  // 用户 2 也是 space 2 的成员：两个令牌的范围各自生效、互不影响。
  await db.db
    .prepare(
      `INSERT INTO ${tableName(PREFIX, "space_members")}
        (space_id, user_id, role, created_at)
       VALUES (2, 2, 'viewer', ?)`
    )
    .run(NOW)

  // 旧范围按 (kind, user_id) 存：只读令牌可见 space 1，读写令牌可见 space 2。
  await db.db
    .prepare(
      `INSERT INTO ${scopes} (token_kind, user_id, space_id)
       VALUES ('read', 2, 1), ('write', 2, 2)`
    )
    .run()
  if (options.orphanScope) {
    // 数据不一致：没有对应令牌的 scope 行，迁移必须整单回滚。
    await db.db
      .prepare(
        `INSERT INTO ${scopes} (token_kind, user_id, space_id)
         VALUES ('read', 999, 1)`
      )
      .run()
  }

  return context
}

async function setup(ctx: TestContext) {
  const result = await runSetup(ctx.env)
  if (!result.success) throw new Error(result.error)
  return result
}

function bearer(env: TestContext["env"], token: string, path: string) {
  return request(env, path, {
    headers: { authorization: `Bearer ${token}` }
  })
}

describe("schema_v3：全新安装的最终形态", () => {
  it("旧表已删、新表/唯一索引/联合主键在位，账本三条", async () => {
    const ctx = makeContext()
    const result = await setup(ctx)

    expect(result.migrations.map((m) => m.name)).toEqual([
      "schema_v1",
      "schema_v2",
      "schema_v3"
    ])
    expect(ledgerNames(ctx)).toEqual(["schema_v1", "schema_v2", "schema_v3"])

    const tables = tableNames(ctx)
    expect(tables).toContain(apiTokens)
    expect(tables).toContain(importTokens)
    expect(tables).toContain(scopes)
    expect(tables).not.toContain(readTokens)
    expect(tables).not.toContain(writeTokens)

    const indexes = indexNames(ctx)
    expect(indexes).toContain(tableName(PREFIX, "api_tokens_token_hash"))
    expect(indexes).toContain(tableName(PREFIX, "import_tokens_token_hash"))
    expect(indexes).not.toContain(tableName(PREFIX, "read_tokens_token_hash"))

    expect(columnsOf(ctx, apiTokens).map((column) => column.name)).toEqual([
      "id",
      "user_id",
      "kind",
      "name",
      "token_hash",
      "created_at",
      "last_used_at",
      "revoked_at"
    ])
    expect(columnsOf(ctx, scopes).map((column) => column.name)).toEqual([
      "token_id",
      "space_id"
    ])
    expect(columnsOf(ctx, scopes).map((column) => column.pk)).toEqual([1, 2])
    expect(columnsOf(ctx, importTokens).map((column) => column.name)).toEqual([
      "id",
      "user_id",
      "name",
      "token_hash",
      "created_at",
      "last_used_at",
      "revoked_at"
    ])
  })

  it("非默认 TABLE_PREFIX 也能一次建到最终形态", async () => {
    const ctx = makeContext({ TABLE_PREFIX: "wiki_" })
    await setup(ctx)
    const tables = tableNames(ctx)
    expect(tables).toContain("wiki_api_tokens")
    expect(tables).toContain("wiki_import_tokens")
    expect(tables).toContain("wiki_token_space_scopes")
    expect(tables).not.toContain("wiki_read_tokens")
    expect(tables).not.toContain("wiki_write_tokens")
  })

  it("类型/唯一性约束：kind 只收 read/write，hash 与复合主键拒绝重复", async () => {
    const ctx = makeContext()
    await setup(ctx)
    const insertApi = ctx.db.db.prepare(
      `INSERT INTO ${apiTokens}
        (user_id, kind, name, token_hash, created_at)
       VALUES (1, ?, 'x', ?, '2026-01-01T00:00:00.000Z')`
    )
    insertApi.run("read", "hash-a")
    expect(() => insertApi.run("bogus", "hash-b")).toThrow()
    expect(() => insertApi.run("write", "hash-a")).toThrow()

    await ctx.db.db
      .prepare(`INSERT INTO ${scopes} (token_id, space_id) VALUES (1, 1)`)
      .run()
    expect(() =>
      ctx.db.db
        .prepare(`INSERT INTO ${scopes} (token_id, space_id) VALUES (1, 1)`)
        .run()
    ).toThrow()

    const insertImport = ctx.db.db.prepare(
      `INSERT INTO ${importTokens}
        (user_id, name, token_hash, created_at)
       VALUES (1, '插件', ?, '2026-01-01T00:00:00.000Z')`
    )
    insertImport.run("import-a")
    expect(() => insertImport.run("import-a")).toThrow()
  })
})

describe("schema_v3：v1 + v2 存量库升级", () => {
  it("令牌按 kind 合并、范围映射到 token_id、导入令牌多行并自动命名", async () => {
    const ctx = await v2Context()
    const result = await setup(ctx)
    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v2", status: "skipped" },
      { name: "schema_v3", status: "applied" }
    ])

    const readHash = await sha256Hex(READ_PLAIN)
    const writeHash = await sha256Hex(WRITE_PLAIN)
    const revokedHash = await sha256Hex(REVOKED_WRITE_PLAIN)
    const importHash = await sha256Hex(IMPORT_PLAIN)

    const apiRows = rowsOf(ctx.db, apiTokens) as Array<Record<string, unknown>>
    expect(apiRows).toHaveLength(3)
    const readRow = apiRows.find((row) => row.token_hash === readHash)
    expect(readRow).toMatchObject({
      user_id: 2,
      kind: "read",
      name: "只读 Token",
      created_at: NOW,
      last_used_at: LAST_USED,
      revoked_at: null
    })
    const writeRow = apiRows.find((row) => row.token_hash === writeHash)
    expect(writeRow).toMatchObject({
      user_id: 2,
      kind: "write",
      name: "读写 Token",
      created_at: NOW,
      last_used_at: null,
      revoked_at: null
    })
    const revokedRow = apiRows.find((row) => row.token_hash === revokedHash)
    expect(revokedRow).toMatchObject({
      user_id: 1,
      kind: "write",
      name: "读写 Token",
      revoked_at: LAST_USED
    })

    expect(rowsOf(ctx.db, scopes)).toEqual(
      [
        { token_id: readRow?.id, space_id: 1 },
        { token_id: writeRow?.id, space_id: 2 }
      ].sort((a, b) => Number(a.token_id) - Number(b.token_id))
    )

    expect(rowsOf(ctx.db, importTokens)).toEqual([
      {
        id: 1,
        user_id: 1,
        name: "浏览器插件",
        token_hash: importHash,
        created_at: NOW,
        last_used_at: null,
        revoked_at: null
      }
    ])

    const tables = tableNames(ctx)
    expect(tables).not.toContain(readTokens)
    expect(tables).not.toContain(writeTokens)
  })

  it("明文令牌升级后不失效，隔离矩阵不变", async () => {
    const ctx = await v2Context()
    await setup(ctx)

    // 只读令牌：仍可调读接口，且只看见自己那份范围（space 1）。
    const read = await bearer(ctx.env, READ_PLAIN, "/api/read/spaces")
    expect(read.status).toBe(200)
    expect(
      ((await read.json()) as { spaces: Array<{ id: number }> }).spaces.map(
        (space) => space.id
      )
    ).toEqual([1])

    // 读写令牌：读接口也认，范围是它自己的那份（space 2）。
    const write = await bearer(ctx.env, WRITE_PLAIN, "/api/read/spaces")
    expect(write.status).toBe(200)
    expect(
      ((await write.json()) as { spaces: Array<{ id: number }> }).spaces.map(
        (space) => space.id
      )
    ).toEqual([2])

    // 已吊销的读写令牌：401。
    expect(
      (await bearer(ctx.env, REVOKED_WRITE_PLAIN, "/api/read/spaces")).status
    ).toBe(401)

    // 导入令牌：仍可调导入接口，但进不了读接口；只读令牌也进不了导入接口。
    expect(
      (await bearer(ctx.env, IMPORT_PLAIN, "/api/import/spaces")).status
    ).toBe(200)
    expect(
      (await bearer(ctx.env, IMPORT_PLAIN, "/api/read/spaces")).status
    ).toBe(401)
    expect(
      (await bearer(ctx.env, READ_PLAIN, "/api/import/spaces")).status
    ).toBe(401)
  })

  it("重复 setup 全 skipped，令牌数据逐行不变", async () => {
    const ctx = await v2Context()
    await setup(ctx)
    const before = {
      api: rowsOf(ctx.db, apiTokens),
      scopes: rowsOf(ctx.db, scopes),
      imports: rowsOf(ctx.db, importTokens)
    }

    const again = await setup(ctx)
    expect(again.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v2", status: "skipped" },
      { name: "schema_v3", status: "skipped" }
    ])
    expect(rowsOf(ctx.db, apiTokens)).toEqual(before.api)
    expect(rowsOf(ctx.db, scopes)).toEqual(before.scopes)
    expect(rowsOf(ctx.db, importTokens)).toEqual(before.imports)
    expect(ledgerNames(ctx)).toEqual(["schema_v1", "schema_v2", "schema_v3"])
  })

  it("v3 已提交但账本缺行：只补记账，不重搬数据", async () => {
    const ctx = await v2Context()
    await setup(ctx)
    const before = rowsOf(ctx.db, apiTokens)

    // 模拟「迁移已提交、记账前中断」：结构与数据都在，账本少了 schema_v3 一行。
    await ctx.db.db
      .prepare(
        `DELETE FROM ${migrationsTable(PREFIX)} WHERE name = 'schema_v3'`
      )
      .run()

    const again = await setup(ctx)
    expect(again.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v2", status: "skipped" },
      { name: "schema_v3", status: "applied" }
    ])
    expect(rowsOf(ctx.db, apiTokens)).toEqual(before)
    expect(ledgerNames(ctx)).toEqual(["schema_v1", "schema_v2", "schema_v3"])
  })

  it("计数不一致整单回滚：旧表与账本原样，api_tokens 不存在", async () => {
    const ctx = await v2Context({ orphanScope: true })
    const readBefore = rowsOf(ctx.db, readTokens)
    const writeBefore = rowsOf(ctx.db, writeTokens)
    const scopesBefore = rowsOf(ctx.db, scopes)
    const importsBefore = rowsOf(ctx.db, importTokens)

    await expect(runSetup(ctx.env)).rejects.toThrow(/rolled back/)

    expect(tableNames(ctx)).not.toContain(apiTokens)
    expect(rowsOf(ctx.db, readTokens)).toEqual(readBefore)
    expect(rowsOf(ctx.db, writeTokens)).toEqual(writeBefore)
    expect(rowsOf(ctx.db, scopes)).toEqual(scopesBefore)
    expect(rowsOf(ctx.db, importTokens)).toEqual(importsBefore)
    expect(ledgerNames(ctx)).toEqual(["schema_v1", "schema_v2"])
  })
})
