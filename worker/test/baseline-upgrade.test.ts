/**
 * 坍缩为单条 `schema_v1` 的演练测试：最终令牌形态的存量库升级到单条基线 `schema_v1`，
 * 全新库一条基线建全结构。
 *
 * 逐项对应验收：
 * - 存量升级只改账本：账本收敛为单条 `schema_v1`，全部表/索引/数据逐行逐值不变、
 *   正文对象不重传、每个 `content_hash` 都能从内容桶回读并通过哈希复核、
 *   存量明文令牌升级后仍可鉴权且范围隔离不变；
 * - 全新库一条基线建全最终结构（`api_tokens` / 按 `token_id` 的
 *   `token_space_scopes` / 多行 `import_tokens`，无 `read_tokens`/`write_tokens`）；
 * - 幂等与可重入：`schema_v1` 库重复升级为空操作；把账本改回 v1+v2+v3 后重跑收敛；
 *   上次安装中断的半成品库由建表语句补齐；
 * - 不被接受的升级源（v2 形态、删唯一索引、更早形态）一律拒绝且指路，
 *   数据与账本一字未动。
 */
import { describe, expect, it } from "vitest"
import { hashContent, readContent } from "../src/core/content-store"
import { getMigrations } from "../src/lib/migrations"
import { SCHEMA_INDEXES, SCHEMA_TABLES } from "../src/lib/schema"
import { runSetup } from "../src/lib/setup"
import { migrationsTable, tableName } from "../src/lib/tables"
import {
  TEST_SETUP_SECRET,
  jsonRequest,
  loginAs,
  makeContext,
  request,
  userSession
} from "./support/app"
import type { TestContext } from "./support/app"
import {
  V2_LEDGER_ROWS,
  V3_IMPORT_TOKEN,
  V3_LEDGER_ROWS,
  V3_PASSWORD,
  V3_READ_TOKEN,
  V3_WRITE_TOKEN,
  createV3Database,
  rowsOf,
  seedV3Database
} from "./support/v3-schema"

const PREFIX = "ciki_"

/** 当前账本里应有的迁移名（顺序即执行顺序）：断言按它生成，不写死字面量。 */
const MIGRATION_NAMES = getMigrations(PREFIX).map((migration) => migration.name)

function migrationList(status: "applied" | "skipped") {
  return MIGRATION_NAMES.map((name) => ({ name, status }))
}

/** 生产同形态的库：最终令牌结构 + 坍缩前账本（v1+v2+v3）+ 存量数据。 */
async function v3Context(ledger: readonly string[] = V3_LEDGER_ROWS) {
  const context = makeContext()
  await createV3Database(context, ledger)
  const seed = await seedV3Database(context)
  return { ...context, seed }
}

/** v2 形态的库（账本 v1+v2、令牌还是旧四表）：升级源不被接受。 */
async function v2FormContext(): Promise<TestContext> {
  const ctx = makeContext()
  await createV3Database(ctx, V2_LEDGER_ROWS)
  const read = tableName(PREFIX, "read_tokens")
  const write = tableName(PREFIX, "write_tokens")
  const scopes = tableName(PREFIX, "token_space_scopes")
  const imports = tableName(PREFIX, "import_tokens")
  // 把最终令牌三表换回 v2 形态（删表时 SQLite 会连带删掉它们的索引）。
  await ctx.db.exec(`DROP TABLE ${scopes}`)
  await ctx.db.exec(`DROP TABLE ${tableName(PREFIX, "api_tokens")}`)
  await ctx.db.exec(`DROP TABLE ${imports}`)
  await ctx.db.exec(`CREATE TABLE ${read} (
  user_id      INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
)`)
  await ctx.db.exec(
    `CREATE UNIQUE INDEX ${tableName(PREFIX, "read_tokens_token_hash")} ON ${read}(token_hash)`
  )
  await ctx.db.exec(`CREATE TABLE ${write} (
  user_id      INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
)`)
  await ctx.db.exec(
    `CREATE UNIQUE INDEX ${tableName(PREFIX, "write_tokens_token_hash")} ON ${write}(token_hash)`
  )
  await ctx.db.exec(`CREATE TABLE ${scopes} (
  token_kind TEXT NOT NULL CHECK (token_kind IN ('read', 'write')),
  user_id    INTEGER NOT NULL,
  space_id   INTEGER NOT NULL,
  PRIMARY KEY (token_kind, user_id, space_id)
)`)
  await ctx.db.exec(`CREATE TABLE ${imports} (
  user_id      INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
)`)
  await ctx.db.exec(
    `CREATE UNIQUE INDEX ${tableName(PREFIX, "import_tokens_token_hash")} ON ${imports}(token_hash)`
  )
  return ctx
}

