import { describe, expect, it } from "vitest"
import {
  TEST_SETUP_SECRET,
  adminSession,
  initializedContext,
  jsonRequest,
  makeContext,
  request,
  userSession
} from "./support/app"

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
    expect(body.migrations).toEqual([{ name: "schema_v1", status: "applied" }])

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
    expect(body.migrations).toEqual([{ name: "schema_v1", status: "skipped" }])

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

  it("前缀冲突：库中已有 other_ 前缀的 users+pages → 409，不新建表", async () => {
    const { env, db } = makeContext()
    await db.exec(
      "CREATE TABLE other_users (id TEXT); CREATE TABLE other_pages (id TEXT);"
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
