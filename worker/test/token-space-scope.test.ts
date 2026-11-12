/**
 * 令牌空间范围（规格 §2.2 / §2.3 / §2.4）：管理端点与 core 的交集语义一起钉住。
 *
 * 读/写中间件的范围过滤由后续单接线，这里直接驱动 `core/token-scope.ts` 验证
 * 「有效可见范围 = 主人可见空间 ∩ 范围」与「只收窄、不放大」的口径。
 */
import { describe, expect, it } from "vitest"
import {
  getTokenScope,
  listTokenVisibleSpaces,
  tokenScopeAllows,
  type TokenScope
} from "../src/core/token-scope"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"
import type { Env } from "../src/types"

const PREFIX = "ciki_"
const READ_PATH = "/api/me/read-token"
const WRITE_PATH = "/api/me/write-token"

interface TokenStatus {
  active: boolean
  createdAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  spaceIds: TokenScope
}

function sorted(ids: number[]): number[] {
  return [...ids].sort((a, b) => a - b)
}

async function status(
  env: Env,
  cookie: string,
  path: string
): Promise<TokenStatus> {
  const res = await jsonRequest(env, "GET", path, undefined, cookie)
  expect(res.status).toBe(200)
  return (await res.json()) as TokenStatus
}

async function issue(
  env: Env,
  cookie: string,
  path: string,
  body?: unknown
): Promise<{ token: string; createdAt: string }> {
  const res = await jsonRequest(env, "POST", path, body ?? {}, cookie)
  expect(res.status).toBe(200)
  return (await res.json()) as { token: string; createdAt: string }
}

