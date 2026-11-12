/**
 * 版本号重置（账本手术）的演练测试：`schema_v8` 形态的存量库升级到唯一迁移 `schema_v1`。
 *
 * 逐项对应验收：
 * - 升级只动账本：账本坍缩成一行 `schema_v1`，其余表逐行逐值不变、正文对象不重传、
 *   每个 `content_hash` 都能从内容桶回读并通过哈希复核；
 * - 升级后全链路可用：既有会话仍有效、登录、读页、搜索、评论、注册→批准→验证邮箱→登录；
 * - `v7` 账本（有 v7 无 v8）、删掉唯一索引的篡改库、更早形态（`users` 还带三列）
 *   一律拒绝且指路，数据与账本一字未动；
 * - 幂等与可重入：`schema_v1` 库重复升级为空操作；把账本改回 v7/v8 后重跑收敛；
 *   上次安装中断的半成品库由建表语句补齐。
 */
import { describe, expect, it } from "vitest"
import { hashContent, readContent } from "../src/core/content-store"
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
  V7_LEDGER_ROWS,
  V8_LEDGER_ROWS,
  V8_PASSWORD,
  createV8Database,
  rowsOf,
  seedV8Database
} from "./support/v8-schema"

const PREFIX = "ciki_"

/** 生产同形态的库：v8 结构 + 增量链时代账本 + 存量数据。 */
async function v8Context(ledger: readonly string[] = V8_LEDGER_ROWS) {
  const context = makeContext()
  await createV8Database(context, ledger)
  const seed = await seedV8Database(context)
  return { ...context, seed }
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

function setupRequest(env: TestContext["env"]) {
  return request(env, "/api/setup", {
    method: "POST",
    headers: { "x-setup-secret": TEST_SETUP_SECRET }
  })
}

describe("v8 形态存量库 → schema_v1：只动账本", () => {
  it("账本坍缩成一行 schema_v1，表/索引/数据逐行不变", async () => {
    const context = await v8Context()
    const { env, db } = context
    const beforeData = businessSnapshot(context)
    const beforeTables = tableNames(context)
    const beforeIndexes = indexNames(context).sort()
    const beforeObjects = context.content.store.size
    const beforeUserColumns = (
      db.db.prepare("PRAGMA table_info(ciki_users)").all() as Array<{
        name: string
      }>
    ).map((column) => column.name)

    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)

    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "applied" }
    ])
    // 增量链时代留下的 v1–v8 八行一并清掉，只留当前版本标记。
    expect(ledgerNames(context)).toEqual(["schema_v1"])

    // 结构零变化：表、索引、users 列名与升级前逐项一致。
    expect(tableNames(context).sort()).toEqual([...beforeTables].sort())
    expect(indexNames(context).sort()).toEqual(beforeIndexes)
    expect(
      (
        db.db.prepare("PRAGMA table_info(ciki_users)").all() as Array<{
          name: string
        }>
      ).map((column) => column.name)
    ).toEqual(beforeUserColumns)

    // 数据零变化：逐表全量行（对象、时间戳、计数）一字不差。
    expect(businessSnapshot(context)).toEqual(beforeData)

    // 正文对象一个不重传、不丢失，指针全量可回读。
    expect(context.content.store.size).toBe(beforeObjects)
    await expectContentIntact(context)
  })

  it("空 spaces 的 v8 库升级：不补默认空间，升级零写入", async () => {
    const context = await v8Context()
    // 极端数据形态：空间已被删空（连默认空间也不在），升级也不许“顺手补一行”。
    await context.db.exec("DELETE FROM ciki_space_members")
    await context.db.exec("DELETE FROM ciki_spaces")
    const beforeData = businessSnapshot(context)

    const result = await runSetup(context.env)
    if (!result.success) throw new Error(result.error)

    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "applied" }
    ])
    expect(ledgerNames(context)).toEqual(["schema_v1"])
    expect(
      context.db.db.prepare("SELECT COUNT(*) AS count FROM ciki_spaces").get()
    ).toEqual({ count: 0 })
    expect(businessSnapshot(context)).toEqual(beforeData)
  })

  it("升级后全链路可用：既有会话、登录、读页、搜索、评论、注册验证", async () => {
    const context = await v8Context()
    const { env } = context
    const seeded = await runSetup(env)
    if (!seeded.success) throw new Error(seeded.error)

    // 升级前就存在的会话仍然有效（会话与用户行没被动过）。
    const me = await jsonRequest(
      env,
      "GET",
      "/api/me",
      undefined,
      `ciki_session=${context.seed.sessionToken}`
    )
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ email: "admin@example.com" })

    // 存量密码的哈希照旧可用。
    const admin = await loginAs(env, "admin@example.com", V8_PASSWORD)

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

    // 注册 → 管理员批准 → 验证邮箱 → 登录（自助注册链路在新核算下照常）。
    await userSession(env, admin, "fresh@example.com")
  })
})

