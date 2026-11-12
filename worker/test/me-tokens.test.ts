/**
 * 接口令牌管理 API（`/api/me/tokens`，会话 Cookie 鉴权）：多行、按 id 操作。
 *
 * 冻结口径：列表只回未吊销行（按 created_at 升序），创建是追加（kind 建行后固定、
 * 明文只回一次），空间范围缺省/null = 不限、空数组与不可见 id 整单 400 零写入；
 * 改名 / 改范围 / 吊销只作用于本人的未吊销行，其余一律 404。
 */
import { describe, expect, it } from "vitest"
import {
  adminSession,
  createApiToken,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"
import type { Env } from "../src/types"

interface TokenSummary {
  id: number
  name: string
  kind: "read" | "write"
  spaceIds: number[] | null
  createdAt: string
  lastUsedAt: string | null
}

const TOKENS_PATH = "/api/me/tokens"
const DEFAULT_READ_NAME = "只读 Token"
const DEFAULT_WRITE_NAME = "读写 Token"

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  )
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

async function tokens(env: Env, cookie: string): Promise<TokenSummary[]> {
  const res = await jsonRequest(env, "GET", TOKENS_PATH, undefined, cookie)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { tokens: TokenSummary[] }
  expect(Object.keys(body)).toEqual(["tokens"])
  return body.tokens
}

function postToken(env: Env, cookie: string, body: unknown): Promise<Response> {
  return jsonRequest(env, "POST", TOKENS_PATH, body, cookie)
}

function renameToken(
  env: Env,
  cookie: string,
  id: number | string,
  body?: unknown
): Promise<Response> {
  return jsonRequest(env, "PUT", `${TOKENS_PATH}/${id}/name`, body, cookie)
}

function setSpaces(
  env: Env,
  cookie: string,
  id: number | string,
  body?: unknown
): Promise<Response> {
  return jsonRequest(env, "PUT", `${TOKENS_PATH}/${id}/spaces`, body, cookie)
}

function revokeToken(
  env: Env,
  cookie: string,
  id: number | string
): Promise<Response> {
  return jsonRequest(env, "DELETE", `${TOKENS_PATH}/${id}`, undefined, cookie)
}

async function createSpace(
  env: Env,
  cookie: string,
  name: string
): Promise<number> {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/spaces",
    { name, description: "" },
    cookie
  )
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: number }).id
}

function bearer(env: Env, token: string, path: string): Promise<Response> {
  return request(env, path, {
    headers: { authorization: `Bearer ${token}` }
  })
}

