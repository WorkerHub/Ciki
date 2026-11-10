/**
 * 只读接口令牌：生成、哈希落库、重置、吊销，以及与导入令牌的互不通用。
 *
 * 三个管理端点都是会话 Cookie 鉴权的 `/api/me/*`，形状对齐导入令牌；令牌本身只用于
 * `/api/read/*`。
 */
import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"
import type { Env } from "../src/types"

interface TokenStatus {
  active: boolean
  createdAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
}

const READ_TOKEN_PATH = "/api/me/read-token"

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
  env: Env,
  cookie: string
): Promise<{ token: string; createdAt: string }> {
  const res = await jsonRequest(env, "POST", READ_TOKEN_PATH, {}, cookie)
  expect(res.status).toBe(200)
  return (await res.json()) as { token: string; createdAt: string }
}

async function tokenStatus(env: Env, cookie: string): Promise<TokenStatus> {
  const res = await jsonRequest(env, "GET", READ_TOKEN_PATH, undefined, cookie)
  expect(res.status).toBe(200)
  return (await res.json()) as TokenStatus
}

function bearer(env: Env, token: string, path = "/api/read/tree") {
  return request(env, path, {
    headers: { authorization: `Bearer ${token}` }
  })
}

describe("只读令牌：生成、哈希落库、重置与吊销", () => {
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
    // 与会话/导入令牌同口径：32 字节随机 → base64url，无填充。
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(createdAt).toBe(new Date(createdAt).toISOString())

    const rows = db.db.prepare("SELECT * FROM ciki_read_tokens").all() as Array<
      Record<string, unknown>
    >
    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).toBe(await sha256Hex(token))
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/)
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
    expect(JSON.stringify(status)).not.toContain(token)

    const res = await bearer(env, token)
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toContain("no-store")

    // 用过之后 lastUsedAt 有值（设置页要显示它）。
    expect((await tokenStatus(env, admin)).lastUsedAt).not.toBeNull()
  })

  it("重置即覆盖：旧令牌立即失效、新令牌可用", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)

    const first = await issueToken(env, admin)
    expect((await bearer(env, first.token)).status).toBe(200)

    const second = await issueToken(env, admin)
    expect(second.token).not.toBe(first.token)
    expect((await bearer(env, first.token)).status).toBe(401)
    expect((await bearer(env, second.token)).status).toBe(200)

    // 覆盖不新增行（user_id 主键）。
    const rows = db.db
      .prepare("SELECT COUNT(*) AS count FROM ciki_read_tokens")
      .get() as {
      count: number
    }
    expect(rows.count).toBe(1)
    expect((await tokenStatus(env, admin)).revokedAt).toBeNull()
  })

  it("吊销后读接口 401；再吊销仍成功（幂等）；从未生成过 404", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { token } = await issueToken(env, admin)

    const revoke = await jsonRequest(
      env,
      "DELETE",
      READ_TOKEN_PATH,
      undefined,
      admin
    )
    expect(revoke.status).toBe(200)
    expect(await revoke.json()).toEqual({ success: true })
    expect((await bearer(env, token)).status).toBe(401)

    const status = await tokenStatus(env, admin)
    expect(status.active).toBe(false)
    expect(status.revokedAt).not.toBeNull()

    const again = await jsonRequest(
      env,
      "DELETE",
      READ_TOKEN_PATH,
      undefined,
      admin
    )
    expect(again.status).toBe(200)

    // 没有生成过令牌的用户：404。
    const user = await userSession(env, admin)
    const missing = await jsonRequest(
      env,
      "DELETE",
      READ_TOKEN_PATH,
      undefined,
      user
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: "Read token not found" })

    // 重新生成后重新可用（吊销只是标记，不是删除）。
    const reissued = await issueToken(env, admin)
    expect((await bearer(env, reissued.token)).status).toBe(200)
  })

  it("与导入令牌互不影响：各存各的表，各自可用", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)

    const importToken = (await (
      await jsonRequest(env, "POST", "/api/me/import-token", {}, admin)
    ).json()) as { token: string }
    await issueToken(env, admin)

    // 两张表各一行，互不覆盖。
    const importRows = db.db
      .prepare("SELECT COUNT(*) AS count FROM ciki_import_tokens")
      .get() as { count: number }
    const readRows = db.db
      .prepare("SELECT COUNT(*) AS count FROM ciki_read_tokens")
      .get() as { count: number }
    expect(importRows.count).toBe(1)
    expect(readRows.count).toBe(1)

    // 重置只读令牌不动导入令牌。
    const rotated = await issueToken(env, admin)
    const importStill = await request(env, "/api/import/parents", {
      headers: { authorization: `Bearer ${importToken.token}` }
    })
    expect(importStill.status).toBe(200)
    expect((await bearer(env, rotated.token)).status).toBe(200)
  })
})
