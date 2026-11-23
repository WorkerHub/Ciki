/**
 * 用户批量空间授权端点测试（Task #100 规格镜像）
 *
 * 契约与边界：
 * 1. 管理员鉴权：无会话 401，非站点管理员一律 403；
 * 2. 覆盖对象：仅限真人用户；用户不存在或为 Agent 账号一律 404 {"error":"User not found"}（不泄露存在性）；
 * 3. 校验同源：停用/未批准用户 409 USER_NOT_ELIGIBLE；最后一名 admin 保护（LAST_SPACE_ADMIN）；
 * 4. 逐项回报结构与 Agent 空间授权同构；
 * 5. 实测即时生效：授权后即刻可见可写、改角色即刻生效、移出即刻失效、既有成员管理路径回归正常。
 */
import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  userSession
} from "./support/app"
import type { Env } from "../src/types"

interface SpaceEntry {
  spaceId: number
  slug: string
  name: string
  role: "admin" | "editor" | "viewer" | null
}

interface SpaceWriteResult {
  spaceId: number
  ok: boolean
  role?: string
  error?: string
  code?: string
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

async function createAgent(
  env: Env,
  cookie: string,
  username: string
): Promise<{ id: number; username: string }> {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/me/agents",
    { username },
    cookie
  )
  expect(res.status).toBe(201)
  return (await res.json()) as { id: number; username: string }
}

async function meId(env: Env, cookie: string): Promise<number> {
  const res = await jsonRequest(env, "GET", "/api/me", undefined, cookie)
  expect(res.status).toBe(200)
  return ((await res.json()) as { id: number }).id
}

async function listUserSpaces(
  env: Env,
  adminCookie: string,
  userId: number
): Promise<SpaceEntry[]> {
  const res = await jsonRequest(
    env,
    "GET",
    `/api/admin/users/${userId}/spaces`,
    undefined,
    adminCookie
  )
  expect(res.status).toBe(200)
  return (await res.json()) as SpaceEntry[]
}

describe("/api/admin/users/:id/spaces 会话鉴权与管理员边界", () => {
  it("无会话统一回 401", async () => {
    const { env } = await initializedContext()

    expect(
      (await jsonRequest(env, "GET", "/api/admin/users/1/spaces")).status
    ).toBe(401)
    expect(
      (
        await jsonRequest(env, "PUT", "/api/admin/users/1/spaces", {
          spaceIds: [1]
        })
      ).status
    ).toBe(401)
    expect(
      (await jsonRequest(env, "DELETE", "/api/admin/users/1/spaces/1")).status
    ).toBe(401)
  })

  it("非管理员调用一律回 403", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const normalUser = await userSession(env, admin, "normal@example.com")

    const paths = [
      ["GET", "/api/admin/users/1/spaces", undefined] as const,
      ["PUT", "/api/admin/users/1/spaces", { spaceIds: [1] }] as const,
      ["DELETE", "/api/admin/users/1/spaces/1", undefined] as const
    ]
    for (const [method, path, body] of paths) {
      const res = await jsonRequest(env, method, path, body, normalUser)
      expect(res.status, `normalUser ${method} ${path}`).toBe(403)
    }
  })
})

describe("/api/admin/users/:id/spaces 覆盖对象与 Agent 拦截（不泄露存在性）", () => {
  it("不存在的用户 ID 与畸形 ID 统一回 404 User not found", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    for (const badId of ["999999", "abc", "-1", "0"]) {
      const getRes = await jsonRequest(
        env,
        "GET",
        `/api/admin/users/${badId}/spaces`,
        undefined,
        admin
      )
      expect(getRes.status).toBe(404)
      expect(await getRes.json()).toEqual({ error: "User not found" })

      const putRes = await jsonRequest(
        env,
        "PUT",
        `/api/admin/users/${badId}/spaces`,
        { spaceIds: [1] },
        admin
      )
      expect(putRes.status).toBe(404)
      expect(await putRes.json()).toEqual({ error: "User not found" })

      const delRes = await jsonRequest(
        env,
        "DELETE",
        `/api/admin/users/${badId}/spaces/1`,
        undefined,
        admin
      )
      expect(delRes.status).toBe(404)
      expect(await delRes.json()).toEqual({ error: "User not found" })
    }
  })

  it("以 Agent 账号 ID 调用一律回 404 User not found（不泄露存在性）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const bot = await createAgent(env, admin, "my-agent-bot")

    const paths = [
      ["GET", `/api/admin/users/${bot.id}/spaces`, undefined] as const,
      [
        "PUT",
        `/api/admin/users/${bot.id}/spaces`,
        { spaceIds: [1], role: "editor" }
      ] as const,
      ["DELETE", `/api/admin/users/${bot.id}/spaces/1`, undefined] as const
    ]
    for (const [method, path, body] of paths) {
      const res = await jsonRequest(env, method, path, body, admin)
      expect(res.status, `agent id ${method} ${path}`).toBe(404)
      expect(await res.json()).toEqual({ error: "User not found" })
    }
  })
})