function ledgerNames(ctx: TestContext): string[] {
  return (
    ctx.db.db
      .prepare(`SELECT name FROM ${migrationsTable(PREFIX)} ORDER BY name`)
      .all() as Array<{ name: string }>
  ).map((row) => row.name)
}

/** 业务表（不含账本）的全量行快照：升级前后必须逐字相同。 */
function businessSnapshot(ctx: TestContext): Record<string, unknown[]> {
  const snapshot: Record<string, unknown[]> = {}
  for (const table of SCHEMA_TABLES) {
    snapshot[table.name] = rowsOf(ctx.db, tableName(PREFIX, table.name))
  }
  return snapshot
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

/** 库里每个正文指针都能从内容桶回读，且哈希与指针一致（全量，不抽样）。 */
async function expectContentIntact(ctx: TestContext): Promise<void> {
  const hashes = new Set<string>()
  for (const logical of ["pages", "page_revisions"]) {
    const rows = ctx.db.db
      .prepare(
        `SELECT DISTINCT content_hash FROM ${tableName(PREFIX, logical)}`
      )
      .all() as Array<{ content_hash: string }>
    for (const row of rows) hashes.add(row.content_hash)
  }
  expect(hashes.size).toBeGreaterThan(0)
  for (const hash of hashes) {
    expect(await hashContent(await readContent(ctx.env, hash))).toBe(hash)
  }
}

function bearer(env: TestContext["env"], token: string, path: string) {
  return request(env, path, {
    headers: { authorization: `Bearer ${token}` }
  })
}

function setupRequest(env: TestContext["env"]) {
  return request(env, "/api/setup", {
    method: "POST",
    headers: { "x-setup-secret": TEST_SETUP_SECRET }
  })
}

describe("最终形态存量库 → 单条 schema_v1：只动账本", () => {
  it("账本收敛为单条 schema_v1，表/索引/数据逐行不变，正文可回读", async () => {
    const context = await v3Context()
    const { env, db } = context
    const beforeData = businessSnapshot(context)
    const beforeTables = tableNames(context).sort()
    const beforeIndexes = indexNames(context).sort()
    const beforeObjects = context.content.store.size

    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)

    expect(result.migrations).toEqual(migrationList("applied"))
    expect(ledgerNames(context)).toEqual(MIGRATION_NAMES)

    // 坍缩不改任何结构：表/索引集合与升级前完全一致。
    expect(tableNames(context).sort()).toEqual(beforeTables)
    expect(indexNames(context).sort()).toEqual(beforeIndexes)
    expect(tableNames(context)).not.toContain(tableName(PREFIX, "read_tokens"))
    expect(tableNames(context)).not.toContain(tableName(PREFIX, "write_tokens"))

    // 数据零变化：逐表全量行（对象、时间戳、计数）一字不差。
    expect(businessSnapshot(context)).toEqual(beforeData)

    // 正文对象一个不重传、不丢失，指针全量可回读。
    expect(context.content.store.size).toBe(beforeObjects)
    await expectContentIntact(context)

    // 用户行也一字未动（证明没有借坍缩顺手改列）。
    expect(
      (
        db.db.prepare("PRAGMA table_info(ciki_users)").all() as Array<{
          name: string
        }>
      ).map((column) => column.name)
    ).toContain("username")
  })

  it("存量明文令牌升级后仍可鉴权，范围隔离不变", async () => {
    const ctx = await v3Context()
    const result = await runSetup(ctx.env)
    if (!result.success) throw new Error(result.error)

    const read = await bearer(ctx.env, V3_READ_TOKEN, "/api/read/spaces")
    expect(read.status).toBe(200)
    expect(
      ((await read.json()) as { spaces: Array<{ id: number }> }).spaces.map(
        (space) => space.id
      )
    ).toEqual([1])

    const write = await bearer(ctx.env, V3_WRITE_TOKEN, "/api/read/spaces")
    expect(write.status).toBe(200)
    expect(
      ((await write.json()) as { spaces: Array<{ id: number }> }).spaces.map(
        (space) => space.id
      )
    ).toEqual([2])

    const imp = await bearer(ctx.env, V3_IMPORT_TOKEN, "/api/import/spaces")
    expect(imp.status).toBe(200)
  })

  it("升级后全链路可用：既有会话、登录、读页、搜索、评论、注册验证", async () => {
    const context = await v3Context()
    const { env } = context
    const seeded = await runSetup(env)
    if (!seeded.success) throw new Error(seeded.error)

    const me = await jsonRequest(
      env,
      "GET",
      "/api/me",
      undefined,
      `ciki_session=${context.seed.sessionToken}`
    )
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ email: "admin@example.com" })

    const admin = await loginAs(env, "admin@example.com", V3_PASSWORD)

    const page = await jsonRequest(env, "GET", "/api/pages/1", undefined, admin)
    expect(page.status).toBe(200)

    const search = await jsonRequest(
      env,
      "GET",
      `/api/search?q=${encodeURIComponent("首页")}`,
      undefined,
      admin
    )
    expect(search.status).toBe(200)

    const comment = await jsonRequest(
      env,
      "POST",
      "/api/pages/1/comments",
      { bodyMd: "升级后照常评论" },
      admin
    )
    expect(comment.status).toBe(201)

    await userSession(env, admin, "fresh@example.com")
  })
})