describe("接口令牌：列表与创建", () => {
  it("空列表；多枚并存、按 created_at 升序、只回未吊销、精确键集", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    expect(await tokens(env, admin)).toEqual([])

    const first = await createApiToken(env, admin, "read", { name: "第一枚" })
    const second = await createApiToken(env, admin, "write", { name: "第二枚" })
    const third = await createApiToken(env, admin, "read")
    const fourth = await createApiToken(env, admin, "write")

    const list = await tokens(env, admin)
    expect(list.map((row) => row.id)).toEqual([
      first.id,
      second.id,
      third.id,
      fourth.id
    ])
    for (const row of list) {
      expect(Object.keys(row).sort()).toEqual([
        "createdAt",
        "id",
        "kind",
        "lastUsedAt",
        "name",
        "spaceIds"
      ])
      expect(JSON.stringify(row)).not.toContain(first.token)
    }
    expect(list[0]).toMatchObject({ kind: "read", name: "第一枚" })
    expect(list[1]).toMatchObject({ kind: "write", name: "第二枚" })
    // 名称留空按 kind 自动命名；范围缺省 = 不限制。
    expect(list[2]).toMatchObject({
      kind: "read",
      name: DEFAULT_READ_NAME,
      spaceIds: null
    })
    expect(list[3]).toMatchObject({
      kind: "write",
      name: DEFAULT_WRITE_NAME,
      spaceIds: null
    })
  })

  it("创建只回一次明文，库里只有 SHA-256；range 去重升序后落库", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const a = await createSpace(env, admin, "甲空间")
    const b = await createSpace(env, admin, "乙空间")

    const res = await postToken(env, admin, {
      kind: "write",
      name: "  部署用  ",
      spaceIds: [b, a, a]
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as {
      id: number
      name: string
      kind: string
      spaceIds: number[] | null
      token: string
    }
    expect(Object.keys(created).sort()).toEqual([
      "id",
      "kind",
      "name",
      "spaceIds",
      "token"
    ])
    expect(created.name).toBe("部署用")
    expect(created.kind).toBe("write")
    expect(created.spaceIds).toEqual([a, b])
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const rows = db.db
      .prepare("SELECT * FROM ciki_api_tokens WHERE id = ?")
      .all(created.id) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).toBe(await sha256Hex(created.token))
    expect(JSON.stringify(rows[0])).not.toContain(created.token)

    const scopes = db.db
      .prepare(
        "SELECT space_id FROM ciki_token_space_scopes WHERE token_id = ? ORDER BY space_id"
      )
      .all(created.id) as Array<{ space_id: number }>
    expect(scopes.map((row) => row.space_id)).toEqual([a, b])

    // 列表回读同一份范围；写令牌也认它自己的范围。
    expect(
      (await tokens(env, admin)).find((row) => row.id === created.id)
    ).toMatchObject({ spaceIds: [a, b] })
  })

  it("kind 必填且只认 read/write；名称非字符串或超 40 码点 400", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)

    for (const body of [{}, { kind: "admin" }, { kind: "READ" }]) {
      const res = await postToken(env, admin, body)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "kind must be read or write" })
    }

    for (const body of [
      { kind: "read", name: 42 },
      { kind: "read", name: "字".repeat(41) }
    ]) {
      const res = await postToken(env, admin, body)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "Invalid token name" })
    }

    // 空体只缺 kind：不是「Invalid request body」；坏 JSON / 非对象才是。
    const empty = await request(env, TOKENS_PATH, {
      method: "POST",
      headers: { cookie: admin }
    })
    expect(empty.status).toBe(400)
    expect(await empty.json()).toEqual({ error: "kind must be read or write" })

    for (const raw of ["{", "[]", "1", "null"]) {
      const res = await request(env, TOKENS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: admin },
        body: raw
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "Invalid request body" })
    }

    const count = db.db
      .prepare("SELECT COUNT(*) AS n FROM ciki_api_tokens")
      .get() as { n: number }
    expect(count.n).toBe(0)
  })

  it("空间范围：缺省/null 不限；空数组与不可见 id 整单 400 且零写入", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const visible = await createSpace(env, admin, "可见空间")

    const unlimited = await createApiToken(env, admin, "read")
    expect(unlimited.spaceIds).toBeNull()
    const explicitNull = await createApiToken(env, admin, "read", {
      spaceIds: null
    })
    expect(explicitNull.spaceIds).toBeNull()

    const empty = await postToken(env, admin, { kind: "read", spaceIds: [] })
    expect(empty.status).toBe(400)
    expect(await empty.json()).toMatchObject({ code: "INVALID_SPACE_SCOPE" })

    // 不存在的空间 id：与「不可见」同一口径，整单 400，不建令牌行。
    const missing = await postToken(env, admin, {
      kind: "read",
      spaceIds: [visible, 999999]
    })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ code: "INVALID_SPACE_SCOPE" })

    // 非成员（普通用户）同样不能把不可见空间写进范围。
    const user = await userSession(env, admin)
    const hidden = await createSpace(env, admin, "别人的空间")
    const denied = await postToken(env, user, {
      kind: "read",
      spaceIds: [hidden]
    })
    expect(denied.status).toBe(400)

    const rows = db.db
      .prepare("SELECT COUNT(*) AS n FROM ciki_api_tokens")
      .get() as { n: number }
    // 只有两枚不限范围的令牌；三次失败的创建一行都没写。
    expect(rows.n).toBe(2)
  })

  it("创建限流按 kind 分桶：read 桶 10 次后第 11 次 429，write 桶不受影响", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    for (let i = 0; i < 10; i++) {
      await createApiToken(env, admin, "read")
    }
    const limited = await postToken(env, admin, { kind: "read" })
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED" })

    const write = await postToken(env, admin, { kind: "write" })
    expect(write.status).toBe(201)
  })
})