describe("/api/admin/users/:id/spaces 列表、批量写入与移出主流程", () => {
  it("列表 -> 批量加入 -> 改角色（含默认角色） -> 单个移出", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const userCookie = await userSession(env, admin, "human-flow@example.com")
    const targetUserId = await meId(env, userCookie)

    const spaceA = await createSpace(env, admin, "space-a")
    const spaceB = await createSpace(env, admin, "space-b")

    // 1. 列表：初始状态两空间均存在且该用户未加入 (role === null)
    let entries = await listUserSpaces(env, admin, targetUserId)
    const entryA = entries.find((e) => e.spaceId === spaceA)
    const entryB = entries.find((e) => e.spaceId === spaceB)
    expect(entryA).toBeDefined()
    expect(entryB).toBeDefined()
    expect(entryA?.role).toBeNull()
    expect(entryB?.role).toBeNull()

    // 2. 批量加入 viewer
    let put = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${targetUserId}/spaces`,
      { spaceIds: [spaceA, spaceB], role: "viewer" },
      admin
    )
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({
      results: [
        { spaceId: spaceA, ok: true, role: "viewer" },
        { spaceId: spaceB, ok: true, role: "viewer" }
      ]
    })

    entries = await listUserSpaces(env, admin, targetUserId)
    expect(entries.find((e) => e.spaceId === spaceA)?.role).toBe("viewer")
    expect(entries.find((e) => e.spaceId === spaceB)?.role).toBe("viewer")

    // 3. 改角色 + 默认角色（不传 role -> 默认 editor）
    put = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${targetUserId}/spaces`,
      { spaceIds: [spaceA] },
      admin
    )
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({
      results: [{ spaceId: spaceA, ok: true, role: "editor" }]
    })

    entries = await listUserSpaces(env, admin, targetUserId)
    expect(entries.find((e) => e.spaceId === spaceA)?.role).toBe("editor")
    expect(entries.find((e) => e.spaceId === spaceB)?.role).toBe("viewer")

    // 4. 单个移出 spaceB
    const del = await jsonRequest(
      env,
      "DELETE",
      `/api/admin/users/${targetUserId}/spaces/${spaceB}`,
      undefined,
      admin
    )
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ success: true })

    entries = await listUserSpaces(env, admin, targetUserId)
    expect(entries.find((e) => e.spaceId === spaceA)?.role).toBe("editor")
    expect(entries.find((e) => e.spaceId === spaceB)?.role).toBeNull()
  })
})