function putSpaces(
  env: Env,
  cookie: string,
  path: string,
  body: unknown
): Promise<Response> {
  return jsonRequest(env, "PUT", `${path}/spaces`, body, cookie)
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

async function userIdOf(env: Env, cookie: string): Promise<number> {
  const res = await jsonRequest(env, "GET", "/api/me", undefined, cookie)
  expect(res.status).toBe(200)
  return ((await res.json()) as { id: number }).id
}

async function addMember(
  env: Env,
  admin: string,
  spaceId: number,
  userId: number,
  role: "admin" | "editor" | "viewer" = "viewer"
): Promise<void> {
  const res = await jsonRequest(
    env,
    "POST",
    `/api/spaces/${spaceId}/members`,
    { userId, role },
    admin
  )
  expect(res.status).toBe(201)
}

async function removeMember(
  env: Env,
  admin: string,
  spaceId: number,
  userId: number
): Promise<void> {
  const res = await jsonRequest(
    env,
    "DELETE",
    `/api/spaces/${spaceId}/members/${userId}`,
    undefined,
    admin
  )
  expect(res.status).toBe(200)
}

async function visibleSpaceIds(
  env: Env,
  userId: number,
  isSiteAdmin: boolean,
  kind: "read" | "write"
): Promise<number[]> {
  const row = await env.DB.prepare(
    `SELECT id FROM ciki_api_tokens
      WHERE user_id = ? AND kind = ?
      ORDER BY id DESC LIMIT 1`
  )
    .bind(userId, kind)
    .first<{ id: number }>()
  const scope = row ? await getTokenScope(env.DB, PREFIX, row.id) : null
  const spaces = await listTokenVisibleSpaces(env.DB, PREFIX, {
    userId,
    isSiteAdmin,
    scope
  })
  return spaces.map((space) => space.id)
}

describe("令牌空间范围：管理端点", () => {
  it("首次生成不带 spaceIds = 不限制；PUT 设置后状态回读同一份（去重升序）", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const a = await createSpace(env, admin, "甲空间")
    const b = await createSpace(env, admin, "乙空间")

    expect((await status(env, admin, READ_PATH)).spaceIds).toBeNull()
    await issue(env, admin, READ_PATH)
    expect((await status(env, admin, READ_PATH)).spaceIds).toBeNull()

    const put = await putSpaces(env, admin, READ_PATH, {
      spaceIds: [b, a, a]
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({ spaceIds: sorted([a, b]) })
    expect((await status(env, admin, READ_PATH)).spaceIds).toEqual(
      sorted([a, b])
    )

    // 去重后落库：两行、升序，挂在最新那枚只读令牌上。
    const rows = db.db
      .prepare(
        `SELECT space_id FROM ciki_token_space_scopes
          WHERE token_id = (
            SELECT id FROM ciki_api_tokens
             WHERE kind = 'read' ORDER BY id DESC LIMIT 1
          )
          ORDER BY space_id`
      )
      .all() as Array<{ space_id: number }>
    expect(rows).toEqual(sorted([a, b]).map((space_id) => ({ space_id })))
  })

  it("null 清除范围；空数组、缺键、非整数、坏 JSON 一律 400", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const a = await createSpace(env, admin, "甲空间")
    await issue(env, admin, READ_PATH)
    await putSpaces(env, admin, READ_PATH, { spaceIds: [a] })

    const cleared = await putSpaces(env, admin, READ_PATH, { spaceIds: null })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toEqual({ spaceIds: null })
    expect((await status(env, admin, READ_PATH)).spaceIds).toBeNull()

    for (const body of [
      { spaceIds: [] },
      {},
      { spaceIds: "1" },
      { spaceIds: [a, 1.5] },
      { spaceIds: [a, 0] },
      { spaceIds: [a, "2"] }
    ]) {
      const res = await putSpaces(env, admin, READ_PATH, body)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ code: "INVALID_SPACE_SCOPE" })
    }
    // 失败请求不写库：范围仍是清除后的 null。
    expect((await status(env, admin, READ_PATH)).spaceIds).toBeNull()

    for (const [method, path] of [
      ["PUT", `${READ_PATH}/spaces`],
      ["POST", READ_PATH]
    ]) {
      const badJson = await request(env, path, {
        method,
        headers: { "content-type": "application/json", cookie: admin },
        body: "{"
      })
      expect(badJson.status).toBe(400)
      expect(await badJson.json()).toEqual({ error: "Invalid request body" })
    }

    // 有请求体但不是 JSON 对象：同样是坏请求体（不静默当「未带」）。
    const arrayBody = await putSpaces(env, admin, READ_PATH, [1, 2])
    expect(arrayBody.status).toBe(400)
    expect(await arrayBody.json()).toEqual({ error: "Invalid request body" })
  })

  it("POST 带 spaceIds 换范围；不带则保留现有范围（重置不悄悄放大）；null 清除", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const a = await createSpace(env, admin, "甲空间")
    const b = await createSpace(env, admin, "乙空间")

    await issue(env, admin, READ_PATH)
    await putSpaces(env, admin, READ_PATH, { spaceIds: [a] })
    expect((await status(env, admin, READ_PATH)).spaceIds).toEqual([a])

    await issue(env, admin, READ_PATH, { spaceIds: [b] })
    expect((await status(env, admin, READ_PATH)).spaceIds).toEqual([b])

    // 不带 = 保留：重置密钥不会把范围放大成「不限制」。
    await issue(env, admin, READ_PATH)
    expect((await status(env, admin, READ_PATH)).spaceIds).toEqual([b])

    await issue(env, admin, READ_PATH, { spaceIds: null })
    expect((await status(env, admin, READ_PATH)).spaceIds).toBeNull()
  })

  it("没有令牌时不能预设范围（404）；读写两类令牌的范围互不影响", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)
    const userId = await userIdOf(env, user)
    const a = await createSpace(env, admin, "甲空间")
    const b = await createSpace(env, admin, "乙空间")
    await addMember(env, admin, a, userId)
    await addMember(env, admin, b, userId)

    // 范围挂在具体令牌行上：还没有令牌时没有可写的对象。
    expect(
      (await putSpaces(env, user, READ_PATH, { spaceIds: [a] })).status
    ).toBe(404)
    expect((await status(env, user, READ_PATH)).spaceIds).toBeNull()

    await issue(env, user, READ_PATH, { spaceIds: [a] })
    await issue(env, user, WRITE_PATH, { spaceIds: [b] })
    expect((await status(env, user, READ_PATH)).spaceIds).toEqual([a])
    expect((await status(env, user, WRITE_PATH)).spaceIds).toEqual([b])
  })
})