describe("接口令牌：改名、改范围、吊销", () => {
  it("改名生效且不动 kind；空白 / 超限 400；他人 / 不存在 / 已吊销 / 坏 id 404", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const other = await userSession(env, admin)
    const { id } = await createApiToken(env, admin, "write", { name: "旧名" })

    const ok = await renameToken(env, admin, id, { name: "  新名  " })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ success: true })
    expect(
      (await tokens(env, admin)).find((row) => row.id === id)
    ).toMatchObject({ name: "新名", kind: "write" })

    for (const body of [{ name: "   " }, { name: "" }, {}, { name: 7 }]) {
      const res = await renameToken(env, admin, id, body)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: "Token name must be 1-40 characters"
      })
    }
    const tooLong = await renameToken(env, admin, id, {
      name: "字".repeat(41)
    })
    expect(tooLong.status).toBe(400)

    expect((await renameToken(env, other, id, { name: "越权" })).status).toBe(
      404
    )
    expect((await renameToken(env, admin, 999999, { name: "无" })).status).toBe(
      404
    )
    for (const badId of ["abc", "0", "01", "1.5"]) {
      expect(
        (await renameToken(env, admin, badId, { name: "无" })).status
      ).toBe(404)
    }

    await revokeToken(env, admin, id)
    const revoked = await renameToken(env, admin, id, { name: "已吊销" })
    expect(revoked.status).toBe(404)
    expect(await revoked.json()).toEqual({ error: "Token not found" })
  })

  it("改范围：键必填、null 清除、去重升序、空数组与不可见 id 400 不动旧值", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const a = await createSpace(env, admin, "甲空间")
    const b = await createSpace(env, admin, "乙空间")
    const { id, token } = await createApiToken(env, admin, "read", {
      spaceIds: [a]
    })

    const set = await setSpaces(env, admin, id, { spaceIds: [b, a, b] })
    expect(set.status).toBe(200)
    expect(await set.json()).toEqual({ spaceIds: [a, b] })
    expect((await tokens(env, admin))[0].spaceIds).toEqual([a, b])

    // 只改范围、不换令牌：同一枚明文继续可用。
    expect((await bearer(env, token, "/api/read/tree")).status).toBe(200)

    for (const body of [{}, { spaceIds: [] }, { spaceIds: [a, 999999] }]) {
      const res = await setSpaces(env, admin, id, body)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ code: "INVALID_SPACE_SCOPE" })
    }
    expect((await tokens(env, admin))[0].spaceIds).toEqual([a, b])

    const cleared = await setSpaces(env, admin, id, { spaceIds: null })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toEqual({ spaceIds: null })
    expect((await tokens(env, admin))[0].spaceIds).toBeNull()

    const badJson = await request(env, `${TOKENS_PATH}/${id}/spaces`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: admin },
      body: "[]"
    })
    expect(badJson.status).toBe(400)
    expect(await badJson.json()).toEqual({ error: "Invalid request body" })
  })

  it("改范围的身份边界：他人 404、已吊销 404、不存在 404", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const other = await userSession(env, admin)
    const a = await createSpace(env, admin, "甲空间")
    const { id } = await createApiToken(env, admin, "read")

    // 范围用 null（校验必过）才能把断言落到「非本人 404」上：非法范围会先回 400。
    expect((await setSpaces(env, other, id, { spaceIds: null })).status).toBe(
      404
    )
    expect(
      (await setSpaces(env, admin, 999999, { spaceIds: [a] })).status
    ).toBe(404)

    await revokeToken(env, admin, id)
    const revoked = await setSpaces(env, admin, id, { spaceIds: [a] })
    expect(revoked.status).toBe(404)
    expect(await revoked.json()).toEqual({ error: "Token not found" })
  })

  it("吊销：立即 401、列表消失、再吊销与他人 404；两枚只断一枚", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const other = await userSession(env, admin)
    const first = await createApiToken(env, admin, "read")
    const second = await createApiToken(env, admin, "read")

    const res = await revokeToken(env, admin, first.id)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect((await bearer(env, first.token, "/api/read/tree")).status).toBe(401)
    expect((await bearer(env, second.token, "/api/read/tree")).status).toBe(200)
    expect((await tokens(env, admin)).map((row) => row.id)).toEqual([second.id])

    const again = await revokeToken(env, admin, first.id)
    expect(again.status).toBe(404)
    expect(await again.json()).toEqual({ error: "Token not found" })
    expect((await revokeToken(env, other, second.id)).status).toBe(404)
    expect((await bearer(env, second.token, "/api/read/tree")).status).toBe(200)
  })
})

