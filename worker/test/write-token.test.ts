/**
 * 读写接口令牌：生成、哈希落库、重置、吊销，以及与只读令牌 / 导入令牌的互不通用。
 *
 * `schema_v3` 起读写令牌同存 `api_tokens`、按 `kind` 区分；这里同时钉住
 * `findApiToken` 的 kind 过滤（写接口只接受 write）与旧端点的兼容语义。
 */
import { describe, expect, it } from "vitest"
import { findApiToken } from "../src/core/api-token"
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
  spaceIds: number[] | null
}

const WRITE_TOKEN_PATH = "/api/me/write-token"

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
  const res = await jsonRequest(env, "POST", WRITE_TOKEN_PATH, {}, cookie)
  expect(res.status).toBe(200)
  return (await res.json()) as { token: string; createdAt: string }
}

async function tokenStatus(env: Env, cookie: string): Promise<TokenStatus> {
  const res = await jsonRequest(env, "GET", WRITE_TOKEN_PATH, undefined, cookie)
  expect(res.status).toBe(200)
  return (await res.json()) as TokenStatus
}

describe("读写令牌：生成、哈希落库、重置与吊销", () => {
  it("未生成时状态恒 inactive；生成只回一次明文，库里只有 SHA-256", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)

    expect(await tokenStatus(env, admin)).toEqual({
      active: false,
      createdAt: null,
      lastUsedAt: null,
      revokedAt: null,
      spaceIds: null
    })

    const { token, createdAt } = await issueToken(env, admin)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(createdAt).toBe(new Date(createdAt).toISOString())

    const rows = db.db
      .prepare(
        "SELECT * FROM ciki_api_tokens WHERE kind = 'write' AND revoked_at IS NULL"
      )
      .all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).toBe(await sha256Hex(token))
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0].last_used_at).toBeNull()
    expect(rows[0].revoked_at).toBeNull()
    expect(JSON.stringify(rows[0])).not.toContain(token)

    // 同表不同 kind：读写令牌不会被当成只读令牌。
    const readRows = db.db
      .prepare(
        "SELECT COUNT(*) AS count FROM ciki_api_tokens WHERE kind = 'read'"
      )
      .get() as { count: number }
    expect(readRows.count).toBe(0)

    const status = await tokenStatus(env, admin)
    expect(status).toEqual({
      active: true,
      createdAt,
      lastUsedAt: null,
      revokedAt: null,
      spaceIds: null
    })
    expect(JSON.stringify(status)).not.toContain(token)
  })

  it("重置即覆盖：旧令牌校验不再命中、新令牌命中，覆盖不新增行", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)

    const first = await issueToken(env, admin)
    const second = await issueToken(env, admin)
    expect(second.token).not.toBe(first.token)

    expect(
      await findApiToken(env.DB, "ciki_", first.token, { kind: "write" })
    ).toBeNull()
    expect(
      await findApiToken(env.DB, "ciki_", second.token, { kind: "write" })
    ).not.toBeNull()

    // 重置是「吊销旧行 + 建新行」：有效写令牌始终只有一枚。
    const rows = db.db
      .prepare(
        "SELECT COUNT(*) AS count FROM ciki_api_tokens WHERE kind = 'write' AND revoked_at IS NULL"
      )
      .get() as { count: number }
    expect(rows.count).toBe(1)
    expect((await tokenStatus(env, admin)).revokedAt).toBeNull()
  })

  it("吊销后令牌校验不再命中；再吊销仍成功（幂等）；从未生成过 404", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { token } = await issueToken(env, admin)

    const revoke = await jsonRequest(
      env,
      "DELETE",
      WRITE_TOKEN_PATH,
      undefined,
      admin
    )
    expect(revoke.status).toBe(200)
    expect(await revoke.json()).toEqual({ success: true })
    expect(
      await findApiToken(env.DB, "ciki_", token, { kind: "write" })
    ).toBeNull()

    const status = await tokenStatus(env, admin)
    expect(status.active).toBe(false)
    expect(status.revokedAt).not.toBeNull()

    const again = await jsonRequest(
      env,
      "DELETE",
      WRITE_TOKEN_PATH,
      undefined,
      admin
    )
    expect(again.status).toBe(200)

    const user = await userSession(env, admin)
    const missing = await jsonRequest(
      env,
      "DELETE",
      WRITE_TOKEN_PATH,
      undefined,
      user
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: "Write token not found" })

    const reissued = await issueToken(env, admin)
    expect(
      await findApiToken(env.DB, "ciki_", reissued.token, { kind: "write" })
    ).not.toBeNull()
  })

  it("管理端点要会话：无 Cookie 401", async () => {
    const { env } = await initializedContext()
    const res = await request(env, WRITE_TOKEN_PATH)
    expect(res.status).toBe(401)
  })

  it("kind 隔离：只读令牌过不了写接口过滤、写令牌过不了只读过滤，findApiToken 报出种类", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const readToken = (await (
      await jsonRequest(env, "POST", "/api/me/read-token", {}, admin)
    ).json()) as { token: string }
    const writeToken = await issueToken(env, admin)

    // 写接口的 kind 过滤：只读令牌查不到；只读过滤同理。
    expect(
      await findApiToken(env.DB, "ciki_", writeToken.token, { kind: "read" })
    ).toBeNull()
    expect(
      await findApiToken(env.DB, "ciki_", readToken.token, { kind: "write" })
    ).toBeNull()

    expect(await findApiToken(env.DB, "ciki_", readToken.token)).toMatchObject({
      kind: "read"
    })
    expect(await findApiToken(env.DB, "ciki_", writeToken.token)).toMatchObject(
      {
        kind: "write"
      }
    )
    expect(await findApiToken(env.DB, "ciki_", "not-a-token")).toBeNull()
  })

  it("生成限流：按用户 10 次 / 5 分钟，第 11 次 429", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    for (let i = 0; i < 10; i++) await issueToken(env, admin)

    const limited = await jsonRequest(env, "POST", WRITE_TOKEN_PATH, {}, admin)
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED" })
  })
})
