import { describe, expect, it } from "vitest"
import {
  DEFAULT_SPACE_ID,
  DEFAULT_SPACE_NAMES,
  getMigrations
} from "../src/lib/migrations"
import { splitStatements } from "../src/lib/migrations-runner"
import { migrationsTable } from "../src/lib/tables"
import { runSetup } from "../src/lib/setup"
import type { SqliteD1 } from "./support/sqlite-d1"
import {
  TEST_SETUP_SECRET,
  adminSession,
  initializedContext,
  jsonRequest,
  makeContext,
  request,
  userSession
} from "./support/app"

/** 当前账本里的迁移名（顺序即执行顺序）：断言按它生成，不写死字面量。 */
const MIGRATION_NAMES = getMigrations("ciki_").map(
  (migration) => migration.name
)

/** 「全部 applied / 全部 skipped」的账本回显。 */
function migrationList(status: "applied" | "skipped") {
  return MIGRATION_NAMES.map((name) => ({ name, status }))
}

function setupRequest(
  env: Parameters<typeof request>[0],
  secret: string,
  init: RequestInit = {}
) {
  return request(env, "/api/setup", {
    ...init,
    method: "POST",
    headers: {
      "x-setup-secret": secret,
      ...((init.headers ?? {}) as Record<string, string>)
    }
  })
}

/** 请求体为 JSON 的 setup 调用（语言来源的用例用）。 */
function setupRequestWithLanguage(
  env: Parameters<typeof request>[0],
  secret: string,
  language: unknown,
  acceptLanguage?: string
) {
  return setupRequest(env, secret, {
    headers: {
      "content-type": "application/json",
      ...(acceptLanguage ? { "accept-language": acceptLanguage } : {})
    },
    body: JSON.stringify({ language })
  })
}

/** 库里默认空间的名字（播种结果）。 */
function defaultSpaceNameOf(db: SqliteD1): string {
  const row = db.db
    .prepare("SELECT name FROM ciki_spaces WHERE is_default = 1")
    .get() as { name: string }
  return row.name
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
    expect(body.migrations).toEqual(migrationList("applied"))

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
      "ciki_email_codes",
      "ciki_system_settings",
      "ciki_pages",
      "ciki_page_revisions",
      "ciki_pages_fts",
      "ciki_import_tokens",
      "ciki_spaces",
      "ciki_space_members",
      "ciki_r2_cleanup_runs",
      "ciki_waker_executions",
      "_ciki_schema_migrations"
    ]) {
      expect(names).toContain(name)
    }
    // 旧版账本名（无前导下划线）不得再建出来。
    expect(names).not.toContain("ciki_schema_migrations")
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
    expect(body.migrations).toEqual(migrationList("skipped"))

    const row = db.db
      .prepare("SELECT value FROM ciki_system_settings WHERE key = ?")
      .get("setup_page_enabled") as { value: string }
    expect(row.value).toBe("1")
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

  it("迁移中途失败（表只建了一半、账本未记账）后重跑 setup 能补齐并记账", async () => {
    const { env, db } = makeContext()
    // 复现“跑到一半失败”：先执行单一迁移的前几条语句，账本里没有记录。
    const partiallyApplied = splitStatements(
      getMigrations("ciki_")[0].sql
    ).slice(0, 5)
    for (const statement of partiallyApplied) {
      await env.DB.prepare(statement).run()
    }

    const res = await setupRequest(env, TEST_SETUP_SECRET)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      migrations: Array<{ name: string; status: string }>
    }
    expect(body.migrations).toEqual(migrationList("applied"))
    const names = (
      db.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(names).toContain("ciki_pages")
    expect(names).toContain("ciki_system_settings")
    expect(names).toContain("ciki_spaces")
    expect(names).toContain("ciki_email_codes")

    // 账本已记账：再跑一遍全部 skipped，不重复播种默认空间。
    const again = await setupRequest(env, TEST_SETUP_SECRET)
    const againBody = (await again.json()) as {
      migrations: Array<{ name: string; status: string }>
    }
    expect(againBody.migrations).toEqual(migrationList("skipped"))
    const spaces = db.db
      .prepare("SELECT COUNT(*) AS count FROM ciki_spaces")
      .get() as { count: number }
    expect(spaces.count).toBe(1)
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
    expect(body.migrations).toEqual(migrationList("skipped"))
  })
})