describe("全新库与幂等", () => {
  it("全新安装：账本单条，全部基线表/索引在位，无 read/write 令牌表", async () => {
    const context = makeContext()
    const result = await runSetup(context.env)
    if (!result.success) throw new Error(result.error)

    expect(result.migrations).toEqual(migrationList("applied"))
    expect(ledgerNames(context)).toEqual(MIGRATION_NAMES)
    expect(MIGRATION_NAMES).toEqual(["schema_v1"])

    const tables = tableNames(context)
    for (const table of SCHEMA_TABLES) {
      expect(tables).toContain(tableName(PREFIX, table.name))
    }
    expect(tables).not.toContain(tableName(PREFIX, "read_tokens"))
    expect(tables).not.toContain(tableName(PREFIX, "write_tokens"))

    const indexes = indexNames(context)
    for (const ddl of SCHEMA_INDEXES) {
      const match = /INDEX IF NOT EXISTS (\S+)/.exec(ddl)
      if (!match) throw new Error(`index DDL has no name: ${ddl}`)
      expect(indexes).toContain(match[1].replaceAll("{prefix}", PREFIX))
    }
    expect(indexes).not.toContain(tableName(PREFIX, "read_tokens_token_hash"))
    expect(indexes).toContain(tableName(PREFIX, "api_tokens_token_hash"))

    const usernameIndex = (
      context.db.db.prepare("PRAGMA index_list(ciki_users)").all() as Array<{
        name: string
        unique: number
        partial: number
      }>
    ).find((entry) => entry.name === "ciki_users_username")
    expect(usernameIndex).toMatchObject({ unique: 1, partial: 1 })

    const scopes = context.db.db
      .prepare("PRAGMA table_info(ciki_token_space_scopes)")
      .all() as Array<{ name: string; pk: number }>
    expect(scopes.map((column) => column.name)).toEqual([
      "token_id",
      "space_id"
    ])
    expect(scopes.map((column) => column.pk)).toEqual([1, 2])

    expect(
      context.db.db
        .prepare("SELECT id, slug, is_default FROM ciki_spaces")
        .all()
    ).toEqual([{ id: 1, slug: "space-1", is_default: 1 }])
  })

  it("已是 schema_v1 再点一次：全部 skipped、账本不变、数据不动", async () => {
    const context = await v3Context()
    const first = await runSetup(context.env)
    if (!first.success) throw new Error(first.error)
    const afterUpgrade = businessSnapshot(context)

    const again = await runSetup(context.env)
    if (!again.success) throw new Error(again.error)
    expect(again.migrations).toEqual(migrationList("skipped"))
    expect(ledgerNames(context)).toEqual(MIGRATION_NAMES)
    expect(businessSnapshot(context)).toEqual(afterUpgrade)
  })

  it("账本被改回 v1+v2+v3 再点：仍收敛为单条（可重入，结果一致）", async () => {
    const context = await v3Context()
    const first = await runSetup(context.env)
    if (!first.success) throw new Error(first.error)
    const afterUpgrade = businessSnapshot(context)

    await context.db.db.prepare(`DELETE FROM ${migrationsTable(PREFIX)}`).run()
    for (const name of V3_LEDGER_ROWS) {
      await context.db.db
        .prepare(`INSERT INTO ${migrationsTable(PREFIX)} (name) VALUES (?)`)
        .run(name)
    }

    const again = await runSetup(context.env)
    if (!again.success) throw new Error(again.error)
    expect(again.migrations).toEqual(migrationList("applied"))
    expect(ledgerNames(context)).toEqual(MIGRATION_NAMES)
    expect(businessSnapshot(context)).toEqual(afterUpgrade)
  })

  it("上次安装中断的半成品库（账本空、只建了几张表）：一次补齐", async () => {
    const context = makeContext()
    for (const statement of SCHEMA_TABLES.slice(0, 2)) {
      await context.db.exec(
        statement.ddl.replaceAll("{table}", tableName(PREFIX, statement.name))
      )
    }
    expect(tableNames(context)).not.toContain(tableName(PREFIX, "pages"))

    const result = await runSetup(context.env)
    if (!result.success) throw new Error(result.error)
    expect(result.migrations).toEqual(migrationList("applied"))
    expect(ledgerNames(context)).toEqual(MIGRATION_NAMES)
    expect(tableNames(context)).toContain(tableName(PREFIX, "pages"))
  })
})

