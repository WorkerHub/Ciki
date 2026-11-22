/**
 * Agent 空间授权端点测试（Task #100）
 *
 * 契约与边界：
 * 1. 均需会话鉴权，严格限定 owner 本人，非 owner 一律 404（不泄露存在性）；
 * 2. 站点管理员亦不得跨账号代管；
 * 3. 只有 owner 有成员管理权（空间 admin 或站点管理员）的空间才可读写；
 * 4. 批量写入一次提交、逐项回报：越权 / 不存在 / 最后一名 admin 逐项点名失败；
 * 5. 角色限 admin / editor / viewer，默认 editor；单个移出空间。
 */
import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  userSession
} from "./support/app"
import type { Env } from "../src/types"

interface AgentSummary {
  id: number
  username: string
  isActive: boolean
  createdAt: string
}

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
): Promise<AgentSummary> {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/me/agents",
    { username },
    cookie
  )
  expect(res.status).toBe(201)
  return (await res.json()) as AgentSummary
}

async function meId(env: Env, cookie: string): Promise<number> {
  const res = await jsonRequest(env, "GET", "/api/me", undefined, cookie)
  expect(res.status).toBe(200)
  return ((await res.json()) as { id: number }).id
}

async function listSpaces(
  env: Env,
  cookie: string,
  agentId: number
): Promise<SpaceEntry[]> {
  const res = await jsonRequest(
    env,
    "GET",
    `/api/me/agents/${agentId}/spaces`,
    undefined,
    cookie
  )
  expect(res.status).toBe(200)
  return (await res.json()) as SpaceEntry[]
}

describe("/api/me/agents/:id/spaces 会话鉴权与 owner 边界", () => {
  it("无会话统一回 401", async () => {
    const { env } = await initializedContext()

    expect(
      (await jsonRequest(env, "GET", "/api/me/agents/1/spaces")).status
    ).toBe(401)
    expect(
      (
        await jsonRequest(env, "PUT", "/api/me/agents/1/spaces", {
          spaceIds: [1]
        })
      ).status
    ).toBe(401)
    expect(
      (await jsonRequest(env, "DELETE", "/api/me/agents/1/spaces/1")).status
    ).toBe(401)
  })

  it("非 owner 与站点管理员一律 404", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const owner = await userSession(env, admin, "owner@example.com")
    const intruder = await userSession(env, admin, "intruder@example.com")
    const bot = await createAgent(env, owner, "owner-bot")

    const paths = [
      ["GET", `/api/me/agents/${bot.id}/spaces`, undefined] as const,
      ["PUT", `/api/me/agents/${bot.id}/spaces`, { spaceIds: [1] }] as const,
      ["DELETE", `/api/me/agents/${bot.id}/spaces/1`, undefined] as const
    ]
    for (const [method, path, body] of paths) {
      const intruderRes = await jsonRequest(env, method, path, body, intruder)
      expect(intruderRes.status, `intruder ${method} ${path}`).toBe(404)
      const adminRes = await jsonRequest(env, method, path, body, admin)
      expect(adminRes.status, `admin ${method} ${path}`).toBe(404)
    }
  })
})

describe("/api/me/agents/:id/spaces 列表、批量写入与移出主流程", () => {
  it("列表 -> 批量加入 -> 改角色（含默认角色） -> 单个移出", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const owner = await userSession(env, admin, "flow@example.com")
    const spaceA = await createSpace(env, owner, "space-a")
    const spaceB = await createSpace(env, owner, "space-b")
    const bot = await createAgent(env, owner, "flow-bot")

    // 初始：两个空间都可管理，agent 均未加入
    let entries = await listSpaces(env, owner, bot.id)
    expect(entries.map((e) => e.spaceId)).toEqual([spaceA, spaceB])
    expect(entries.map((e) => e.role)).toEqual([null, null])
    for (const e of entries) {
      expect(typeof e.slug).toBe("string")
      expect(typeof e.name).toBe("string")
    }

    // 批量加入 viewer
    let put = await jsonRequest(
      env,
      "PUT",
      `/api/me/agents/${bot.id}/spaces`,
      { spaceIds: [spaceA, spaceB], role: "viewer" },
      owner
    )
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({
      results: [
        { spaceId: spaceA, ok: true, role: "viewer" },
        { spaceId: spaceB, ok: true, role: "viewer" }
      ]
    })

    entries = await listSpaces(env, owner, bot.id)
    expect(entries.map((e) => e.role)).toEqual(["viewer", "viewer"])

    // 改角色 + 默认角色（缺 role -> editor）
    put = await jsonRequest(
      env,
      "PUT",
      `/api/me/agents/${bot.id}/spaces`,
      { spaceIds: [spaceA] },
      owner
    )
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({
      results: [{ spaceId: spaceA, ok: true, role: "editor" }]
    })

    entries = await listSpaces(env, owner, bot.id)
    const byId = new Map(entries.map((e) => [e.spaceId, e.role]))
    expect(byId.get(spaceA)).toBe("editor")
    expect(byId.get(spaceB)).toBe("viewer")

    // 单个移出 spaceB
    const del = await jsonRequest(
      env,
      "DELETE",
      `/api/me/agents/${bot.id}/spaces/${spaceB}`,
      undefined,
      owner
    )
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ success: true })

    entries = await listSpaces(env, owner, bot.id)
    const byId2 = new Map(entries.map((e) => [e.spaceId, e.role]))
    expect(byId2.get(spaceA)).toBe("editor")
    // 空间仍在（owner 仍 admin），agent 已被移出
    expect(byId2.get(spaceB)).toBeNull()
    expect(byId2.has(spaceB)).toBe(true)
  })
})