describe("初始化迁移：默认空间与播种", () => {
  it("全新 setup 建出默认空间（无用户时 created_by 为 0）并记满账本", async () => {
    const { env, db } = makeContext()

    const res = await setupRequest(env, TEST_SETUP_SECRET)
    expect(res.status).toBe(200)

    const spaces = db.db
      .prepare("SELECT id, name, is_default, created_by FROM ciki_spaces")
      .all() as Array<{
      id: number
      name: string
      is_default: number
      created_by: number
    }>
    expect(spaces).toEqual([
      {
        id: DEFAULT_SPACE_ID,
        name: DEFAULT_SPACE_NAMES.zh,
        is_default: 1,
        created_by: 0
      }
    ])

    const members = db.db
      .prepare("SELECT COUNT(*) AS count FROM ciki_space_members")
      .get() as { count: number }
    expect(members.count).toBe(0)

    const ledger = db.db
      .prepare("SELECT name FROM _ciki_schema_migrations")
      .all() as Array<{ name: string }>
    expect(ledger).toEqual(MIGRATION_NAMES.map((name) => ({ name })))

    // 身份三列与页面所属空间都在 CREATE 里建全，不需要 prepare 补列。
    const userColumns = (
      db.db.prepare("PRAGMA table_info(ciki_users)").all() as Array<{
        name: string
      }>
    ).map((column) => column.name)
    expect(userColumns).toEqual(
      expect.arrayContaining(["username", "avatar_key"])
    )
    // public_id 随整数化下线：对外身份只剩 username。
    expect(userColumns).not.toContain("public_id")
    const pageColumns = (
      db.db.prepare("PRAGMA table_info(ciki_pages)").all() as Array<{
        name: string
      }>
    ).map((column) => column.name)
    expect(pageColumns).toContain("space_id")
  })

  it("首个注册用户以 admin 进默认空间，新建页面缺省落默认空间", async () => {
    const { env, db } = await initializedContext()
    const cookie = await adminSession(env)

    const space = db.db
      .prepare("SELECT id FROM ciki_spaces WHERE is_default = 1")
      .get() as { id: string }
    const members = db.db
      .prepare(
        "SELECT user_id, role FROM ciki_space_members WHERE space_id = ?"
      )
      .all(space.id) as Array<{ user_id: string; role: string }>
    expect(members).toHaveLength(1)
    expect(members[0].role).toBe("admin")

    const created = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        title: "新页",
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
  })

  it("重复 setup 不重复建表、也不重复播种默认空间", async () => {
    const { env, db } = await initializedContext()

    const again = await runSetup(env)
    if (!again.success) throw new Error(again.error)
    expect(again.migrations).toEqual(migrationList("skipped"))

    const count = db.db
      .prepare("SELECT COUNT(*) AS count FROM ciki_spaces")
      .get() as { count: number }
    expect(count.count).toBe(1)
  })
})

/**
 * 默认空间名按建库语言播种（规格 §2.10）：英文实例不该开箱就看到中文。
 * 语言链（§2.3）在服务端只能看到后两级：显式入参 > Accept-Language > zh。
 */
