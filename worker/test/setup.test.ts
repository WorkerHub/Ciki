import { describe, expect, it } from "vitest"
import { getMigrations } from "../src/lib/migrations"
import {
  ensureLedgerTable,
  splitStatements
} from "../src/lib/migrations-runner"
import { runSetup } from "../src/lib/setup"
import { createSession } from "../src/core/session"
import {
  TEST_SETUP_SECRET,
  adminSession,
  initializedContext,
  jsonRequest,
  makeContext,
  request,
  userSession
} from "./support/app"

const PUBLIC_ID_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/

/** 造一个“升级前”的库：只应用前 n 条迁移（SQL 与执行器同口径）。 */
async function legacyContext(applied: number) {
  const context = makeContext()
  const prefix = "ciki_"
  const ledger = await ensureLedgerTable(context.env.DB, prefix)
  for (const migration of getMigrations(prefix).slice(0, applied)) {
    if (migration.prepare) await migration.prepare(context.env.DB, prefix)
    for (const statement of splitStatements(migration.sql)) {
      await context.env.DB.prepare(statement).run()
    }
    await context.env.DB.prepare(`INSERT INTO ${ledger} (name) VALUES (?)`)
      .bind(migration.name)
      .run()
  }
  return context
}

function setupRequest(env: Parameters<typeof request>[0], secret: string) {
  return request(env, "/api/setup", {
    method: "POST",
    headers: { "x-setup-secret": secret }
  })
}