describe("接口令牌：数据面口径", () => {
  it("lastUsedAt 只刷命中的那一枚（按令牌行）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const used = await createApiToken(env, admin, "read")
    const idle = await createApiToken(env, admin, "read")

    expect((await bearer(env, used.token, "/api/read/tree")).status).toBe(200)
    const list = await tokens(env, admin)
    expect(list.find((row) => row.id === used.id)?.lastUsedAt).not.toBeNull()
    expect(list.find((row) => row.id === idle.id)?.lastUsedAt).toBeNull()
  })

  it("kind 隔离：read 令牌进不了写接口，write 令牌两种都行", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const readToken = await createApiToken(env, admin, "read")
    const writeToken = await createApiToken(env, admin, "write")

    const denied = await request(env, "/api/write/pages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${readToken.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "越界",
        content_json: JSON.stringify({
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "x" }] }
          ]
        })
      })
    })
    expect(denied.status).toBe(401)

    expect((await bearer(env, writeToken.token, "/api/read/tree")).status).toBe(
      200
    )
  })

  it("11 条旧单令牌端点整体下线（404），新端点无会话 401", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { id } = await createApiToken(env, admin, "read")

    const old: Array<[string, string]> = [
      ["GET", "/api/me/read-token"],
      ["POST", "/api/me/read-token"],
      ["DELETE", "/api/me/read-token"],
      ["PUT", "/api/me/read-token/spaces"],
      ["GET", "/api/me/write-token"],
      ["POST", "/api/me/write-token"],
      ["DELETE", "/api/me/write-token"],
      ["PUT", "/api/me/write-token/spaces"],
      ["GET", "/api/me/import-token"],
      ["POST", "/api/me/import-token"],
      ["DELETE", "/api/me/import-token"]
    ]
    for (const [method, path] of old) {
      const res = await request(env, path, {
        method,
        headers: { cookie: admin }
      })
      expect(res.status, `${method} ${path}`).toBe(404)
    }

    // 管理端点只认会话 Cookie：Bearer 令牌、无凭证都 401。
    const anon = await Promise.all(
      [
        request(env, TOKENS_PATH),
        request(env, `${TOKENS_PATH}/${id}/name`, { method: "PUT" }),
        request(env, `${TOKENS_PATH}/${id}/spaces`, { method: "PUT" }),
        request(env, `${TOKENS_PATH}/${id}`, { method: "DELETE" }),
        request(env, "/api/me/import-tokens")
      ].map((pending) => pending)
    )
    for (const res of anon) expect(res.status).toBe(401)
  })
})