describe("/api/me/agents/:id/spaces 批量逐项回报", () => {
  it("越权与不存在的空间逐项点名失败", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const owner = await userSession(env, admin, "perm@example.com")
    const intruder = await userSession(env, admin, "perm-intruder@example.com")

    const spaceA = await createSpace(env, owner, "space-a")
    // intruder 建空间，并把 owner 加为 viewer（owner 是成员但无管理权）
    const spaceC = await createSpace(env, intruder, "space-c")
    const ownerId = await meId(env, owner)
    const addOwner = await jsonRequest(
      env,
      "POST",
      `/api/spaces/${spaceC}/members`,
      { userId: ownerId, role: "viewer" },
      intruder
    )
    expect(addOwner.status).toBe(201)

    const bot = await createAgent(env, owner, "perm-bot")

    const put = await jsonRequest(
      env,
      "PUT",
      `/api/me/agents/${bot.id}/spaces`,
      { spaceIds: [spaceA, spaceC, 999999], role: "editor" },
      owner
    )
    expect(put.status).toBe(200)
    const body = (await put.json()) as { results: SpaceWriteResult[] }
    expect(body.results).toEqual([
      { spaceId: spaceA, ok: true, role: "editor" },
      {
        spaceId: spaceC,
        ok: false,
        error: "Space forbidden",
        code: "SPACE_FORBIDDEN"
      },
      {
        spaceId: 999999,
        ok: false,
        error: "Space not found",
        code: "SPACE_NOT_FOUND"
      }
    ])

    // 只有 spaceA 真正写入；spaceC 本就不在 owner 的可管理列表里
    const entries = await listSpaces(env, owner, bot.id)
    const byId = new Map(entries.map((e) => [e.spaceId, e.role]))
    expect(byId.get(spaceA)).toBe("editor")
    expect(byId.has(spaceC)).toBe(false)
  })
})

describe("/api/me/agents/:id/spaces 参数校验", () => {
  it("非法角色与非法 spaceIds 回 400", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const owner = await userSession(env, admin, "validate@example.com")
    const spaceA = await createSpace(env, owner, "space-a")
    const bot = await createAgent(env, owner, "validate-bot")

    const put = (body: unknown) =>
      jsonRequest(env, "PUT", `/api/me/agents/${bot.id}/spaces`, body, owner)

    const res1 = await put({ spaceIds: [spaceA], role: "bogus" })
    expect(res1.status).toBe(400)
    expect(await res1.json()).toEqual({
      error: "role must be admin, editor or viewer",
      code: "INVALID_ROLE"
    })

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

describe("/api/me/agents/:id/spaces 单个移出边界", () => {
  it("非成员 404、越权 403、不存在空间 404", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const owner = await userSession(env, admin, "del@example.com")
    const intruder = await userSession(env, admin, "del-intruder@example.com")

    const spaceA = await createSpace(env, owner, "space-a")
    const spaceC = await createSpace(env, intruder, "space-c")
    const ownerId = await meId(env, owner)
    await jsonRequest(
      env,
      "POST",
      `/api/spaces/${spaceC}/members`,
      { userId: ownerId, role: "viewer" },
      intruder
    )

    const bot = await createAgent(env, owner, "del-bot")

    // agent 尚未加入 spaceA
    let res = await jsonRequest(
      env,
      "DELETE",
      `/api/me/agents/${bot.id}/spaces/${spaceA}`,
      undefined,
      owner
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: "Member not found",
      code: "MEMBER_NOT_FOUND"
    })

    // owner 对 spaceC 只是 viewer，无管理权
    res = await jsonRequest(
      env,
      "DELETE",
      `/api/me/agents/${bot.id}/spaces/${spaceC}`,
      undefined,
      owner
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })

    // 不存在的空间
    res = await jsonRequest(
      env,
      "DELETE",
      `/api/me/agents/${bot.id}/spaces/999999`,
      undefined,
      owner
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: "Space not found",
      code: "SPACE_NOT_FOUND"
    })
  })
})

