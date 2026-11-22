/**
 * Agent 账号管理与令牌代管端点测试（Task #75）
 *
 * 契约与边界：
 * 1. 均需会话鉴权，严格限定 owner 本人；
 * 2. 非 owner（他人的 agent、id 不存在、或不是 agent）一律 404（不泄露存在性）；
 * 3. 站点管理员亦不得跨账号代签或代管；
 * 4. 令牌代管的请求与响应 DTO 形状与现有 `/api/me/tokens` 严格一致；
 * 5. 停用 agent 账号或删除后，其名下 API 令牌立即失效。
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

interface AgentSummary {
  id: number
  username: string
  isActive: boolean
  createdAt: string
}

interface TokenSummary {
  id: number
  name: string
  kind: "read" | "write"
  spaceIds: number[] | null
  createdAt: string
  lastUsedAt: string | null
}

interface IssuedToken {
  id: number
  name: string
  kind: "read" | "write"
  spaceIds: number[] | null
  token: string
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

describe("/api/me/agents 会话鉴权", () => {
  it("无会话统一回 401", async () => {
    const { env } = await initializedContext()

    const listRes = await jsonRequest(env, "GET", "/api/me/agents")
    expect(listRes.status).toBe(401)

    const createRes = await jsonRequest(env, "POST", "/api/me/agents", {
      username: "my-agent"
    })
    expect(createRes.status).toBe(401)

    const patchRes = await jsonRequest(env, "PATCH", "/api/me/agents/1", {
      isActive: false
    })
    expect(patchRes.status).toBe(401)

    const deleteRes = await jsonRequest(env, "DELETE", "/api/me/agents/1")
    expect(deleteRes.status).toBe(401)

    const tokenListRes = await jsonRequest(
      env,
      "GET",
      "/api/me/agents/1/tokens"
    )
    expect(tokenListRes.status).toBe(401)

    const tokenCreateRes = await jsonRequest(
      env,
      "POST",
      "/api/me/agents/1/tokens",
      { kind: "read" }
    )
    expect(tokenCreateRes.status).toBe(401)

    const tokenDeleteRes = await jsonRequest(
      env,
      "DELETE",
      "/api/me/agents/1/tokens/1"
    )
    expect(tokenDeleteRes.status).toBe(401)
  })
})

describe("/api/me/agents 基础 CRUD 与校验", () => {
  it("空列表、建号、排序、启停与彻底删除", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin, "alice@example.com")

    // 1. 初始空列表
    const emptyRes = await jsonRequest(
      env,
      "GET",
      "/api/me/agents",
      undefined,
      user
    )
    expect(emptyRes.status).toBe(200)
    expect(await emptyRes.json()).toEqual([])

    // 2. 建第一个 Agent
    const createRes1 = await jsonRequest(
      env,
      "POST",
      "/api/me/agents",
      { username: "bot-alpha" },
      user
    )
    expect(createRes1.status).toBe(201)
    const bot1 = (await createRes1.json()) as AgentSummary
    expect(bot1.username).toBe("bot-alpha")
    expect(bot1.isActive).toBe(true)
    expect(typeof bot1.id).toBe("number")
    expect(typeof bot1.createdAt).toBe("string")

    // 3. 建第二个 Agent
    const createRes2 = await jsonRequest(
      env,
      "POST",
      "/api/me/agents",
      { username: "bot-beta" },
      user
    )
    expect(createRes2.status).toBe(201)
    const bot2 = (await createRes2.json()) as AgentSummary
    expect(bot2.username).toBe("bot-beta")

    // 4. 列表包含两者，按 created_at 升序
    const listRes = await jsonRequest(
      env,
      "GET",
      "/api/me/agents",
      undefined,
      user
    )
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as AgentSummary[]
    expect(list.map((b) => b.id)).toEqual([bot1.id, bot2.id])
    expect(list.map((b) => b.username)).toEqual(["bot-alpha", "bot-beta"])

    // 5. 停用第一个 Agent
    const patchRes1 = await jsonRequest(
      env,
      "PATCH",
      `/api/me/agents/${bot1.id}`,
      { isActive: false },
      user
    )
    expect(patchRes1.status).toBe(200)
    const patched1 = (await patchRes1.json()) as AgentSummary
    expect(patched1.isActive).toBe(false)
    expect(patched1.id).toBe(bot1.id)

    // 验证列表中状态更新
    const listAfterPatch = (await (
      await jsonRequest(env, "GET", "/api/me/agents", undefined, user)
    ).json()) as AgentSummary[]
    expect(listAfterPatch.find((b) => b.id === bot1.id)?.isActive).toBe(false)

    // 6. 重新启用
    const patchRes2 = await jsonRequest(
      env,
      "PATCH",
      `/api/me/agents/${bot1.id}`,
      { isActive: true },
      user
    )
    expect(patchRes2.status).toBe(200)
    expect(((await patchRes2.json()) as AgentSummary).isActive).toBe(true)

    // 7. 删除第一个 Agent
    const deleteRes = await jsonRequest(
      env,
      "DELETE",
      `/api/me/agents/${bot1.id}`,
      undefined,
      user
    )
    expect(deleteRes.status).toBe(200)
    expect(await deleteRes.json()).toEqual({ success: true })

    // 验证列表中只剩 bot2
    const listAfterDelete = (await (
      await jsonRequest(env, "GET", "/api/me/agents", undefined, user)
    ).json()) as AgentSummary[]
    expect(listAfterDelete.map((b) => b.id)).toEqual([bot2.id])

    // 再次删除已被删的 Agent 回 404
    const deleteAgain = await jsonRequest(
      env,
      "DELETE",
      `/api/me/agents/${bot1.id}`,
      undefined,
      user
    )
    expect(deleteAgain.status).toBe(404)
    expect(await deleteAgain.json()).toEqual({ error: "Agent not found" })
  })

  it("输入校验：用户名格式校验与重名 409", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin, "bob@example.com")

    // 空用户名
    const emptyRes = await jsonRequest(
      env,
      "POST",
      "/api/me/agents",
      { username: "" },
      user
    )
    expect(emptyRes.status).toBe(400)
    expect(await emptyRes.json()).toEqual({
      error: "Invalid username",
      code: "INVALID_USERNAME"
    })

    // 空白字符
    const spaceRes = await jsonRequest(
      env,
      "POST",
      "/api/me/agents",
      { username: "    " },
      user
    )
    expect(spaceRes.status).toBe(400)

    // 超过 40 字符
    const longRes = await jsonRequest(
      env,
      "POST",
      "/api/me/agents",
      { username: "a".repeat(41) },
      user
    )
    expect(longRes.status).toBe(400)

    // 正常建号
    const okRes = await jsonRequest(
      env,
      "POST",
      "/api/me/agents",
      { username: "my-unique-bot" },
      user
    )
    expect(okRes.status).toBe(201)

    // 重名报 409 USERNAME_TAKEN
    const dupRes = await jsonRequest(
      env,
      "POST",
      "/api/me/agents",
      { username: "my-unique-bot" },
      user
    )
    expect(dupRes.status).toBe(409)
    expect(await dupRes.json()).toEqual({
      error: "Username already taken",
      code: "USERNAME_TAKEN"
    })

    // 大小写不敏感冲突报 409
    const dupCaseRes = await jsonRequest(
      env,
      "POST",
      "/api/me/agents",
      { username: "MY-UNIQUE-BOT" },
      user
    )
    expect(dupCaseRes.status).toBe(409)

    // PATCH isActive 非布尔值报 400
    const bot = (await okRes.json()) as AgentSummary
    const invalidPatch = await jsonRequest(
      env,
      "PATCH",
      `/api/me/agents/${bot.id}`,
      { isActive: "false" },
      user
    )
    expect(invalidPatch.status).toBe(400)
    expect(await invalidPatch.json()).toEqual({
      error: "isActive must be a boolean"
    })
  })
})

describe("/api/me/agents 严格 Owner 隔离边界（404 防探测）", () => {
  it("他人访问、站点管理员访问、非 Agent ID 或不存在 ID 一律 404", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const owner = await userSession(env, admin, "owner@example.com")
    const intruder = await userSession(env, admin, "intruder@example.com")

    // Owner 建一个 Agent
    const createRes = await jsonRequest(
      env,
      "POST",
      "/api/me/agents",
      { username: "owner-bot" },
      owner
    )
    expect(createRes.status).toBe(201)
    const bot = (await createRes.json()) as AgentSummary

    // 1. 他人（intruder）列表看不到该 Agent
    const intruderListRes = await jsonRequest(
      env,
      "GET",
      "/api/me/agents",
      undefined,
      intruder
    )
    expect(intruderListRes.status).toBe(200)
    expect(await intruderListRes.json()).toEqual([])

    // 2. 他人尝试 PATCH / DELETE 该 Agent -> 404
    const intruderPatch = await jsonRequest(
      env,
      "PATCH",
      `/api/me/agents/${bot.id}`,
      { isActive: false },
      intruder
    )
    expect(intruderPatch.status).toBe(404)
    expect(await intruderPatch.json()).toEqual({ error: "Agent not found" })

    const intruderDelete = await jsonRequest(
      env,
      "DELETE",
      `/api/me/agents/${bot.id}`,
      undefined,
      intruder
    )
    expect(intruderDelete.status).toBe(404)
    expect(await intruderDelete.json()).toEqual({ error: "Agent not found" })

    // 3. 他人尝试访问/签发/吊销该 Agent 的令牌 -> 404
    const intruderGetTokens = await jsonRequest(
      env,
      "GET",
      `/api/me/agents/${bot.id}/tokens`,
      undefined,
      intruder
    )
    expect(intruderGetTokens.status).toBe(404)
    expect(await intruderGetTokens.json()).toEqual({ error: "Agent not found" })

    const intruderPostToken = await jsonRequest(
      env,
      "POST",
      `/api/me/agents/${bot.id}/tokens`,
      { kind: "read" },
      intruder
    )
    expect(intruderPostToken.status).toBe(404)
    expect(await intruderPostToken.json()).toEqual({ error: "Agent not found" })

    const intruderDeleteToken = await jsonRequest(
      env,
      "DELETE",
      `/api/me/agents/${bot.id}/tokens/1`,
      undefined,
      intruder
    )
    expect(intruderDeleteToken.status).toBe(404)
    expect(await intruderDeleteToken.json()).toEqual({
      error: "Agent not found"
    })

    // 4. 站点管理员（admin）亦不得跨账号代管或代签他人名下的 Agent
    const adminListRes = await jsonRequest(
      env,
      "GET",
      "/api/me/agents",
      undefined,
      admin
    )
    expect(adminListRes.status).toBe(200)
    expect(await adminListRes.json()).toEqual([])

    const adminPatch = await jsonRequest(
      env,
      "PATCH",
      `/api/me/agents/${bot.id}`,
      { isActive: false },
      admin
    )
    expect(adminPatch.status).toBe(404)
    expect(await adminPatch.json()).toEqual({ error: "Agent not found" })

    const adminDelete = await jsonRequest(
      env,
      "DELETE",
      `/api/me/agents/${bot.id}`,
      undefined,
      admin
    )
    expect(adminDelete.status).toBe(404)
    expect(await adminDelete.json()).toEqual({ error: "Agent not found" })

    const adminPostToken = await jsonRequest(
      env,
      "POST",
      `/api/me/agents/${bot.id}/tokens`,
      { kind: "read" },
      admin
    )
    expect(adminPostToken.status).toBe(404)
    expect(await adminPostToken.json()).toEqual({ error: "Agent not found" })

    // 5. 目标不是 Agent（传入真人用户的 ID）或不存在 ID -> 404
    const meRes = await jsonRequest(env, "GET", "/api/me", undefined, owner)
    const me = (await meRes.json()) as { id: number }

    const humanPatch = await jsonRequest(
      env,
      "PATCH",
      `/api/me/agents/${me.id}`,
      { isActive: false },
      owner
    )
    expect(humanPatch.status).toBe(404)
    expect(await humanPatch.json()).toEqual({ error: "Agent not found" })

    const nonExistentPatch = await jsonRequest(
      env,
      "PATCH",
      "/api/me/agents/999999",
      { isActive: false },
      owner
    )
    expect(nonExistentPatch.status).toBe(404)
    expect(await nonExistentPatch.json()).toEqual({ error: "Agent not found" })
  })
})

describe("/api/me/agents/:id/tokens 代管令牌功能", () => {
  it("签发、默认名、空间范围、列表与吊销", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const owner = await userSession(env, admin, "token-owner@example.com")

    const spaceId1 = await createSpace(env, owner, "空间一")
    const spaceId2 = await createSpace(env, owner, "空间二")

    const botRes = await jsonRequest(
      env,
      "POST",
      "/api/me/agents",
      { username: "token-bot" },
      owner
    )
    const bot = (await botRes.json()) as AgentSummary

    // 初始令牌列表为空
    const emptyTokens = await jsonRequest(
      env,
      "GET",
      `/api/me/agents/${bot.id}/tokens`,
      undefined,
      owner
    )
    expect(emptyTokens.status).toBe(200)
    expect(await emptyTokens.json()).toEqual({ tokens: [] })

    // 1. 签发自定义名称与限定空间范围的只读令牌
    const issueRes1 = await jsonRequest(
      env,
      "POST",
      `/api/me/agents/${bot.id}/tokens`,
      {
        kind: "read",
        name: "Agent 只读凭证",
        spaceIds: [spaceId1, spaceId2]
      },
      owner
    )
    expect(issueRes1.status).toBe(201)
    const token1 = (await issueRes1.json()) as IssuedToken
    expect(token1.name).toBe("Agent 只读凭证")
    expect(token1.kind).toBe("read")
    expect(token1.spaceIds).toEqual([spaceId1, spaceId2])
    expect(typeof token1.token).toBe("string")
    expect(token1.token.length).toBeGreaterThan(20)

    // 2. 签发默认名称、不限制空间范围的读写令牌
    const issueRes2 = await jsonRequest(
      env,
      "POST",
      `/api/me/agents/${bot.id}/tokens`,
      { kind: "write" },
      owner
    )
    expect(issueRes2.status).toBe(201)
    const token2 = (await issueRes2.json()) as IssuedToken
    expect(token2.name).toBe("读写 Token")
    expect(token2.kind).toBe("write")
    expect(token2.spaceIds).toBeNull()
    expect(typeof token2.token).toBe("string")
    expect(token2.token.length).toBeGreaterThan(20)

    // 3. 校验输入合法性：非法 kind、非法 name、空空间列表或不可见空间
    const invalidKind = await jsonRequest(
      env,
      "POST",
      `/api/me/agents/${bot.id}/tokens`,
      { kind: "admin" },
      owner
    )
    expect(invalidKind.status).toBe(400)

    const invalidName = await jsonRequest(
      env,
      "POST",
      `/api/me/agents/${bot.id}/tokens`,
      { kind: "read", name: "x".repeat(41) },
      owner
    )
    expect(invalidName.status).toBe(400)

    const emptySpaces = await jsonRequest(
      env,
      "POST",
      `/api/me/agents/${bot.id}/tokens`,
      { kind: "read", spaceIds: [] },
      owner
    )
    expect(emptySpaces.status).toBe(400)

    const invisibleSpace = await jsonRequest(
      env,
      "POST",
      `/api/me/agents/${bot.id}/tokens`,
      { kind: "read", spaceIds: [999999] },
      owner
    )
    expect(invisibleSpace.status).toBe(400)

    // 4. GET 令牌列表：精确匹配 tokenSummary DTO 字段
    const listRes = await jsonRequest(
      env,
      "GET",
      `/api/me/agents/${bot.id}/tokens`,
      undefined,
      owner
    )
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as { tokens: TokenSummary[] }
    expect(list.tokens.length).toBe(2)
    expect(list.tokens.map((t) => t.id)).toEqual([token1.id, token2.id])
    expect(list.tokens[0]).toEqual({
      id: token1.id,
      name: "Agent 只读凭证",
      kind: "read",
      spaceIds: [spaceId1, spaceId2],
      createdAt: expect.any(String),
      lastUsedAt: null
    })

    // 5. 吊销 token1
    const deleteRes = await jsonRequest(
      env,
      "DELETE",
      `/api/me/agents/${bot.id}/tokens/${token1.id}`,
      undefined,
      owner
    )
    expect(deleteRes.status).toBe(200)
    expect(await deleteRes.json()).toEqual({ success: true })

    // 再次吊销同一个 token1 回 404
    const deleteAgain = await jsonRequest(
      env,
      "DELETE",
      `/api/me/agents/${bot.id}/tokens/${token1.id}`,
      undefined,
      owner
    )
    expect(deleteAgain.status).toBe(404)
    expect(await deleteAgain.json()).toEqual({ error: "Token not found" })

    // 吊销不存在的 token 回 404
    const deleteNonExistent = await jsonRequest(
      env,
      "DELETE",
      `/api/me/agents/${bot.id}/tokens/999999`,
      undefined,
      owner
    )
    expect(deleteNonExistent.status).toBe(404)

    // 列表中只剩下 token2
    const listAfterDelete = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/me/agents/${bot.id}/tokens`,
        undefined,
        owner
      )
    ).json()) as { tokens: TokenSummary[] }
    expect(listAfterDelete.tokens.map((t) => t.id)).toEqual([token2.id])
  })
})

describe("Agent 令牌调用与停用/删除即时失效", () => {
  it("正常调用 read API，Agent 停用即失效，重新启用恢复，删除即彻底失效", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const owner = await userSession(env, admin, "runner@example.com")

    // 建 Agent 并签发只读令牌
    const botRes = await jsonRequest(
      env,
      "POST",
      "/api/me/agents",
      { username: "working-bot" },
      owner
    )
    const bot = (await botRes.json()) as AgentSummary

    const tokenRes = await jsonRequest(
      env,
      "POST",
      `/api/me/agents/${bot.id}/tokens`,
      { kind: "read" },
      owner
    )
    const issued = (await tokenRes.json()) as IssuedToken

    // 1. 使用该令牌正常调只读 API
    const readRes1 = await request(env, "/api/read/tree", {
      headers: { authorization: `Bearer ${issued.token}` }
    })
    expect(readRes1.status).toBe(200)

    // 2. 停用该 Agent
    const patchDeactivate = await jsonRequest(
      env,
      "PATCH",
      `/api/me/agents/${bot.id}`,
      { isActive: false },
      owner
    )
    expect(patchDeactivate.status).toBe(200)

    // 停用后令牌立即失效（401 Unauthorized）
    const readResDeactivated = await request(env, "/api/read/tree", {
      headers: { authorization: `Bearer ${issued.token}` }
    })
    expect(readResDeactivated.status).toBe(401)

    // 3. 重新启用该 Agent
    const patchReactivate = await jsonRequest(
      env,
      "PATCH",
      `/api/me/agents/${bot.id}`,
      { isActive: true },
      owner
    )
    expect(patchReactivate.status).toBe(200)

    // 重新启用后令牌恢复可用（200 OK）
    const readResReactivated = await request(env, "/api/read/tree", {
      headers: { authorization: `Bearer ${issued.token}` }
    })
    expect(readResReactivated.status).toBe(200)

    // 4. 彻底删除 Agent
    const deleteRes = await jsonRequest(
      env,
      "DELETE",
      `/api/me/agents/${bot.id}`,
      undefined,
      owner
    )
    expect(deleteRes.status).toBe(200)

    // 删除后令牌立即且永久失效（401 Unauthorized）
    const readResDeleted = await request(env, "/api/read/tree", {
      headers: { authorization: `Bearer ${issued.token}` }
    })
    expect(readResDeleted.status).toBe(401)
  })
})
