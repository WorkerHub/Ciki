import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"

interface TokenStatus {
  active: boolean
  createdAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  )
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

async function issueToken(
  env: Parameters<typeof adminSession>[0],
  cookie: string
): Promise<{ token: string; createdAt: string }> {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/me/import-token",
    undefined,
    cookie
  )
  expect(res.status).toBe(200)
  return (await res.json()) as { token: string; createdAt: string }
}

async function tokenStatus(
  env: Parameters<typeof adminSession>[0],
  cookie: string
): Promise<TokenStatus> {
  const res = await jsonRequest(
    env,
    "GET",
    "/api/me/import-token",
    undefined,
    cookie
  )
  expect(res.status).toBe(200)
  return (await res.json()) as TokenStatus
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

describe("个人导入令牌：生成、哈希落库、重置与吊销", () => {
  it("未生成时状态恒 inactive；生成只回一次明文，库里只有 SHA-256", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)

    expect(await tokenStatus(env, admin)).toEqual({
      active: false,
      createdAt: null,
      lastUsedAt: null,
      revokedAt: null
    })

    const { token, createdAt } = await issueToken(env, admin)
    // 与会话令牌同口径：32 字节随机 → base64url，无填充。
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(createdAt).toBe(new Date(createdAt).toISOString())

    const rows = db.db
      .prepare("SELECT * FROM ciki_import_tokens")
      .all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBeTruthy()
    expect(rows[0].token_hash).toBe(await sha256Hex(token))
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0].created_at).toBe(createdAt)
    expect(rows[0].last_used_at).toBeNull()
    expect(rows[0].revoked_at).toBeNull()
    // 明文绝不落库。
    expect(JSON.stringify(rows[0])).not.toContain(token)

    const status = await tokenStatus(env, admin)
    expect(status).toEqual({
      active: true,
      createdAt,
      lastUsedAt: null,
      revokedAt: null
    })
    // 状态响应里没有哈希、没有明文。
    expect(JSON.stringify(status)).not.toContain(token)

    // 令牌真的能用。
    const res = await bearer(env, token)
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toContain("no-store")
  })

  it("重置即覆盖：旧令牌立即失效、新令牌可用；吊销后 401 且状态可查", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)

    const first = await issueToken(env, admin)
    expect((await bearer(env, first.token)).status).toBe(200)

    const second = await issueToken(env, admin)
    expect(second.token).not.toBe(first.token)
    expect((await bearer(env, first.token)).status).toBe(401)
    expect((await bearer(env, second.token)).status).toBe(200)
    // 每用户只有一行：重置是覆盖，不是新增。
    const count = db.db
      .prepare("SELECT COUNT(*) AS n FROM ciki_import_tokens")
      .get() as { n: number }
    expect(count.n).toBe(1)

    const beforeRevoke = await tokenStatus(env, admin)
    expect(beforeRevoke.active).toBe(true)
    expect(beforeRevoke.lastUsedAt).not.toBeNull()

    const revoke = await jsonRequest(
      env,
      "DELETE",
      "/api/me/import-token",
      undefined,
      admin
    )
    expect(revoke.status).toBe(200)
    expect(await revoke.json()).toEqual({ success: true })

    expect((await bearer(env, second.token)).status).toBe(401)
    const afterRevoke = await tokenStatus(env, admin)
    expect(afterRevoke.active).toBe(false)
    expect(afterRevoke.revokedAt).not.toBeNull()
    expect(afterRevoke.lastUsedAt).toBe(beforeRevoke.lastUsedAt)

    // 吊销是幂等的：已吊销再删仍成功，从未生成过才 404。
    const again = await jsonRequest(
      env,
      "DELETE",
      "/api/me/import-token",
      undefined,
      admin
    )
    expect(again.status).toBe(200)
  })

  it("从未生成过就吊销 → 404", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const res = await jsonRequest(
      env,
      "DELETE",
      "/api/me/import-token",
      undefined,
      admin
    )
    expect(res.status).toBe(404)
  })

  it("重置后旧令牌（含被重置前用过的）不能再用；每用户互不影响", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const alice = await userSession(env, admin, "alice@example.com")
    const bob = await userSession(env, admin, "bob@example.com")

    const aliceToken = await issueToken(env, alice)
    const bobToken = await issueToken(env, bob)
    expect((await bearer(env, aliceToken.token)).status).toBe(200)
    expect((await bearer(env, bobToken.token)).status).toBe(200)

    const rotated = await issueToken(env, alice)
    expect((await bearer(env, aliceToken.token)).status).toBe(401)
    expect((await bearer(env, rotated.token)).status).toBe(200)
    // 吊销 alice 不影响 bob。
    await jsonRequest(env, "DELETE", "/api/me/import-token", undefined, alice)
    expect((await bearer(env, rotated.token)).status).toBe(401)
    expect((await bearer(env, bobToken.token)).status).toBe(200)
  })

  it("令牌管理接口要会话：Bearer 令牌调不动；导入接口不认会话 Cookie", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { token } = await issueToken(env, admin)

    for (const [method, path] of [
      ["GET", "/api/me/import-token"],
      ["POST", "/api/me/import-token"],
      ["DELETE", "/api/me/import-token"]
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
    const { token } = await issueToken(env, alice)
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

  it("生成/重置限流：10 次 / 5 分钟，第 11 次 429", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    for (let i = 0; i < 10; i++) {
      await issueToken(env, admin)
    }
    const res = await jsonRequest(
      env,
      "POST",
      "/api/me/import-token",
      undefined,
      admin
    )
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ code: "RATE_LIMITED" })
  })
})