describe("/api/admin/users/:id/spaces 批量逐项回报", () => {
  it("包含不存在的空间时逐项点名失败，不影响有效空间", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const userCookie = await userSession(env, admin, "partial@example.com")
    const targetUserId = await meId(env, userCookie)

    const spaceA = await createSpace(env, admin, "space-part-a")

    const put = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${targetUserId}/spaces`,
      { spaceIds: [spaceA, 999999], role: "editor" },
      admin
    )
    expect(put.status).toBe(200)
    const body = (await put.json()) as { results: SpaceWriteResult[] }
    expect(body.results).toEqual([
      { spaceId: spaceA, ok: true, role: "editor" },
      {
        spaceId: 999999,
        ok: false,
        error: "Space not found",
        code: "SPACE_NOT_FOUND"
      }
    ])

    const entries = await listUserSpaces(env, admin, targetUserId)
    expect(entries.find((e) => e.spaceId === spaceA)?.role).toBe("editor")
  })
})

describe("/api/admin/users/:id/spaces 参数校验", () => {
  it("非法角色与非法 spaceIds 回 400", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const userCookie = await userSession(env, admin, "valid-params@example.com")
    const targetUserId = await meId(env, userCookie)
    const spaceA = await createSpace(env, admin, "space-param-a")

    const put = (body: unknown) =>
      jsonRequest(
        env,
        "PUT",
        `/api/admin/users/${targetUserId}/spaces`,
        body,
        admin
      )

    // 非法角色
    const resRole = await put({ spaceIds: [spaceA], role: "invalid-role" })
    expect(resRole.status).toBe(400)
    expect(await resRole.json()).toEqual({
      error: "role must be admin, editor or viewer",
      code: "INVALID_ROLE"
    })

    // 非法 spaceIds
    const badScope = {
      error: "Invalid space scope",
      code: "INVALID_SPACE_SCOPE"
    }
    for (const body of [
      { spaceIds: [] },
      { spaceIds: null },
      { spaceIds: "1" },
      { role: "editor" }
    ]) {
      const res = await put(body)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual(badScope)
    }
  })
})

describe("/api/admin/users/:id/spaces 校验同源与限制", () => {
  it("未激活或未批准用户拒绝批量加入空间（409 USER_NOT_ELIGIBLE），移出与列表不拦", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const userCookie = await userSession(
      env,
      admin,
      "inactive-user@example.com"
    )
    const targetUserId = await meId(env, userCookie)
    const spaceA = await createSpace(env, admin, "space-inact-a")

    // 先正常加入 spaceA
    let putRes = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${targetUserId}/spaces`,
      { spaceIds: [spaceA], role: "editor" },
      admin
    )
    expect(putRes.status).toBe(200)

    // 管理员停用该真人用户 (isActive: false)
    const disableRes = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${targetUserId}`,
      { isActive: false },
      admin
    )
    expect(disableRes.status).toBe(200)

    // 停用后尝试 PUT 批量授权 -> 409 USER_NOT_ELIGIBLE
    putRes = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${targetUserId}/spaces`,
      { spaceIds: [spaceA], role: "viewer" },
      admin
    )
    expect(putRes.status).toBe(409)
    expect(await putRes.json()).toEqual({
      error: "User cannot join a space",
      code: "USER_NOT_ELIGIBLE"
    })

    // 停用后列表不受阻
    const entries = await listUserSpaces(env, admin, targetUserId)
    expect(entries.find((e) => e.spaceId === spaceA)?.role).toBe("editor")

    // 停用后 DELETE 移出不受阻
    const delRes = await jsonRequest(
      env,
      "DELETE",
      `/api/admin/users/${targetUserId}/spaces/${spaceA}`,
      undefined,
      admin
    )
    expect(delRes.status).toBe(200)
    expect(await delRes.json()).toEqual({ success: true })
  })

  it("最后一名 admin 保护：降级或移出空间唯一 admin 被拒", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const userCookie = await userSession(env, admin, "sole-admin@example.com")
    const targetUserId = await meId(env, userCookie)
    const adminId = await meId(env, admin)

    const spaceZ = await createSpace(env, admin, "space-z")

    // 将目标用户加为 spaceZ 的 admin
    let putRes = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${targetUserId}/spaces`,
      { spaceIds: [spaceZ], role: "admin" },
      admin
    )
    expect(putRes.status).toBe(200)

    // 移除 admin 自己的成员关系，使 targetUser 成为 spaceZ 唯一 admin
    const delAdmin = await jsonRequest(
      env,
      "DELETE",
      `/api/spaces/${spaceZ}/members/${adminId}`,
      undefined,
      admin
    )
    expect(delAdmin.status).toBe(200)

    // 尝试降级 targetUser 为 editor -> 逐项点名 LAST_SPACE_ADMIN
    putRes = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${targetUserId}/spaces`,
      { spaceIds: [spaceZ], role: "editor" },
      admin
    )
    expect(putRes.status).toBe(200)
    expect(await putRes.json()).toEqual({
      results: [
        {
          spaceId: spaceZ,
          ok: false,
          error: "A space must keep at least one admin",
          code: "LAST_SPACE_ADMIN"
        }
      ]
    })

    // 尝试单个移出 targetUser -> 409 LAST_SPACE_ADMIN
    const delRes = await jsonRequest(
      env,
      "DELETE",
      `/api/admin/users/${targetUserId}/spaces/${spaceZ}`,
      undefined,
      admin
    )
    expect(delRes.status).toBe(409)
    expect(await delRes.json()).toEqual({
      error: "A space must keep at least one admin",
      code: "LAST_SPACE_ADMIN"
    })
  })

  it("单个移出边界：空间不存在 404，非成员 404", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const userCookie = await userSession(env, admin, "del-edge@example.com")
    const targetUserId = await meId(env, userCookie)
    const spaceA = await createSpace(env, admin, "space-del-edge")

    // 移出未加入的空间 -> 404 MEMBER_NOT_FOUND
    const resNotMember = await jsonRequest(
      env,
      "DELETE",
      `/api/admin/users/${targetUserId}/spaces/${spaceA}`,
      undefined,
      admin
    )
    expect(resNotMember.status).toBe(404)
    expect(await resNotMember.json()).toEqual({
      error: "Member not found",
      code: "MEMBER_NOT_FOUND"
    })

    // 移出不存在的空间 -> 404 SPACE_NOT_FOUND
    const resNotSpace = await jsonRequest(
      env,
      "DELETE",
      `/api/admin/users/${targetUserId}/spaces/999999`,
      undefined,
      admin
    )
    expect(resNotSpace.status).toBe(404)
    expect(await resNotSpace.json()).toEqual({
      error: "Space not found",
      code: "SPACE_NOT_FOUND"
    })
  })
})