describe("setup：初始化、幂等与密钥卫生", () => {
  it("错误密钥 403；正确密钥建表并回显 {success, tablePrefix, migrations}", async () => {
    const { env, db } = makeContext()

    const denied = await setupRequest(env, "wrong")
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: "Invalid setup secret" })

    const res = await setupRequest(env, TEST_SETUP_SECRET)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      tablePrefix: string
      migrations: Array<{ name: string; status: string }>
    }
    expect(body.success).toBe(true)
    expect(body.tablePrefix).toBe("ciki_")
    expect(body.migrations).toEqual([
      { name: "schema_v1", status: "applied" },
      { name: "schema_v2", status: "applied" },
      { name: "schema_v3", status: "applied" },
      { name: "schema_v4", status: "applied" },
      { name: "schema_v5", status: "applied" }
    ])

    const tables = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
    const names = tables.map((row) => row.name)
    for (const name of [
      "ciki_users",
      "ciki_user_2fa",
      "ciki_passkey_credentials",
      "ciki_sessions",
      "ciki_auth_challenges",
      "ciki_auth_counters",
      "ciki_system_settings",
      "ciki_pages",
      "ciki_page_revisions",
      "ciki_pages_fts",
      "ciki_import_tokens",
      "ciki_spaces",
      "ciki_space_members",
      "ciki_r2_cleanup_runs",
      "ciki_waker_executions",
      "ciki_schema_migrations"
    ]) {
      expect(names).toContain(name)
    }
  })

  it("重复 setup 只做幂等检查：全部 skipped，且不覆盖已有设置", async () => {
    const { env, db } = await initializedContext()
    await db.db
      .prepare("UPDATE ciki_system_settings SET value = '1' WHERE key = ?")
      .run("setup_page_enabled")

    const res = await setupRequest(env, TEST_SETUP_SECRET)
    const body = (await res.json()) as {
      migrations: Array<{ name: string; status: string }>
    }
    expect(body.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v2", status: "skipped" },
      { name: "schema_v3", status: "skipped" },
      { name: "schema_v4", status: "skipped" },
      { name: "schema_v5", status: "skipped" }
    ])

    const row = db.db
      .prepare("SELECT value FROM ciki_system_settings WHERE key = ?")
      .get("setup_page_enabled") as { value: string }
    expect(row.value).toBe("1")
  })

  it("存量库升级：只有 schema_v1 时再跑 setup 补 v2/v3，既有数据不动", async () => {
    const { env, db } = await initializedContext()

    // 模拟升级前的线上库：v1 已应用、v2/v3 还没跑过（表/列与账本行都不存在）。
    db.db.exec("DROP TABLE ciki_import_tokens")
    db.db.exec("DROP INDEX ciki_users_public_id")
    db.db.exec("ALTER TABLE ciki_users DROP COLUMN username")
    db.db.exec("ALTER TABLE ciki_users DROP COLUMN public_id")
    db.db.exec("ALTER TABLE ciki_users DROP COLUMN avatar_key")
    db.db
      .prepare("DELETE FROM ciki_schema_migrations WHERE name IN (?, ?)")
      .run("schema_v2", "schema_v3")
    const now = new Date().toISOString()
    db.db
      .prepare(
        "INSERT INTO ciki_pages (id, parent_id, title, sort_order, content_json, content_html, content_text, created_by, updated_by, created_at, updated_at) VALUES (?, NULL, ?, 0, '{}', '<p>x</p>', 'x', 'u1', 'u1', ?, ?)"
      )
      .run("keep-me", "存量页", now, now)

    const res = await setupRequest(env, TEST_SETUP_SECRET)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      migrations: Array<{ name: string; status: string }>
    }
    expect(body.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v2", status: "applied" },
      { name: "schema_v3", status: "applied" },
      { name: "schema_v4", status: "skipped" },
      { name: "schema_v5", status: "skipped" }
    ])

    const page = db.db
      .prepare("SELECT title FROM ciki_pages WHERE id = ?")
      .get("keep-me") as { title: string }
    expect(page.title).toBe("存量页")
    const table = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get("ciki_import_tokens") as { name: string }
    expect(table.name).toBe("ciki_import_tokens")
  })

  it("初始化完成后显式写关：state 的 initialized=true、enabled=false", async () => {
    const { env } = await initializedContext()
    const res = await request(env, "/api/setup/state")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ initialized: true, enabled: false })
  })

  it("setup 开关只门控页面：关掉后初始化接口仍可用", async () => {
    const { env } = await initializedContext()
    const res = await setupRequest(env, TEST_SETUP_SECRET)
    expect(res.status).toBe(200)
  })

  it("GET /api/setup 与 URL 带密钥一律拒绝（405），密钥只认请求头", async () => {
    const { env } = makeContext()
    const res = await request(env, "/api/setup?secret=whatever")

    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("POST")
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("X-Setup-Secret")
    })
  })

  it("前缀冲突（按 ciki 三件套判定）：库中已有 other_ 前缀的表 → 409，不新建表", async () => {
    const { env, db } = makeContext()
    await db.exec(
      "CREATE TABLE other_users (id TEXT); CREATE TABLE other_pages (id TEXT); CREATE TABLE other_pages_fts (page_id TEXT);"
    )

    const res = await setupRequest(env, TEST_SETUP_SECRET)
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      success: boolean
      code: string
      detectedPrefixes: string[]
    }
    expect(body.success).toBe(false)
    expect(body.code).toBe("PREFIX_CONFLICT")
    expect(body.detectedPrefixes).toEqual(["other_"])

    const names = (
      db.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(names.filter((name) => name.startsWith("ciki_"))).toEqual([])
  })

  it("只有 users+pages 没有 pages_fts 的不算本项目（不误伤共享库）", async () => {
    const { env, db } = makeContext()
    await db.exec(
      "CREATE TABLE other_users (id TEXT); CREATE TABLE other_pages (id TEXT);"
    )

    const res = await setupRequest(env, TEST_SETUP_SECRET)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean }
    expect(body.success).toBe(true)
  })

  it("当前前缀被别人的 users+pages 占用 → 409，不静默复用", async () => {
    const { env, db } = makeContext()
    await db.exec(
      "CREATE TABLE ciki_users (id TEXT, email TEXT); CREATE TABLE ciki_pages (id TEXT);"
    )

    const res = await setupRequest(env, TEST_SETUP_SECRET)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; error: string }
    expect(body.code).toBe("PREFIX_CONFLICT")
    expect(body.error).toContain("not ciki's schema")

    const names = (
      db.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(names.sort()).toEqual(["ciki_pages", "ciki_users"])
  })

  it("部分失败的本项目迁移（users 三列齐备）可以续跑修复", async () => {
    const { env, db } = makeContext()
    await db.exec(
      "CREATE TABLE ciki_users (id TEXT PRIMARY KEY, email TEXT, password_hash TEXT, approval_status TEXT, role TEXT);"
    )

    const res = await setupRequest(env, TEST_SETUP_SECRET)
    expect(res.status).toBe(200)
    const names = (
      db.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(names).toContain("ciki_pages")
    expect(names).toContain("ciki_system_settings")
  })

  it("setup 按 IP 限流：每 10 分钟 3 次，第 4 次 429", async () => {
    const { env } = makeContext()
    for (let i = 0; i < 3; i += 1) {
      const res = await setupRequest(env, TEST_SETUP_SECRET)
      expect(res.status).toBe(200)
    }
    const blocked = await setupRequest(env, TEST_SETUP_SECRET)
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ code: "RATE_LIMITED" })
  })

  it("管理面 setup：管理员免密钥可用，普通用户 403", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)

    const userRes = await jsonRequest(
      env,
      "POST",
      "/api/admin/setup",
      undefined,
      user
    )
    expect(userRes.status).toBe(403)

    const adminRes = await jsonRequest(
      env,
      "POST",
      "/api/admin/setup",
      undefined,
      admin
    )
    expect(adminRes.status).toBe(200)
    const body = (await adminRes.json()) as {
      success: boolean
      tablePrefix: string
      migrations: Array<{ status: string }>
    }
    expect(body.success).toBe(true)
    expect(body.tablePrefix).toBe("ciki_")
    expect(body.migrations[0].status).toBe("skipped")
  })
})