describe("不被接受的升级源：拒绝、指路、一字不动", () => {
  it("账本有 v2 没有 v3 → 拒绝（v2 形态库），数据与账本不动", async () => {
    const context = await v2FormContext()
    const beforeLedger = ledgerNames(context)
    const beforeTables = tableNames(context).sort()

    const result = await runSetup(context.env)
    expect(result.success).toBe(false)
    if (result.success) throw new Error("expected rejection")
    expect(result.code).toBe("MIGRATION_REJECTED")
    expect(result.error).toContain("schema_v2")
    expect(result.error).toContain("schema_v3")
    expect(result.error).toContain("Nothing was changed")

    expect(ledgerNames(context)).toEqual(beforeLedger)
    expect(tableNames(context).sort()).toEqual(beforeTables)
  })

  it("删掉 username 唯一索引冒充最终形态 → 形态校验拦截", async () => {
    const context = await v3Context()
    await context.db.exec("DROP INDEX ciki_users_username")
    const beforeData = businessSnapshot(context)
    const beforeLedger = ledgerNames(context)

    const result = await runSetup(context.env)
    expect(result.success).toBe(false)
    if (result.success) throw new Error("expected rejection")
    expect(result.code).toBe("MIGRATION_REJECTED")
    expect(result.error).toContain("ciki_users_username")
    expect(result.error).toContain("Time Travel bookmark")

    expect(ledgerNames(context)).toEqual(beforeLedger)
    expect(businessSnapshot(context)).toEqual(beforeData)
    expect(indexNames(context)).not.toContain("ciki_users_username")
  })

  it("更早形态（users 还带 base_currency）→ 拒绝，不改结构", async () => {
    const context = await v3Context()
    await context.db.exec(
      "ALTER TABLE ciki_users ADD COLUMN base_currency TEXT NOT NULL DEFAULT 'CNY'"
    )
    const beforeData = businessSnapshot(context)

    const result = await runSetup(context.env)
    expect(result.success).toBe(false)
    if (result.success) throw new Error("expected rejection")
    expect(result.code).toBe("MIGRATION_REJECTED")
    expect(result.error).toContain("base_currency")

    expect(ledgerNames(context)).toEqual([...V3_LEDGER_ROWS])
    expect(businessSnapshot(context)).toEqual(beforeData)
    expect(
      (
        context.db.db.prepare("PRAGMA table_info(ciki_users)").all() as Array<{
          name: string
        }>
      ).map((column) => column.name)
    ).toContain("base_currency")
  })

  it("管理端点把指路信息带回页面（409 + MIGRATION_REJECTED）", async () => {
    const context = await v2FormContext()

    const res = await setupRequest(context.env)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; error: string }
    expect(body.code).toBe("MIGRATION_REJECTED")
    expect(body.error).toContain("schema_v3")
  })
})
