import { describe, expect, it } from "vitest"
import {
  adminSession,
  enableSmtpConfig,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"
import {
  createAgentUser,
  createApprovedUser,
  findUserByEmail,
  findUserById,
  AGENT_UNVERIFIABLE_PASSWORD_HASH
} from "../src/db/queries/users"
import { insertPasskey } from "../src/db/queries/passkeys"
import { findSession } from "../src/core/session"
import { sha256Hex } from "../src/core/auth"
import { sessionsTable } from "../src/lib/tables"
import { runSetup } from "../src/lib/setup"

describe("Agent 身份模型与 users 表 schema_v10 迁移", () => {
  it("schema_v10 迁移后，新用户与存量用户默认均为 human 且 owner_user_id 为 null", async () => {
    const { env, db } = await initializedContext()
    const prefix = "ciki_"

    // PRAGMA 检查字段存在
    const rawColumns = db.db
      .prepare("PRAGMA table_info(ciki_users)")
      .all() as Array<{
      name: string
      dflt_value: string | null
    }>
    const columns = Object.fromEntries(rawColumns.map((col) => [col.name, col]))

    expect(columns.kind).toBeDefined()
    expect(columns.kind.dflt_value).toBe("'human'")
    expect(columns.owner_user_id).toBeDefined()

    // 创建普通人类用户
    const userId = await createApprovedUser(env.DB, prefix, {
      email: "human@example.com",
      username: "human_user",
      password_hash: "hash",
      role: "user"
    })

    const user = await findUserById(env.DB, prefix, userId)
    expect(user).not.toBeNull()
    expect(user?.kind).toBe("human")
    expect(user?.owner_user_id).toBeNull()
  })

  it("迁移幂等：再次执行 runSetup 不重复追加列，状态为 skipped", async () => {
    const { env } = await initializedContext()
    const result = await runSetup(env)
    expect(result.success).toBe(true)
    const v10 = result.migrations?.find((m) => m.name === "schema_v10")
    expect(v10?.status).toBe("skipped")
  })
})

describe("createAgentUser 工具函数", () => {
  it("正常创建 Agent 用户：kind 为 agent，指向 owner，默认激活已批准，密码不可比对", async () => {
    const { env } = await initializedContext()
    const prefix = "ciki_"

    const ownerId = await createApprovedUser(env.DB, prefix, {
      email: "owner@example.com",
      username: "owner_human",
      password_hash: "hash",
      role: "user"
    })

    const agentId = await createAgentUser(env.DB, prefix, {
      owner_user_id: ownerId,
      username: "my-agent"
    })

    const agent = await findUserById(env.DB, prefix, agentId)
    expect(agent).not.toBeNull()
    expect(agent?.kind).toBe("agent")
    expect(agent?.owner_user_id).toBe(ownerId)
    expect(agent?.role).toBe("user")
    expect(agent?.is_active).toBe(1)
    expect(agent?.approval_status).toBe("approved")
    expect(agent?.email_verified).toBe(1)
    expect(agent?.password_hash).toBe(AGENT_UNVERIFIABLE_PASSWORD_HASH)
    expect(agent?.username).toBe("my-agent")
    expect(agent?.email).toMatch(/^agent-[a-f0-9-]+@internal$/)
  })

  it("支持自定义合规邮箱与头像，自动处理用户名冲突后缀", async () => {
    const { env } = await initializedContext()
    const prefix = "ciki_"

    const ownerId = await createApprovedUser(env.DB, prefix, {
      email: "owner2@example.com",
      username: "owner2",
      password_hash: "hash",
      role: "user"
    })

    const agentId1 = await createAgentUser(env.DB, prefix, {
      owner_user_id: ownerId,
      username: "agent-bot",
      email: "bot-custom@internal",
      avatar_key: "avatars/bot.png"
    })

    const agentId2 = await createAgentUser(env.DB, prefix, {
      owner_user_id: ownerId,
      username: "agent-bot"
    })

    const agent1 = await findUserById(env.DB, prefix, agentId1)
    const agent2 = await findUserById(env.DB, prefix, agentId2)

    expect(agent1?.username).toBe("agent-bot")
    expect(agent1?.email).toBe("bot-custom@internal")
    expect(agent1?.avatar_key).toBe("avatars/bot.png")

    expect(agent2?.username).toBe("agent-bot-2")

    // 自定义邮箱与已有用户冲突时抛错
    await expect(
      createAgentUser(env.DB, prefix, {
        owner_user_id: ownerId,
        email: "owner2@example.com"
      })
    ).rejects.toThrow("Email already taken")
  })

  it("所有者校验：所有者不存在、停用或为 Agent 时拒绝创建", async () => {
    const { env } = await initializedContext()
    const prefix = "ciki_"

    // 1. 所有者不存在
    await expect(
      createAgentUser(env.DB, prefix, { owner_user_id: 999999 })
    ).rejects.toThrow("Owner user not found")

    // 2. 所有者停用
    const inactiveOwnerId = await createApprovedUser(env.DB, prefix, {
      email: "inactive@example.com",
      username: "inactive_owner",
      password_hash: "hash",
      role: "user"
    })
    await env.DB.prepare(`UPDATE ${prefix}users SET is_active = 0 WHERE id = ?`)
      .bind(inactiveOwnerId)
      .run()

    await expect(
      createAgentUser(env.DB, prefix, { owner_user_id: inactiveOwnerId })
    ).rejects.toThrow("Owner must be an active user")

    // 3. 所有者为 Agent（Agent 不能拥有 Agent）
    const validOwnerId = await createApprovedUser(env.DB, prefix, {
      email: "active@example.com",
      username: "active_owner",
      password_hash: "hash",
      role: "user"
    })
    const firstAgentId = await createAgentUser(env.DB, prefix, {
      owner_user_id: validOwnerId,
      username: "first_agent"
    })

    await expect(
      createAgentUser(env.DB, prefix, { owner_user_id: firstAgentId })
    ).rejects.toThrow("Owner must be a human user")
  })
})

describe("Agent 认证与登录阻断", () => {
  it("密码登录：Agent 邮箱登录一律返回通用 401 Invalid credentials，不泄露账号存在", async () => {
    const { env } = await initializedContext()
    const prefix = "ciki_"

    const ownerId = await createApprovedUser(env.DB, prefix, {
      email: "human_owner@example.com",
      username: "human_owner",
      password_hash: "hash",
      role: "user"
    })
    const agentId = await createAgentUser(env.DB, prefix, {
      owner_user_id: ownerId
    })
    const agent = await findUserById(env.DB, prefix, agentId)
    expect(agent).not.toBeNull()

    const res = await jsonRequest(env, "POST", "/api/auth/login", {
      email: agent!.email,
      password: "any-password"
    })

    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("Invalid credentials")
  })

  it("找回密码：Agent 邮箱静默返回通用已受理（不发信且不报错），不暴露账号类型", async () => {
    const { env } = await initializedContext()
    await enableSmtpConfig(env)
    const prefix = "ciki_"

    const ownerId = await createApprovedUser(env.DB, prefix, {
      email: "human_owner2@example.com",
      username: "human_owner2",
      password_hash: "hash",
      role: "user"
    })
    const agentId = await createAgentUser(env.DB, prefix, {
      owner_user_id: ownerId
    })
    const agent = await findUserById(env.DB, prefix, agentId)

    const res = await jsonRequest(env, "POST", "/api/auth/password/forgot", {
      email: agent!.email
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean }
    expect(body.success).toBe(true)

    // 验证确实未向 email_codes 写入验证码
    const code = await env.DB.prepare(
      `SELECT * FROM ${prefix}email_codes WHERE user_id = ?`
    )
      .bind(agentId)
      .first()
    expect(code).toBeNull()
  })

  it("会话阻断：findSession 对 kind='agent' 账号一律返回 null", async () => {
    const { env } = await initializedContext()
    const prefix = "ciki_"

    const ownerId = await createApprovedUser(env.DB, prefix, {
      email: "human_owner3@example.com",
      username: "human_owner3",
      password_hash: "hash",
      role: "user"
    })
    const agentId = await createAgentUser(env.DB, prefix, {
      owner_user_id: ownerId
    })

    // 强行向 sessions 表写入一条属于 agentId 的会话
    const rawToken = "agent-fake-session-token"
    const tokenHash = await sha256Hex(rawToken)
    const nowSec = Math.floor(Date.now() / 1000)
    await env.DB.prepare(
      `INSERT INTO ${sessionsTable(prefix)} (id, user_id, token_hash, created_at, last_seen_at, expires_at)
       VALUES ('test-sess-1', ?, ?, ?, ?, ?)`
    )
      .bind(agentId, tokenHash, nowSec, nowSec, nowSec + 3600)
      .run()

    const lookup = await findSession(env.DB, prefix, rawToken)
    expect(lookup).toBeNull()
  })

  it("Passkey 登录阻断：关联到 Agent 的 Passkey 凭证在 verify 时返回 401 Invalid credentials", async () => {
    const { env } = await initializedContext()
    const prefix = "ciki_"

    const ownerId = await createApprovedUser(env.DB, prefix, {
      email: "human_owner4@example.com",
      username: "human_owner4",
      password_hash: "hash",
      role: "user"
    })
    const agentId = await createAgentUser(env.DB, prefix, {
      owner_user_id: ownerId
    })

    // 请求登录 options 获取有效 challenge
    const optionsRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/options",
      {}
    )
    expect(optionsRes.status).toBe(200)
    const options = (await optionsRes.json()) as { challenge: string }

    const credId = "agent-passkey-cred-id"
    await insertPasskey(env.DB, prefix, {
      userId: agentId,
      credentialId: credId,
      publicKey: "dummy-public-key",
      counter: 0,
      transports: "[]"
    })

    // 尝试 Passkey 登录
    const verifyRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/verify",
      {
        id: credId,
        challenge: options.challenge
      }
    )

    expect(verifyRes.status).toBe(401)
    const body = (await verifyRes.json()) as { error: string }
    expect(body.error).toBe("Invalid credentials")
  })
})

