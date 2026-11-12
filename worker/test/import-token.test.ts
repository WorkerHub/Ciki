/**
 * 浏览器插件凭证（`/api/me/import-tokens`）：多行、互不影响、没有空间范围。
 *
 * `schema_v3` 起导入凭证一行一枚：创建是追加（不再「重置即覆盖」），吊销按行，
 * 列表只回未吊销行。明文只在 201 响应里出现一次，库里只有 SHA-256。
 */
import { describe, expect, it } from "vitest"
import {
  adminSession,
  createImportToken,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"

interface ImportTokenSummary {
  id: number
  name: string
  createdAt: string
  lastUsedAt: string | null
}

const LIST_PATH = "/api/me/import-tokens"
const DEFAULT_NAME = "浏览器插件"

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  )
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

async function tokens(
  env: Parameters<typeof adminSession>[0],
  cookie: string
): Promise<ImportTokenSummary[]> {
  const res = await jsonRequest(env, "GET", LIST_PATH, undefined, cookie)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { tokens: ImportTokenSummary[] }
  expect(Object.keys(body)).toEqual(["tokens"])
  return body.tokens
}

function bearer(
  env: Parameters<typeof request>[0],
  token: string,
  path = "/api/import/parents"
): Promise<Response> {
  return request(env, path, {
    headers: { authorization: `Bearer ${token}` }
  })
}

function revoke(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  id: number
): Promise<Response> {
  return jsonRequest(env, "DELETE", `${LIST_PATH}/${id}`, undefined, cookie)
}

describe("浏览器插件凭证：多行、哈希落库与默认名", () => {
  it("未生成过时列表为空；创建只回一次明文，库里只有 SHA-256", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)

    expect(await tokens(env, admin)).toEqual([])

    const issued = (await (
      await jsonRequest(env, "POST", LIST_PATH, {}, admin)
    ).json()) as { id: number; name: string; token: string }
    expect(Object.keys(issued).sort()).toEqual(["id", "name", "token"])
    expect(issued.name).toBe(DEFAULT_NAME)
    // 与会话令牌同口径：32 字节随机 → base64url，无填充。
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const rows = db.db
      .prepare("SELECT * FROM ciki_import_tokens")
      .all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(issued.id)
    expect(rows[0].name).toBe(DEFAULT_NAME)
    expect(rows[0].token_hash).toBe(await sha256Hex(issued.token))
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0].last_used_at).toBeNull()
    expect(rows[0].revoked_at).toBeNull()
    // 明文绝不落库。
    expect(JSON.stringify(rows[0])).not.toContain(issued.token)

    const list = await tokens(env, admin)
    expect(list).toHaveLength(1)
    expect(Object.keys(list[0]).sort()).toEqual([
      "createdAt",
      "id",
      "lastUsedAt",
      "name"
    ])
    expect(list[0].lastUsedAt).toBeNull()
    expect(JSON.stringify(list)).not.toContain(issued.token)

    // 令牌真的能用，且用后刷新自己的 lastUsedAt。
    const res = await bearer(env, issued.token)
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toContain("no-store")
    expect((await tokens(env, admin))[0].lastUsedAt).not.toBeNull()
  })

  it("自定义名 trim 后保留；空白回默认名；超 40 码点与非字符串 400", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const named = await createImportToken(env, admin, "  插件甲  ")
    expect(named.name).toBe("插件甲")

    const blank = await createImportToken(env, admin, "   ")
    expect(blank.name).toBe(DEFAULT_NAME)

    const tooLong = await jsonRequest(
      env,
      "POST",
      LIST_PATH,
      { name: "字".repeat(41) },
      admin
    )
    expect(tooLong.status).toBe(400)
    expect(await tooLong.json()).toEqual({ error: "Invalid token name" })

    const notString = await jsonRequest(
      env,
      "POST",
      LIST_PATH,
      { name: 42 },
      admin
    )
    expect(notString.status).toBe(400)

    const badJson = await request(env, LIST_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: admin },
      body: "{"
    })
    expect(badJson.status).toBe(400)
    expect(await badJson.json()).toEqual({ error: "Invalid request body" })
  })

  it("多行并存：吊销一枚只断一枚，另一枚照常；已吊销 / 他人 404", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const alice = await userSession(env, admin, "alice@example.com")
    const bob = await userSession(env, admin, "bob@example.com")

    const first = await createImportToken(env, alice, "甲")
    const second = await createImportToken(env, alice, "乙")
    expect((await bearer(env, first.token)).status).toBe(200)
    expect((await bearer(env, second.token)).status).toBe(200)
    expect((await tokens(env, alice)).map((row) => row.id)).toEqual([
      first.id,
      second.id
    ])

    const removed = await revoke(env, alice, first.id)
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ success: true })
    expect((await bearer(env, first.token)).status).toBe(401)
    expect((await bearer(env, second.token)).status).toBe(200)
    expect((await tokens(env, alice)).map((row) => row.id)).toEqual([second.id])

    // 已吊销再来 404（不是旧端点的幂等 200），他人 id 同样 404。
    const again = await revoke(env, alice, first.id)
    expect(again.status).toBe(404)
    expect(await again.json()).toEqual({ error: "Import token not found" })
    expect((await revoke(env, bob, second.id)).status).toBe(404)
    expect((await bearer(env, second.token)).status).toBe(200)

    const missing = await revoke(env, bob, 999999)
    expect(missing.status).toBe(404)
  })

  it("管理端点要会话：Bearer 令牌调不动；导入接口不认会话 Cookie", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { id, token } = await createImportToken(env, admin)

    for (const [method, path] of [
      ["GET", LIST_PATH],
      ["POST", LIST_PATH],
      ["DELETE", `${LIST_PATH}/${id}`]
    ] as const) {
      const res = await request(env, path, {
        method,
        headers: { authorization: `Bearer ${token}` }
      })
      expect(res.status).toBe(401)
    }

    // 会话 Cookie 不能替代 Bearer 令牌调导入接口（职责分离）。
    for (const path of [
      "/api/import/parents",
      "/api/import/check",
      "/api/import/files",
      "/api/import/pages"
    ]) {
      const res = await request(env, path, {
        method: path === "/api/import/parents" ? "GET" : "POST",
        headers: { cookie: admin, "content-type": "application/json" },
        body: path === "/api/import/parents" ? undefined : "{}"
      })
      expect(res.status).toBe(401)
    }
  })

  it("用户被停用后令牌立即失效（每次回表连 users 校验）", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const alice = await userSession(env, admin, "alice@example.com")
    const { token } = await createImportToken(env, alice)
    expect((await bearer(env, token)).status).toBe(200)

    const aliceRow = db.db
      .prepare("SELECT id FROM ciki_users WHERE email = ?")
      .get("alice@example.com") as { id: string }
    const res = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${aliceRow.id}`,
      { isActive: false },
      admin
    )
    expect(res.status).toBe(200)

    expect((await bearer(env, token)).status).toBe(401)
  })

  it("创建限流：10 次 / 5 分钟，第 11 次 429", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    for (let i = 0; i < 10; i++) {
      await createImportToken(env, admin)
    }
    const res = await jsonRequest(env, "POST", LIST_PATH, {}, admin)
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ code: "RATE_LIMITED" })
  })
})