describe("全新库与幂等", () => {
  it("全新安装：账本一行 schema_v1，18 表与全部索引（含 username 唯一部分索引）", async () => {
    const context = makeContext()
    const result = await runSetup(context.env)
    if (!result.success) throw new Error(result.error)

    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "applied" }
    ])
    expect(ledgerNames(context)).toEqual(["schema_v1"])
    const tables = tableNames(context)
    for (const table of SCHEMA_TABLES) {
      expect(tables).toContain(tableName(PREFIX, table.name))
    }

    const indexes = indexNames(context)
    for (const ddl of SCHEMA_INDEXES) {
      const match = /INDEX IF NOT EXISTS (\S+)/.exec(ddl)
      if (!match) throw new Error(`index DDL has no name: ${ddl}`)
      expect(indexes).toContain(match[1].replaceAll("{prefix}", PREFIX))
    }
    const usernameIndex = (
      context.db.db.prepare("PRAGMA index_list(ciki_users)").all() as Array<{
        name: string
        unique: number
        partial: number
      }>
    ).find((entry) => entry.name === "ciki_users_username")
    expect(usernameIndex).toMatchObject({ unique: 1, partial: 1 })

    expect(
      context.db.db
        .prepare("SELECT id, slug, is_default FROM ciki_spaces")
        .all()
    ).toEqual([{ id: 1, slug: "space-1", is_default: 1 }])
  })

  it("已是 schema_v1 再点一次：全部 skipped、账本不变、数据不动", async () => {
    const context = await v8Context()
    const first = await runSetup(context.env)
    if (!first.success) throw new Error(first.error)
    const afterUpgrade = businessSnapshot(context)

    const again = await runSetup(context.env)
    if (!again.success) throw new Error(again.error)
    expect(again.migrations).toEqual([{ name: "schema_v1", status: "skipped" }])
    expect(ledgerNames(context)).toEqual(["schema_v1"])
    expect(businessSnapshot(context)).toEqual(afterUpgrade)
  })

  it("账本被改回 v7/v8 再点：仍收敛为一行（可重入，结果一致）", async () => {
    const context = await v8Context()
    const first = await runSetup(context.env)
    if (!first.success) throw new Error(first.error)
    const afterUpgrade = businessSnapshot(context)

    // 模拟「上次升级中断在记账之前」：结构与数据都在，账本还是旧样子。
    await context.db.db.prepare(`DELETE FROM ${migrationsTable(PREFIX)}`).run()
    for (const name of V8_LEDGER_ROWS) {
      await context.db.db
        .prepare(`INSERT INTO ${migrationsTable(PREFIX)} (name) VALUES (?)`)
        .run(name)
    }

    const again = await runSetup(context.env)
    if (!again.success) throw new Error(again.error)
    expect(again.migrations).toEqual([{ name: "schema_v1", status: "applied" }])
    expect(ledgerNames(context)).toEqual(["schema_v1"])
    expect(businessSnapshot(context)).toEqual(afterUpgrade)
  })

  it("账本只有 v7/v8 两行（没带更早的历史行）→ 同样坍缩为一行", async () => {
    const context = await v8Context(["schema_v7", "schema_v8"])
    const beforeData = businessSnapshot(context)

    const result = await runSetup(context.env)
    if (!result.success) throw new Error(result.error)

    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "applied" }
    ])
    expect(ledgerNames(context)).toEqual(["schema_v1"])
    expect(businessSnapshot(context)).toEqual(beforeData)
  })

  it("上次安装中断的半成品库（账本空、只建了几张表）：一次补齐", async () => {
    const context = makeContext()
    // 只跑到一半：users / user_2fa 已建，其余表都还没有。
    for (const statement of SCHEMA_TABLES.slice(0, 2)) {
      await context.db.exec(
        statement.ddl.replaceAll("{table}", tableName(PREFIX, statement.name))
      )
    }
    expect(tableNames(context)).not.toContain(tableName(PREFIX, "pages"))

    const result = await runSetup(context.env)
    if (!result.success) throw new Error(result.error)
    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "applied" }
    ])
    expect(ledgerNames(context)).toEqual(["schema_v1"])
    expect(tableNames(context)).toContain(tableName(PREFIX, "pages"))
  })
})