describe("Admin 用户管理接口对 Agent 的保护与约束", () => {
  it("列表返回包含 isAgent、kind、ownerUserId 与 owner", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const prefix = "ciki_"

    const owner = await findUserByEmail(env.DB, prefix, "admin@example.com")
    expect(owner).not.toBeNull()

    const agentId = await createAgentUser(env.DB, prefix, {
      owner_user_id: owner!.id,
      username: "ciki-bot"
    })

    const res = await jsonRequest(
      env,
      "GET",
      "/api/admin/users",
      undefined,
      admin
    )
    expect(res.status).toBe(200)
    const users = (await res.json()) as Array<{
      id: number
      kind: string
      isAgent: boolean
      ownerUserId: number | null
      owner: { id: number; username: string } | null
    }>

    const agentDto = users.find((u) => u.id === agentId)
    expect(agentDto).toBeDefined()
    expect(agentDto?.isAgent).toBe(true)
    expect(agentDto?.kind).toBe("agent")
    expect(agentDto?.ownerUserId).toBe(owner!.id)
    expect(agentDto?.owner).toEqual({
      id: owner!.id,
      username: owner!.username
    })

    const humanDto = users.find((u) => u.id === owner!.id)
    expect(humanDto).toBeDefined()
    expect(humanDto?.isAgent).toBe(false)
    expect(humanDto?.kind).toBe("human")
    expect(humanDto?.ownerUserId).toBeNull()
    expect(humanDto?.owner).toBeNull()
  })

  it("禁止将 Agent 角色提升为 admin", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const prefix = "ciki_"

    const owner = await findUserByEmail(env.DB, prefix, "admin@example.com")
    const agentId = await createAgentUser(env.DB, prefix, {
      owner_user_id: owner!.id
    })

    const res = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${agentId}`,
      { role: "admin" },
      admin
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("Agent cannot be granted admin role")

    // 确认其角色仍为 user
    const agent = await findUserById(env.DB, prefix, agentId)
    expect(agent?.role).toBe("user")
  })

  it("允许管理员停用、激活与删除 Agent 账号", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const prefix = "ciki_"

    const owner = await findUserByEmail(env.DB, prefix, "admin@example.com")
    const agentId = await createAgentUser(env.DB, prefix, {
      owner_user_id: owner!.id
    })

    // 1. 停用
    const disableRes = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${agentId}`,
      { isActive: false },
      admin
    )
    expect(disableRes.status).toBe(200)
    let agent = await findUserById(env.DB, prefix, agentId)
    expect(agent?.is_active).toBe(0)

    // 2. 重新激活
    const enableRes = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${agentId}`,
      { isActive: true },
      admin
    )
    expect(enableRes.status).toBe(200)
    agent = await findUserById(env.DB, prefix, agentId)
    expect(agent?.is_active).toBe(1)

    // 3. 删除
    const delRes = await jsonRequest(
      env,
      "DELETE",
      `/api/admin/users/${agentId}`,
      undefined,
      admin
    )
    expect(delRes.status).toBe(200)
    agent = await findUserById(env.DB, prefix, agentId)
    expect(agent).toBeNull()
  })
})

describe("展示用户身份的各 DTO 中的 isAgent 标记与管理面 owner 信息", () => {
  it("空间成员列表与候选 DTO 包含正确的 isAgent 标记（human false / agent true）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const owner = await userSession(env, admin, "space-owner@example.com")
    await userSession(env, admin, "outsider-human@example.com")
    const prefix = "ciki_"

    const ownerRow = await findUserByEmail(
      env.DB,
      prefix,
      "space-owner@example.com"
    )
    const outsiderRow = await findUserByEmail(
      env.DB,
      prefix,
      "outsider-human@example.com"
    )
    expect(ownerRow).not.toBeNull()
    expect(outsiderRow).not.toBeNull()

    // 创建 space
    const spaceRes = await jsonRequest(
      env,
      "POST",
      "/api/spaces",
      { name: "Agent 测试空间", description: "" },
      owner
    )
    expect(spaceRes.status).toBe(201)
    const space = (await spaceRes.json()) as { id: number }

    // 创建 agent
    const agentRes = await jsonRequest(
      env,
      "POST",
      "/api/me/agents",
      { username: "space-bot" },
      owner
    )
    expect(agentRes.status).toBe(201)
    const agentDto = (await agentRes.json()) as { id: number; username: string }

    // 1. 成员候选接口：GET /api/spaces/:id/member-candidates
    const candidatesRes = await jsonRequest(
      env,
      "GET",
      `/api/spaces/${space.id}/member-candidates`,
      undefined,
      owner
    )
    expect(candidatesRes.status).toBe(200)
    const candidates = (await candidatesRes.json()) as Array<{
      userId: number
      username: string
      email: string
      isAgent: boolean
    }>

    const humanCandidate = candidates.find((c) => c.userId === outsiderRow!.id)
    expect(humanCandidate).toBeDefined()
    expect(humanCandidate?.isAgent).toBe(false)

    const agentCandidate = candidates.find((c) => c.userId === agentDto.id)
    expect(agentCandidate).toBeDefined()
    expect(agentCandidate?.isAgent).toBe(true)

    // 2. 添加 agent 到空间：POST /api/spaces/:id/members
    const addAgentRes = await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space.id}/members`,
      { userId: agentDto.id, role: "editor" },
      owner
    )
    expect(addAgentRes.status).toBe(201)
    const addAgentBody = (await addAgentRes.json()) as {
      userId: number
      role: string
      isAgent: boolean
    }
    expect(addAgentBody.userId).toBe(agentDto.id)
    expect(addAgentBody.role).toBe("editor")
    expect(addAgentBody.isAgent).toBe(true)

    // 3. 修改 agent 成员角色：PUT /api/spaces/:id/members/:userId
    const putAgentRes = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${space.id}/members/${agentDto.id}`,
      { role: "admin" },
      owner
    )
    expect(putAgentRes.status).toBe(200)
    const putAgentBody = (await putAgentRes.json()) as {
      userId: number
      role: string
      isAgent: boolean
    }
    expect(putAgentBody.userId).toBe(agentDto.id)
    expect(putAgentBody.role).toBe("admin")
    expect(putAgentBody.isAgent).toBe(true)

    // 4. 添加人类成员到空间：POST /api/spaces/:id/members
    const addHumanRes = await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space.id}/members`,
      { userId: outsiderRow!.id, role: "viewer" },
      owner
    )
    expect(addHumanRes.status).toBe(201)
    const addHumanBody = (await addHumanRes.json()) as {
      userId: number
      isAgent: boolean
    }
    expect(addHumanBody.userId).toBe(outsiderRow!.id)
    expect(addHumanBody.isAgent).toBe(false)

    // 5. 获取空间成员列表：GET /api/spaces/:id/members
    const membersRes = await jsonRequest(
      env,
      "GET",
      `/api/spaces/${space.id}/members`,
      undefined,
      owner
    )
    expect(membersRes.status).toBe(200)
    const members = (await membersRes.json()) as Array<{
      userId: number
      username: string
      role: string
      isAgent: boolean
    }>

    const ownerMember = members.find((m) => m.userId === ownerRow!.id)
    expect(ownerMember).toBeDefined()
    expect(ownerMember?.isAgent).toBe(false)

    const humanMember = members.find((m) => m.userId === outsiderRow!.id)
    expect(humanMember).toBeDefined()
    expect(humanMember?.isAgent).toBe(false)

    const memberAgent = members.find((m) => m.userId === agentDto.id)
    expect(memberAgent).toBeDefined()
    expect(memberAgent?.isAgent).toBe(true)
  })

  it("页面详情署名字段 createdByIsAgent / updatedByIsAgent 取值正确", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const owner = await userSession(env, admin, "page-author@example.com")
    const prefix = "ciki_"

    const ownerRow = await findUserByEmail(
      env.DB,
      prefix,
      "page-author@example.com"
    )
    expect(ownerRow).not.toBeNull()

    // 1. 创建空间与 agent
    const spaceRes = await jsonRequest(
      env,
      "POST",
      "/api/spaces",
      { name: "署名测试空间", description: "" },
      owner
    )
    const space = (await spaceRes.json()) as { id: number }

    const agentRes = await jsonRequest(
      env,
      "POST",
      "/api/me/agents",
      { username: "writer-bot" },
      owner
    )
    const agent = (await agentRes.json()) as { id: number; username: string }

    // 将 agent 加入空间为 editor
    await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space.id}/members`,
      { userId: agent.id, role: "editor" },
      owner
    )

    // 为 agent 签发 write 令牌
    const tokenRes = await jsonRequest(
      env,
      "POST",
      `/api/me/agents/${agent.id}/tokens`,
      { kind: "write", name: "写操作令牌", spaceIds: [space.id] },
      owner
    )
    expect(tokenRes.status).toBe(201)
    const token = (await tokenRes.json()) as { token: string }

    // 2. 由人类用户创建页面
    const pageCreateRes = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        spaceId: space.id,
        title: "人类创建的页面",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>初版内容</p>",
        contentText: "初版内容"
      },
      owner
    )
    expect(pageCreateRes.status).toBe(201)
    const createdPage = (await pageCreateRes.json()) as {
      id: string
      createdBy: number
      createdByName: string
      createdByIsAgent: boolean
      updatedBy: number
      updatedByName: string
      updatedByIsAgent: boolean
    }
    expect(createdPage.createdBy).toBe(ownerRow!.id)
    expect(createdPage.createdByName).toBe(ownerRow!.username)
    expect(createdPage.createdByIsAgent).toBe(false)
    expect(createdPage.updatedBy).toBe(ownerRow!.id)
    expect(createdPage.updatedByName).toBe(ownerRow!.username)
    expect(createdPage.updatedByIsAgent).toBe(false)

    // GET /api/pages/:id 查看
    const getPageRes = await jsonRequest(
      env,
      "GET",
      `/api/pages/${createdPage.id}`,
      undefined,
      owner
    )
    expect(getPageRes.status).toBe(200)
    const pageDetail = (await getPageRes.json()) as typeof createdPage
    expect(pageDetail.createdByIsAgent).toBe(false)
    expect(pageDetail.updatedByIsAgent).toBe(false)

    const docContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "测试内容" }]
        }
      ]
    }

    // 3. 由 Agent 代管令牌更新页面
    const agentUpdateRes = await request(
      env,
      `/api/write/pages/${createdPage.id}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          title: "Agent 修改后的页面",
          content_json: docContent
        })
      }
    )
    expect(agentUpdateRes.status).toBe(200)

    // 再次查页面详情：createdBy 为人类 (isAgent=false)，updatedBy 为 Agent (isAgent=true)
    const afterUpdateRes = await jsonRequest(
      env,
      "GET",
      `/api/pages/${createdPage.id}`,
      undefined,
      owner
    )
    expect(afterUpdateRes.status).toBe(200)
    const afterUpdate = (await afterUpdateRes.json()) as typeof createdPage
    expect(afterUpdate.createdBy).toBe(ownerRow!.id)
    expect(afterUpdate.createdByName).toBe(ownerRow!.username)
    expect(afterUpdate.createdByIsAgent).toBe(false)
    expect(afterUpdate.updatedBy).toBe(agent.id)
    expect(afterUpdate.updatedByName).toBe(agent.username)
    expect(afterUpdate.updatedByIsAgent).toBe(true)

    // 4. 由 Agent 代管令牌创建新页面
    const agentCreatePageRes = await request(env, "/api/write/pages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        space_id: space.id,
        title: "Agent 创建的页面",
        content_json: docContent
      })
    })
    expect(agentCreatePageRes.status).toBe(201)
    const agentCreatedMeta = (await agentCreatePageRes.json()) as { id: string }

    const agentPageDetailRes = await jsonRequest(
      env,
      "GET",
      `/api/pages/${agentCreatedMeta.id}`,
      undefined,
      owner
    )
    expect(agentPageDetailRes.status).toBe(200)
    const agentPageDetail =
      (await agentPageDetailRes.json()) as typeof createdPage
    expect(agentPageDetail.createdBy).toBe(agent.id)
    expect(agentPageDetail.createdByName).toBe(agent.username)
    expect(agentPageDetail.createdByIsAgent).toBe(true)
    expect(agentPageDetail.updatedBy).toBe(agent.id)
    expect(agentPageDetail.updatedByName).toBe(agent.username)
    expect(agentPageDetail.updatedByIsAgent).toBe(true)
  })
})