describe("schema_v3：身份列与存量回填", () => {
  interface BackfilledRow {
    id: string
    email: string
    username: string
    public_id: string
    avatar_key: string
    password_hash: string
    role: string
    created_at: string
  }

  it("存量库（v1+v2 有用户）升级：补三列并按邮箱前缀/随机串回填，既有列不动", async () => {
    const { env, db } = await legacyContext(2)
    const now = new Date().toISOString()
    const legacy: Array<[string, string, string]> = [
      ["u1", "alice@example.com", "salt1:hash1"],
      ["u2", "bob@example.com", "salt2:hash2"]
    ]
    for (const [id, email, passwordHash] of legacy) {
      db.db
        .prepare(
          "INSERT INTO ciki_users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(id, email, passwordHash, now, now)
    }

    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)
    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v2", status: "skipped" },
      { name: "schema_v3", status: "applied" },
      { name: "schema_v4", status: "applied" },
      { name: "schema_v5", status: "applied" }
    ])

    const columns = (
      db.db.prepare("PRAGMA table_info(ciki_users)").all() as Array<{
        name: string
      }>
    ).map((column) => column.name)
    expect(columns).toEqual(
      expect.arrayContaining(["username", "public_id", "avatar_key"])
    )

    const rows = db.db
      .prepare(
        "SELECT id, email, username, public_id, avatar_key, password_hash, role, created_at FROM ciki_users ORDER BY id"
      )
      .all() as unknown as BackfilledRow[]
    expect(rows.map((row) => row.username)).toEqual(["alice", "bob"])
    expect(rows.map((row) => row.avatar_key)).toEqual(["", ""])
    for (const row of rows) {
      expect(row.public_id).toMatch(PUBLIC_ID_RE)
    }
    expect(new Set(rows.map((row) => row.public_id)).size).toBe(2)
    expect(rows[0].password_hash).toBe("salt1:hash1")
    expect(rows[0].role).toBe("user")
    expect(rows[0].created_at).toBe(now)

    // 再跑一次：全部 skipped，public_id 不被重新生成。
    const again = await runSetup(env)
    if (!again.success) throw new Error(again.error)
    expect(again.migrations.map((migration) => migration.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "skipped",
      "skipped"
    ])
    const after = db.db
      .prepare("SELECT id, public_id FROM ciki_users ORDER BY id")
      .all() as unknown as Array<{ id: string; public_id: string }>
    expect(after).toEqual(
      rows.map((row) => ({ id: row.id, public_id: row.public_id }))
    )
  })

  it("列已存在但账本未记账（跑到一半）：续跑只补空值，不覆盖已有值", async () => {
    const { env, db } = await initializedContext()
    db.db
      .prepare("DELETE FROM ciki_schema_migrations WHERE name = ?")
      .run("schema_v3")
    const now = new Date().toISOString()
    db.db
      .prepare(
        "INSERT INTO ciki_users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run("u9", "carol@example.com", "s:h", now, now)
    db.db
      .prepare(
        "INSERT INTO ciki_users (id, email, username, public_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run("u8", "dave@example.com", "手动名", "ZZZZZZZZ", "s:h", now, now)

    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)
    expect(result.migrations[2]).toEqual({
      name: "schema_v3",
      status: "applied"
    })

    const rows = db.db
      .prepare("SELECT id, username, public_id FROM ciki_users ORDER BY id")
      .all() as unknown as Array<{
      id: string
      username: string
      public_id: string
    }>
    const carol = rows.find((row) => row.id === "u9")
    const dave = rows.find((row) => row.id === "u8")
    expect(carol?.username).toBe("carol")
    expect(carol?.public_id).toMatch(PUBLIC_ID_RE)
    expect(dave?.username).toBe("手动名")
    expect(dave?.public_id).toBe("ZZZZZZZZ")
  })

  it("存量用户数超过单批上限（每位两条更新）时照样全部回填", async () => {
    const { env, db } = await legacyContext(2)
    const now = new Date().toISOString()
    const total = 70
    const insert = db.db.prepare(
      "INSERT INTO ciki_users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    for (let i = 0; i < total; i += 1) {
      insert.run(`bulk-${i}`, `user${i}@example.com`, "s:h", now, now)
    }

    // 记录 db.batch 的每批语句数：70 位 × 2 条更新 = 140 条，应该拆成 2 批。
    const batchSizes: number[] = []
    const originalBatch = db.batch.bind(db)
    db.batch = async (statements) => {
      batchSizes.push(statements.length)
      return originalBatch(statements)
    }
    const result = await runSetup(env)
    db.batch = originalBatch

    if (!result.success) throw new Error(result.error)
    expect(result.migrations[2]).toEqual({
      name: "schema_v3",
      status: "applied"
    })
    expect(batchSizes.reduce((sum, size) => sum + size, 0)).toBe(total * 2)
    for (const size of batchSizes) expect(size).toBeLessThanOrEqual(100)

    const rows = db.db
      .prepare("SELECT email, username, public_id FROM ciki_users")
      .all() as unknown as Array<{
      email: string
      username: string
      public_id: string
    }>
    expect(rows).toHaveLength(total)
    expect(new Set(rows.map((row) => row.public_id)).size).toBe(total)
    for (const row of rows) {
      expect(row.public_id).toMatch(PUBLIC_ID_RE)
      expect(row.username).toBe(row.email.split("@")[0])
    }
  })
})