describe("不被接受的升级源：拒绝、指路、一字不动", () => {
  it("账本有 v7 没有 v8 → 拒绝（即使结构已经完整），数据与账本不动", async () => {
    const context = await v8Context(V7_LEDGER_ROWS)
    const beforeData = businessSnapshot(context)
    const beforeLedger = ledgerNames(context)

    const result = await runSetup(context.env)
    expect(result.success).toBe(false)
    if (result.success) throw new Error("expected rejection")
    expect(result.code).toBe("MIGRATION_REJECTED")
    expect(result.error).toContain("schema_v7")
    expect(result.error).toContain("schema_v8")
    expect(result.error).toContain("Nothing was changed")

    expect(ledgerNames(context)).toEqual(beforeLedger)
    expect(businessSnapshot(context)).toEqual(beforeData)
  })

  it("删掉 username 唯一索引冒充 v8 → 形态校验拦截", async () => {
    const context = await v8Context()
    await context.db.exec("DROP INDEX ciki_users_username")
    const beforeData = businessSnapshot(context)
    const beforeLedger = ledgerNames(context)

    const result = await runSetup(context.env)
    expect(result.success).toBe(false)
    if (result.success) throw new Error("expected rejection")
    expect(result.code).toBe("MIGRATION_REJECTED")
    expect(result.error).toContain("ciki_users_username")
    // 账本已记着 schema_v8 的这类库，“用上一版升一次”已无意义：指路必须是“按回退点还原”。
    expect(result.error).toContain("Time Travel bookmark")

    expect(ledgerNames(context)).toEqual(beforeLedger)
    expect(businessSnapshot(context)).toEqual(beforeData)
    expect(indexNames(context)).not.toContain("ciki_users_username")
  })

  it("更早形态（users 还带 base_currency）→ 拒绝，不改结构", async () => {
    const context = await v8Context()
    await context.db.exec(
      "ALTER TABLE ciki_users ADD COLUMN base_currency TEXT NOT NULL DEFAULT 'CNY'"
    )
    const beforeData = businessSnapshot(context)

    const result = await runSetup(context.env)
    expect(result.success).toBe(false)
    if (result.success) throw new Error("expected rejection")
    expect(result.code).toBe("MIGRATION_REJECTED")
    expect(result.error).toContain("base_currency")

    expect(ledgerNames(context)).toEqual([...V8_LEDGER_ROWS])
    expect(businessSnapshot(context)).toEqual(beforeData)
    expect(
      (
        context.db.db.prepare("PRAGMA table_info(ciki_users)").all() as Array<{
          name: string
        }>
      ).map((column) => column.name)
    ).toContain("base_currency")
  })

  it("账本写着 schema_v1 但结构还是更早形态 → 不静默跳过，按形态不符拒绝", async () => {
    const context = await v8Context(["schema_v1"])
    await context.db.exec(
      "ALTER TABLE ciki_users ADD COLUMN base_currency TEXT NOT NULL DEFAULT 'CNY'"
    )

    const result = await runSetup(context.env)
    expect(result.success).toBe(false)
    if (result.success) throw new Error("expected rejection")
    expect(result.code).toBe("MIGRATION_REJECTED")
    expect(result.error).toContain("base_currency")
    // 账本一字未动（仍是那条历史同名行）。
    expect(ledgerNames(context)).toEqual(["schema_v1"])
  })

  it("管理端点把指路信息带回页面（409 + MIGRATION_REJECTED）", async () => {
    const context = await v8Context(V7_LEDGER_ROWS)

    const res = await setupRequest(context.env)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; error: string }
    expect(body.code).toBe("MIGRATION_REJECTED")
    expect(body.error).toContain("schema_v8")
  })
})
