/**
 * 令牌空间范围（规格 §2.2 / §2.3 / §2.4）：交集的语义在这里钉住。
 *
 * 管理端点的形状/错误码由 `test/me-tokens.test.ts` 覆盖；本文件只验证
 * 「有效可见范围 = 主人可见空间 ∩ 范围」与「范围只收窄、不放大」：
 * 退出空间立刻看不见、重新加入自动恢复（范围无需改），对站点管理员同样生效。
 */
import { describe, expect, it } from "vitest"
import {
  getTokenScope,
  listTokenVisibleSpaces,
  tokenScopeAllows
} from "../src/core/token-scope"
import {
  adminSession,
  createApiToken,
  initializedContext,
  jsonRequest,
  userSession
} from "./support/app"
import type { Env } from "../src/types"

const PREFIX = "ciki_"

function sorted(ids: number[]): number[] {
  return [...ids].sort((a, b) => a - b)
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

/** 某用户最新一枚接口令牌的**有效可见空间**（主人可见空间 ∩ 范围）。 */
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

describe("令牌空间范围：交集语义", () => {
  it("退出空间立刻看不见、重新加入自动恢复（范围无需改）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)
    const userId = await userIdOf(env, user)
    const s1 = await createSpace(env, admin, "甲空间")
    const s2 = await createSpace(env, admin, "乙空间")
    await addMember(env, admin, s1, userId)
    await addMember(env, admin, s2, userId)

    await createApiToken(env, user, "read", { spaceIds: [s1, s2] })
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

  it("范围只是收窄：可见但不在范围里的空间不可见，范围也放大不了权限", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)
    const userId = await userIdOf(env, user)
    const s1 = await createSpace(env, admin, "甲空间")
    const s2 = await createSpace(env, admin, "乙空间")
    await addMember(env, admin, s1, userId)
    await addMember(env, admin, s2, userId)

    await createApiToken(env, user, "read", { spaceIds: [s1] })
    expect(await visibleSpaceIds(env, userId, false, "read")).toEqual([s1])
    expect(tokenScopeAllows([s1], s2)).toBe(false)

    // 站点管理员同样受限：范围之外的空间不因站点角色而可见。
    const adminId = await userIdOf(env, admin)
    await createApiToken(env, admin, "read", { spaceIds: [s2] })
    expect(sorted(await visibleSpaceIds(env, adminId, true, "read"))).toEqual([
      s2
    ])
  })

  it("两枚令牌的范围互不影响（按令牌行各取各的）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const s1 = await createSpace(env, admin, "甲空间")
    const s2 = await createSpace(env, admin, "乙空间")

    await createApiToken(env, admin, "read", { spaceIds: [s1] })
    await createApiToken(env, admin, "write", { spaceIds: [s2] })

    const adminId = await userIdOf(env, admin)
    expect(sorted(await visibleSpaceIds(env, adminId, true, "read"))).toEqual([
      s1
    ])
    expect(sorted(await visibleSpaceIds(env, adminId, true, "write"))).toEqual([
      s2
    ])
  })
})