describe("Jim 验收场景：实测权限即时生效与既有路径回归", () => {
  it("两空间批量授权后即刻可见可写、未授权空间无权、改角色即刻生效、移出即刻失效", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const userCookie = await userSession(env, admin, "jim-test@example.com")
    const targetUserId = await meId(env, userCookie)

    const space1 = await createSpace(env, admin, "jim-space-1")
    const space2 = await createSpace(env, admin, "jim-space-2")
    const spaceUnauth = await createSpace(env, admin, "jim-unauthorized")

    // 1. 批量授权两空间为 editor
    const put = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${targetUserId}/spaces`,
      { spaceIds: [space1, space2], role: "editor" },
      admin
    )
    expect(put.status).toBe(200)

    // 2. 该用户即刻可通过 GET /api/spaces 看到两空间，且看不到未授权空间
    const spacesRes = await jsonRequest(
      env,
      "GET",
      "/api/spaces",
      undefined,
      userCookie
    )
    expect(spacesRes.status).toBe(200)
    const spaces = (await spacesRes.json()) as Array<{ id: number }>
    const spaceIds = spaces.map((s) => s.id)
    expect(spaceIds).toContain(space1)
    expect(spaceIds).toContain(space2)
    expect(spaceIds).not.toContain(spaceUnauth)

    // 3. 访问未授权空间直接 404
    const unauthRes = await jsonRequest(
      env,
      "GET",
      `/api/spaces/${spaceUnauth}`,
      undefined,
      userCookie
    )
    expect(unauthRes.status).toBe(404)

    // 4. 作为 editor 在 space1 创建页面即刻成功
    const pageCreateRes = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        title: "Jim Page",
        spaceId: space1,
        parentId: null,
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>Jim's test</p>",
        contentText: "Jim's test"
      },
      userCookie
    )
    expect(pageCreateRes.status).toBe(201)
    const pageId = ((await pageCreateRes.json()) as { id: number }).id

    // 5. 将该用户在 space1 改角色为 viewer
    const downgradeRes = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${targetUserId}/spaces`,
      { spaceIds: [space1], role: "viewer" },
      admin
    )
    expect(downgradeRes.status).toBe(200)

    // 6. 改为 viewer 后写操作即刻被拒 (403 Forbidden)
    const editRes = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${pageId}`,
      {
        title: "Jim Modified Page",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>Jim modified</p>",
        contentText: "Jim modified"
      },
      userCookie
    )
    expect(editRes.status).toBe(403)

    // 7. 单个移出 space1
    const delRes = await jsonRequest(
      env,
      "DELETE",
      `/api/admin/users/${targetUserId}/spaces/${space1}`,
      undefined,
      admin
    )
    expect(delRes.status).toBe(200)

    // 8. 移出后该用户访问 space1 页面即刻失效 (404)
    const pageGetRes = await jsonRequest(
      env,
      "GET",
      `/api/pages/${pageId}`,
      undefined,
      userCookie
    )
    expect(pageGetRes.status).toBe(404)
  })

  it("真人既有成员管理路径 (/api/spaces/:id/members) 回归无变化", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const userCookie = await userSession(env, admin, "regress-user@example.com")
    const targetUserId = await meId(env, userCookie)
    const space = await createSpace(env, admin, "regress-space")

    // 既有路径：POST /api/spaces/:id/members
    const addRes = await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space}/members`,
      { userId: targetUserId, role: "editor" },
      admin
    )
    expect(addRes.status).toBe(201)

    // 既有路径：PUT /api/spaces/:id/members/:userId
    const updateRes = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${space}/members/${targetUserId}`,
      { role: "viewer" },
      admin
    )
    expect(updateRes.status).toBe(200)

    // 新管理端点查询与既有路径一致
    const list = await listUserSpaces(env, admin, targetUserId)
    expect(list.find((e) => e.spaceId === space)?.role).toBe("viewer")

    // 既有路径：DELETE /api/spaces/:id/members/:userId
    const delRes = await jsonRequest(
      env,
      "DELETE",
      `/api/spaces/${space}/members/${targetUserId}`,
      undefined,
      admin
    )
    expect(delRes.status).toBe(200)

    // 新管理端点查询确认已移出
    const listAfter = await listUserSpaces(env, admin, targetUserId)
    expect(listAfter.find((e) => e.spaceId === space)?.role).toBeNull()
  })
})