describe("默认空间名：按建库语言播种", () => {
  it("请求体 language=en 播种为 Default Space，中文仍逐字不变", async () => {
    const english = makeContext()
    const enRes = await setupRequestWithLanguage(
      english.env,
      TEST_SETUP_SECRET,
      "en"
    )
    expect(enRes.status).toBe(200)
    expect(defaultSpaceNameOf(english.db)).toBe(DEFAULT_SPACE_NAMES.en)
    expect(DEFAULT_SPACE_NAMES.en).toBe("Default Space")

    // 中文库（不带语言）与显式 zh 都得到原样的「默认空间」。
    const zh = makeContext()
    await setupRequest(zh.env, TEST_SETUP_SECRET)
    expect(defaultSpaceNameOf(zh.db)).toBe("默认空间")
    expect(DEFAULT_SPACE_NAMES.zh).toBe("默认空间")
  })

  it("无请求体时按 Accept-Language 首个标签定语言", async () => {
    const english = makeContext()
    await setupRequest(english.env, TEST_SETUP_SECRET, {
      headers: { "accept-language": "en-US,en;q=0.9" }
    })
    expect(defaultSpaceNameOf(english.db)).toBe("Default Space")

    const chinese = makeContext()
    await setupRequest(chinese.env, TEST_SETUP_SECRET, {
      headers: { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" }
    })
    expect(defaultSpaceNameOf(chinese.db)).toBe("默认空间")
  })

  it("显式语言压过 Accept-Language：language=zh + en-US 仍是中文", async () => {
    const { env, db } = makeContext()
    await setupRequestWithLanguage(
      env,
      TEST_SETUP_SECRET,
      "zh",
      "en-US,en;q=0.9"
    )
    expect(defaultSpaceNameOf(db)).toBe("默认空间")
  })

  it("非法 language 不拦请求，回落到 Accept-Language", async () => {
    const { env, db } = makeContext()
    const res = await setupRequestWithLanguage(
      env,
      TEST_SETUP_SECRET,
      "fr",
      "en-US"
    )
    expect(res.status).toBe(200)
    expect(defaultSpaceNameOf(db)).toBe("Default Space")
  })

  it("中文建库后再带 en 跑一次 setup：全部 skipped，名字不改", async () => {
    const { env, db } = makeContext()
    await setupRequest(env, TEST_SETUP_SECRET)
    expect(defaultSpaceNameOf(db)).toBe("默认空间")

    const again = await setupRequestWithLanguage(env, TEST_SETUP_SECRET, "en")
    expect(again.status).toBe(200)
    const body = (await again.json()) as {
      migrations: Array<{ name: string; status: string }>
    }
    expect(body.migrations).toEqual(migrationList("skipped"))
    expect(defaultSpaceNameOf(db)).toBe("默认空间")
  })

  it("候选文案里没有分号（执行器按 `;` 切分语句）", () => {
    for (const name of Object.values(DEFAULT_SPACE_NAMES)) {
      expect(name).not.toContain(";")
    }
    // 英文播种 SQL 里是英文名，中文播种 SQL 里是中文名。
    expect(getMigrations("ciki_", "en")[0].sql).toContain("'Default Space'")
    expect(getMigrations("ciki_", "zh")[0].sql).toContain("'默认空间'")
  })
})

describe("schema_v1：基线结构上幂等空转", () => {
  it("已是基线结构 → 全部 skipped，不重复建表、不改数据、账本仍只一行", async () => {
    const { env, db } = makeContext()
    await setupRequest(env, TEST_SETUP_SECRET)
    const before = db.db
      .prepare("SELECT COUNT(*) AS count FROM ciki_spaces")
      .get() as { count: number }

    const again = await setupRequest(env, TEST_SETUP_SECRET)
    expect(again.status).toBe(200)
    const body = (await again.json()) as {
      migrations: Array<{ name: string; status: string }>
    }
    expect(body.migrations).toEqual(migrationList("skipped"))
    const after = db.db
      .prepare("SELECT COUNT(*) AS count FROM ciki_spaces")
      .get() as { count: number }
    expect(after.count).toBe(before.count)

    // 账本就是一行 schema_v1，不因重复升级多出行来。
    const ledger = db.db
      .prepare("SELECT name FROM _ciki_schema_migrations ORDER BY name")
      .all() as Array<{ name: string }>
    expect(ledger).toEqual([{ name: "schema_v1" }])
  })

  it("email_codes：复合主键 + purpose 校验，同键重发只留一行", async () => {
    const { db } = await initializedContext()
    const insert = db.db.prepare(
      `INSERT INTO ciki_email_codes
        (user_id, purpose, binding, code_hash, attempts, created_at, expires_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(user_id, purpose, binding) DO UPDATE SET code_hash = excluded.code_hash`
    )
    insert.run(1, "password_reset", "", "hash-1", 1, 601)
    insert.run(1, "password_reset", "", "hash-2", 1, 601)
    const rows = db.db
      .prepare("SELECT code_hash FROM ciki_email_codes WHERE user_id = 1")
      .all() as Array<{ code_hash: string }>
    expect(rows).toEqual([{ code_hash: "hash-2" }])

    expect(() =>
      insert.run(1, "unknown_purpose", "", "hash-3", 1, 601)
    ).toThrow()
  })
})

describe("迁移账本改名承接（规格 §4.4）", () => {
  function tableNames(db: SqliteD1): string[] {
    return (
      db.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
  }

  /** 建一张旧版账本（无前导下划线）并记下已应用的迁移名。 */
  async function createLegacyLedger(
    db: SqliteD1,
    legacy: string,
    applied: string[]
  ) {
    await db.exec(
      `CREATE TABLE ${legacy} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))`
    )
    for (const name of applied) {
      await db.db.prepare(`INSERT INTO ${legacy} (name) VALUES (?)`).run(name)
    }
  }

  /** 复现旧版部署留下的库：业务表已建好、账本仍是旧名（记录即当前迁移）。 */
  async function legacyDatabase(prefix: string, legacy: string) {
    // 先按当前版本建出真实的库（表 + 默认空间 + 默认设置），再把账本换成旧版部署的样子。
    const context = await initializedContext()
    await context.db.exec(`DROP TABLE ${migrationsTable(prefix)}`)
    await createLegacyLedger(context.db, legacy, MIGRATION_NAMES)
    return context
  }

  it("显式空前缀（TABLE_PREFIX=''）：新装账本为 _schema_migrations，业务表不带前缀", async () => {
    const { env, db } = makeContext({ TABLE_PREFIX: "" })

    const res = await setupRequest(env, TEST_SETUP_SECRET)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      tablePrefix: string
      migrations: Array<{ name: string; status: string }>
    }
    expect(body.tablePrefix).toBe("")
    expect(body.migrations).toEqual(migrationList("applied"))

    const names = tableNames(db)
    expect(names).toContain("_schema_migrations")
    expect(names).toContain("users")
    expect(names).toContain("pages")
    expect(names).not.toContain("schema_migrations")
    expect(names).not.toContain("_ciki_schema_migrations")
  })

  it("旧账本含已应用记录 → 升级改名承接，记录保留且迁移全 skipped", async () => {
    const { env, db } = await legacyDatabase("ciki_", "ciki_schema_migrations")

    const res = await setupRequest(env, TEST_SETUP_SECRET)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      migrations: Array<{ name: string; status: string }>
    }
    expect(body.success).toBe(true)
    // 账本里的记录被认出来：迁移不重跑。
    expect(body.migrations).toEqual(migrationList("skipped"))

    const names = tableNames(db)
    expect(names).toContain("_ciki_schema_migrations")
    expect(names).not.toContain("ciki_schema_migrations")

    const ledger = db.db
      .prepare("SELECT name FROM _ciki_schema_migrations")
      .all() as Array<{ name: string }>
    expect(ledger).toEqual(MIGRATION_NAMES.map((name) => ({ name })))
    const spaces = db.db
      .prepare("SELECT COUNT(*) AS count FROM ciki_spaces")
      .get() as { count: number }
    expect(spaces.count).toBe(1)
  })

  it("承接动作幂等：重复 setup 不重复改名、不丢记录", async () => {
    const { env, db } = await legacyDatabase("ciki_", "ciki_schema_migrations")

    for (let i = 0; i < 2; i += 1) {
      const res = await setupRequest(env, TEST_SETUP_SECRET)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        migrations: Array<{ name: string; status: string }>
      }
      // 改名承接只发生一次，记录不丢也不重复。
      expect(body.migrations).toEqual(migrationList("skipped"))
    }

    const names = tableNames(db)
    expect(names).toContain("_ciki_schema_migrations")
    expect(names).not.toContain("ciki_schema_migrations")
    const ledger = db.db
      .prepare("SELECT name FROM _ciki_schema_migrations")
      .all() as Array<{ name: string }>
    expect(ledger).toEqual(MIGRATION_NAMES.map((name) => ({ name })))
  })

  it("新旧账本同存 → 409 LEDGER_CONFLICT，两套账本与记录都不动", async () => {
    const { env, db } = makeContext()
    // 旧版部署遗留的账本行，字面量不参与判定（只要不是当前的 schema_v1）。
    await createLegacyLedger(db, "ciki_schema_migrations", ["schema_v0"])
    await createLegacyLedger(db, "_ciki_schema_migrations", MIGRATION_NAMES)

    const res = await setupRequest(env, TEST_SETUP_SECRET)
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      success: boolean
      code: string
      error: string
      ledgers: string[]
    }
    expect(body.success).toBe(false)
    expect(body.code).toBe("LEDGER_CONFLICT")
    expect(body.error).toContain("_ciki_schema_migrations")
    expect(body.error).toContain("ciki_schema_migrations")
    expect(body.ledgers).toEqual([
      "_ciki_schema_migrations",
      "ciki_schema_migrations"
    ])

    // 不动数据：两张账本原样在、记录一行不差，业务表一张也没建。
    expect(
      db.db
        .prepare("SELECT name FROM ciki_schema_migrations ORDER BY name")
        .all()
    ).toEqual([{ name: "schema_v0" }])
    expect(
      db.db
        .prepare("SELECT name FROM _ciki_schema_migrations ORDER BY name")
        .all()
    ).toEqual(MIGRATION_NAMES.map((name) => ({ name })))
    const names = tableNames(db)
    expect(names).not.toContain("ciki_users")
    expect(names).not.toContain("ciki_system_settings")
  })

  it("同名旧账本表但结构不符 → 409，不改名别人的表", async () => {
    const { env, db } = makeContext()
    db.exec("CREATE TABLE ciki_schema_migrations (id TEXT)")

    const res = await setupRequest(env, TEST_SETUP_SECRET)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; error: string }
    expect(body.code).toBe("LEDGER_CONFLICT")
    expect(body.error).toContain("ciki_schema_migrations")

    const names = tableNames(db)
    expect(names).toContain("ciki_schema_migrations")
    expect(names).not.toContain("_ciki_schema_migrations")
    expect(names).not.toContain("ciki_users")
  })
})