describe("令牌空间范围：校验与交集语义", () => {
  it("非成员空间、不存在的 id 整单 400，不部分写入", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)
    const userId = await userIdOf(env, user)
    const s1 = await createSpace(env, admin, "甲空间")
    const s2 = await createSpace(env, admin, "乙空间")

    await issue(env, user, READ_PATH)

    const denied = await putSpaces(env, user, READ_PATH, {
      spaceIds: [s1, s2]
    })
    expect(denied.status).toBe(400)
    expect(await denied.json()).toMatchObject({ code: "INVALID_SPACE_SCOPE" })
    expect((await status(env, user, READ_PATH)).spaceIds).toBeNull()

    // 加进 s1 之后可以设 s1，但 s2 仍整单拒绝、且不覆盖已有的 s1。
    await addMember(env, admin, s1, userId)
    expect(
      (await putSpaces(env, user, READ_PATH, { spaceIds: [s1] })).status
    ).toBe(200)

    const mixed = await putSpaces(env, user, READ_PATH, {
      spaceIds: [s1, s2]
    })
    expect(mixed.status).toBe(400)
    expect((await status(env, user, READ_PATH)).spaceIds).toEqual([s1])

    const missing = await putSpaces(env, user, READ_PATH, {
      spaceIds: [s1, 999999]
    })
    expect(missing.status).toBe(400)
    expect((await status(env, user, READ_PATH)).spaceIds).toEqual([s1])

    // 站点管理员可以设任何**存在**的空间，但不存在的 id 同样拒绝。
    await issue(env, admin, READ_PATH)
    const adminMissing = await putSpaces(env, admin, READ_PATH, {
      spaceIds: [s2, 999999]
    })
    expect(adminMissing.status).toBe(400)
  })

  it("交集：退出空间立刻看不见、重新加入自动恢复（范围无需改）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)
    const userId = await userIdOf(env, user)
    const s1 = await createSpace(env, admin, "甲空间")
    const s2 = await createSpace(env, admin, "乙空间")
    await addMember(env, admin, s1, userId)
    await addMember(env, admin, s2, userId)

    await issue(env, user, READ_PATH, { spaceIds: [s1, s2] })
    expect(sorted(await visibleSpaceIds(env, userId, false, "read"))).toEqual(
      sorted([s1, s2])
    )

    // 范围里留着 s2，但主人退出了：交集只剩 s1。
    await removeMember(env, admin, s2, userId)
    expect(sorted(await visibleSpaceIds(env, userId, false, "read"))).toEqual([
      s1
    ])

    // 重新加入：范围里的 s2 自动恢复生效。
    await addMember(env, admin, s2, userId)
    expect(sorted(await visibleSpaceIds(env, userId, false, "read"))).toEqual(
      sorted([s1, s2])
    )
  })

  it("范围只是收窄：主人可见但不在范围内的空间不可见，范围也放大不了权限", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)
    const userId = await userIdOf(env, user)
    const s1 = await createSpace(env, admin, "甲空间")
    const s2 = await createSpace(env, admin, "乙空间")
    const outsider = await createSpace(env, admin, "丙空间")
    await addMember(env, admin, s1, userId)
    // 主人不是 outsider 的成员：范围里写它也永远不会生效（写入时就会被 400 拒掉）。
    const rejected = await putSpaces(env, user, READ_PATH, {
      spaceIds: [s1, outsider]
    })
    expect(rejected.status).toBe(400)

    await addMember(env, admin, s2, userId)
    await issue(env, user, READ_PATH)
    await putSpaces(env, user, READ_PATH, { spaceIds: [s1] })
    const visible = await visibleSpaceIds(env, userId, false, "read")
    expect(visible).toEqual([s1])
    expect(tokenScopeAllows([s1], s2)).toBe(false)

    // 站点管理员同样受限：范围之外的空间不因站点角色而可见。
    await issue(env, admin, READ_PATH)
    await putSpaces(env, admin, READ_PATH, { spaceIds: [s2] })
    const adminId = await userIdOf(env, admin)
    expect(sorted(await visibleSpaceIds(env, adminId, true, "read"))).toEqual([
      s2
    ])
  })
})