describe("/api/me/agents/:id/spaces 最后一名 admin 保护", () => {
  it("把空间最后一名 admin 降级或移出被拒", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin, "lastadmin@example.com")

    // user 建空间 Y，自己是 admin
    const spaceY = await createSpace(env, user, "space-y")
    const userId = await meId(env, user)

    // 站点管理员建 agent，并把它加为 spaceY 的 admin（站点管理员对任意空间有管理权）
    const bot = await createAgent(env, admin, "admin-bot")
    let res = await jsonRequest(
      env,
      "PUT",
      `/api/me/agents/${bot.id}/spaces`,
      { spaceIds: [spaceY], role: "admin" },
      admin
    )
    expect(res.status).toBe(200)

    // user 把自己降级为 editor，使 agent 成为 spaceY 唯一 admin
    res = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${spaceY}/members/${userId}`,
      { role: "editor" },
      user
    )
    expect(res.status).toBe(200)

    // 站点管理员把 agent 降级 -> 最后一名 admin，逐项拒绝
    res = await jsonRequest(
      env,
      "PUT",
      `/api/me/agents/${bot.id}/spaces`,
      { spaceIds: [spaceY], role: "editor" },
      admin
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      results: [
        {
          spaceId: spaceY,
          ok: false,
          error: "A space must keep at least one admin",
          code: "LAST_SPACE_ADMIN"
        }
      ]
    })

    // 单个移出同样被拒
    res = await jsonRequest(
      env,
      "DELETE",
      `/api/me/agents/${bot.id}/spaces/${spaceY}`,
      undefined,
      admin
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: "A space must keep at least one admin",
      code: "LAST_SPACE_ADMIN"
    })
  })
})

describe("/api/me/agents/:id/spaces 停用 Agent (is_active=0) 限制", () => {
  it("停用 Agent 拒绝批量加入空间（409 USER_NOT_ELIGIBLE），移出与列表不拦，重新激活后恢复", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const owner = await userSession(env, admin, "inactive-owner@example.com")
    const spaceA = await createSpace(env, owner, "space-inactive-a")
    const spaceB = await createSpace(env, owner, "space-inactive-b")
    const bot = await createAgent(env, owner, "inactive-bot")

    // 先加入 spaceA
    let putRes = await jsonRequest(
      env,
      "PUT",
      `/api/me/agents/${bot.id}/spaces`,
      { spaceIds: [spaceA], role: "editor" },
      owner
    )
    expect(putRes.status).toBe(200)

    // 停用该 Agent
    const patchRes = await jsonRequest(
      env,
      "PATCH",
      `/api/me/agents/${bot.id}`,
      { isActive: false },
      owner
    )
    expect(patchRes.status).toBe(200)
    expect(((await patchRes.json()) as { isActive: boolean }).isActive).toBe(
      false
    )

    // 停用后尝试批量加入 spaceB（或修改 spaceA 角色）一律 409 USER_NOT_ELIGIBLE
    putRes = await jsonRequest(
      env,
      "PUT",
      `/api/me/agents/${bot.id}/spaces`,
      { spaceIds: [spaceB], role: "viewer" },
      owner
    )
    expect(putRes.status).toBe(409)
    expect(await putRes.json()).toEqual({
      error: "User cannot join a space",
      code: "USER_NOT_ELIGIBLE"
    })

    // 停用状态下：查询空间列表不受阻
    const entries = await listSpaces(env, owner, bot.id)
    expect(entries.find((e) => e.spaceId === spaceA)?.role).toBe("editor")

    // 停用状态下：移出空间（DELETE）不受阻
    const delRes = await jsonRequest(
      env,
      "DELETE",
      `/api/me/agents/${bot.id}/spaces/${spaceA}`,
      undefined,
      owner
    )
    expect(delRes.status).toBe(200)
    expect(await delRes.json()).toEqual({ success: true })

    // 重新启用 Agent
    const reactivateRes = await jsonRequest(
      env,
      "PATCH",
      `/api/me/agents/${bot.id}`,
      { isActive: true },
      owner
    )
    expect(reactivateRes.status).toBe(200)
    expect(
      ((await reactivateRes.json()) as { isActive: boolean }).isActive
    ).toBe(true)

    // 重新启用后可正常批量加入
    putRes = await jsonRequest(
      env,
      "PUT",
      `/api/me/agents/${bot.id}/spaces`,
      { spaceIds: [spaceA, spaceB], role: "admin" },
      owner
    )
    expect(putRes.status).toBe(200)
    const putBody = (await putRes.json()) as {
      results: { spaceId: number; ok: boolean; role: string }[]
    }
    expect(putBody.results).toEqual([
      { spaceId: spaceA, ok: true, role: "admin" },
      { spaceId: spaceB, ok: true, role: "admin" }
    ])
  })
})