describe("schema_v4：空间与存量回填", () => {
  it("v3 存量库升级：建默认空间、回填页面与成员，旧用户可照常读写", async () => {
    const { env, db } = await legacyContext(3)
    const now = new Date().toISOString()

    const insertUser = db.db.prepare(
      `INSERT INTO ciki_users
        (id, email, username, public_id, password_hash, role, is_active, approval_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'salt:hash', ?, ?, ?, ?, ?)`
    )
    insertUser.run(
      "u-admin",
      "admin@example.com",
      "admin",
      "ADMIN222",
      "admin",
      1,
      "approved",
      now,
      now
    )
    insertUser.run(
      "u-editor",
      "editor@example.com",
      "editor",
      "EDITOR22",
      "user",
      1,
      "approved",
      now,
      now
    )
    insertUser.run(
      "u-pending",
      "pending@example.com",
      "pending",
      "PENDNG22",
      "user",
      0,
      "pending",
      now,
      now
    )

    const insertPage = db.db.prepare(
      `INSERT INTO ciki_pages
        (id, parent_id, title, sort_order, content_json, content_html, content_text,
         created_by, updated_by, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, '{"type":"doc"}', '<p>存量</p>', '存量', ?, ?, ?, ?, ?)`
    )
    insertPage.run(
      "p-root",
      null,
      "存量根页",
      0,
      "u-editor",
      "u-editor",
      now,
      now,
      null
    )
    insertPage.run(
      "p-child",
      "p-root",
      "存量子页",
      0,
      "u-editor",
      "u-editor",
      now,
      now,
      null
    )
    insertPage.run(
      "p-trashed",
      null,
      "回收站页",
      1,
      "u-editor",
      "u-editor",
      now,
      now,
      now
    )

    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)
    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v2", status: "skipped" },
      { name: "schema_v3", status: "skipped" },
      { name: "schema_v4", status: "applied" },
      { name: "schema_v5", status: "applied" }
    ])

    const space = db.db
      .prepare("SELECT * FROM ciki_spaces WHERE is_default = 1")
      .get() as {
      id: string
      name: string
      created_by: string
      is_default: number
    }
    expect(space.name).toBe("默认空间")
    expect(space.created_by).toBe("u-admin")
    expect(space.is_default).toBe(1)

    const pages = db.db
      .prepare("SELECT id, space_id FROM ciki_pages ORDER BY id")
      .all() as unknown as Array<{ id: string; space_id: string }>
    expect(pages.map((row) => row.space_id)).toEqual([
      space.id,
      space.id,
      space.id
    ])

    const members = db.db
      .prepare(
        "SELECT user_id, role FROM ciki_space_members WHERE space_id = ? ORDER BY user_id"
      )
      .all(space.id) as unknown as Array<{ user_id: string; role: string }>
    expect(members).toEqual([
      { user_id: "u-admin", role: "admin" },
      { user_id: "u-editor", role: "editor" },
      { user_id: "u-pending", role: "editor" }
    ])

    // 旧用户不需要重登也能读写：会话按用户 id 签发，权限来自迁移出的成员关系。
    const { token } = await createSession(env.DB, "ciki_", {
      userId: "u-editor"
    })
    const cookie = `ciki_session=${token}`
    const tree = await jsonRequest(env, "GET", "/api/pages", undefined, cookie)
    expect(tree.status).toBe(200)
    const treeBody = (await tree.json()) as Array<{ id: string; title: string }>
    expect(treeBody).toHaveLength(1)
    expect(treeBody[0].title).toBe("存量根页")

    const created = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        title: "迁移后新页",
        parentId: null,
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>新页</p>",
        contentText: "新页"
      },
      cookie
    )
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as { spaceId: string }
    expect(createdBody.spaceId).toBe(space.id)

    const admin = await createSession(env.DB, "ciki_", { userId: "u-admin" })
    const spaces = await jsonRequest(
      env,
      "GET",
      "/api/spaces",
      undefined,
      `ciki_session=${admin.token}`
    )
    expect(spaces.status).toBe(200)
    const spacesBody = (await spaces.json()) as Array<{
      id: string
      myRole: string
    }>
    expect(spacesBody).toEqual([
      { ...spacesBody[0], id: space.id, myRole: "admin" }
    ])

    // 迁移账本已记账：再跑一次 setup 全部 skipped，不会重复建默认空间。
    const again = await runSetup(env)
    if (!again.success) throw new Error(again.error)
    expect(again.migrations.every((row) => row.status === "skipped")).toBe(true)
    const count = db.db
      .prepare("SELECT COUNT(*) AS count FROM ciki_spaces")
      .get() as { count: number }
    expect(count.count).toBe(1)
  })
})
