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
  AGENT_UNVERIFIABLE_PASSWORD_HASH,
  repairAgentEmails,
  LONG_AGENT_EMAIL_REGEX
} from "../src/db/queries/users"
import { insertPasskey } from "../src/db/queries/passkeys"
import { findSession } from "../src/core/session"
import { sha256Hex } from "../src/core/auth"
import { sessionsTable, usersTable } from "../src/lib/tables"
import { insertComment } from "../src/db/queries/comments"
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
    expect(agent?.email).toBe(`${agent?.username}@internal`)
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
    expect(agent2?.email).toBe(`${agent2?.username}@internal`)

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

  it("未显式传 email 时，占位邮箱推导自最终分配的 username（含自动短用户名与冲突重试）", async () => {
    const { env } = await initializedContext()
    const prefix = "ciki_"

    const ownerId = await createApprovedUser(env.DB, prefix, {
      email: "owner-derive@example.com",
      username: "owner-derive",
      password_hash: "hash",
      role: "user"
    })

    // 1. 未传 username、未传 email：自动分配短用户名 agent-<8位十六进制>，邮箱为 <username>@internal
    const autoAgentId = await createAgentUser(env.DB, prefix, {
      owner_user_id: ownerId
    })
    const autoAgent = await findUserById(env.DB, prefix, autoAgentId)
    expect(autoAgent).not.toBeNull()
    expect(autoAgent?.username).toMatch(/^agent-[a-f0-9]{8}$/)
    expect(autoAgent?.email).toBe(`${autoAgent?.username}@internal`)

    // 2. 指定 username、未传 email：邮箱推导为 <username>@internal
    const namedAgentId = await createAgentUser(env.DB, prefix, {
      owner_user_id: ownerId,
      username: "worker-bee"
    })
    const namedAgent = await findUserById(env.DB, prefix, namedAgentId)
    expect(namedAgent).not.toBeNull()
    expect(namedAgent?.username).toBe("worker-bee")
    expect(namedAgent?.email).toBe("worker-bee@internal")

    // 3. 用户名重试：相同 username、未传 email，推导邮箱跟随最终 candidate
    const retryAgentId = await createAgentUser(env.DB, prefix, {
      owner_user_id: ownerId,
      username: "worker-bee"
    })
    const retryAgent = await findUserById(env.DB, prefix, retryAgentId)
    expect(retryAgent).not.toBeNull()
    expect(retryAgent?.username).toBe("worker-bee-2")
    expect(retryAgent?.email).toBe("worker-bee-2@internal")

    // 4. 显式传 email：即便发生用户名重试，邮箱仍原样落库不被重写
    const explicitEmailAgentId = await createAgentUser(env.DB, prefix, {
      owner_user_id: ownerId,
      username: "worker-bee",
      email: "custom-explicit@internal"
    })
    const explicitEmailAgent = await findUserById(
      env.DB,
      prefix,
      explicitEmailAgentId
    )
    expect(explicitEmailAgent).not.toBeNull()
    expect(explicitEmailAgent?.username).toBe("worker-bee-3")
    expect(explicitEmailAgent?.email).toBe("custom-explicit@internal")

    // 5. 派生邮箱撞上既有用户 email（用户名未撞）：触发 isEmailConflict 重试，平滑分配下一后缀
    await createApprovedUser(env.DB, prefix, {
      email: "worker-bee-4@internal",
      username: "different-user-taking-email",
      password_hash: "hash",
      role: "user"
    })
    const emailCollideAgentId = await createAgentUser(env.DB, prefix, {
      owner_user_id: ownerId,
      username: "worker-bee"
    })
    const emailCollideAgent = await findUserById(
      env.DB,
      prefix,
      emailCollideAgentId
    )
    expect(emailCollideAgent).not.toBeNull()
    expect(emailCollideAgent?.username).toBe("worker-bee-5")
    expect(emailCollideAgent?.email).toBe("worker-bee-5@internal")
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
      transports: "[]",
      name: "Agent Passkey"
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
      username: string
      kind: string
      isAgent: boolean
      ownerUserId: number | null
      owner: { id: number; username: string } | null
      ownerName: string | null
    }>

    const agentDto = users.find((u) => u.id === agentId)
    expect(agentDto).toBeDefined()
    expect(agentDto?.username).toBe("ciki-bot")
    expect(agentDto?.isAgent).toBe(true)
    expect(agentDto?.kind).toBe("agent")
    expect(agentDto?.ownerUserId).toBe(owner!.id)
    expect(agentDto?.owner).toEqual({
      id: owner!.id,
      username: owner!.username
    })
    expect(agentDto?.ownerName).toBe(owner!.username)

    const humanDto = users.find((u) => u.id === owner!.id)
    expect(humanDto).toBeDefined()
    expect(humanDto?.username).toBe(owner!.username)
    expect(humanDto?.isAgent).toBe(false)
    expect(humanDto?.kind).toBe("human")
    expect(humanDto?.ownerUserId).toBeNull()
    expect(humanDto?.owner).toBeNull()
    expect(humanDto?.ownerName).toBeNull()
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
  it("空间成员列表与候选 DTO 包含正确的 isAgent 与 ownerName 标记（human false / agent true）", async () => {
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
      ownerName: string | null
    }>

    const humanCandidate = candidates.find((c) => c.userId === outsiderRow!.id)
    expect(humanCandidate).toBeDefined()
    expect(humanCandidate?.isAgent).toBe(false)
    expect(humanCandidate?.ownerName).toBeNull()

    const agentCandidate = candidates.find((c) => c.userId === agentDto.id)
    expect(agentCandidate).toBeDefined()
    expect(agentCandidate?.isAgent).toBe(true)
    expect(agentCandidate?.ownerName).toBe(ownerRow!.username)

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
      ownerName: string | null
    }
    expect(addAgentBody.userId).toBe(agentDto.id)
    expect(addAgentBody.role).toBe("editor")
    expect(addAgentBody.isAgent).toBe(true)
    expect(addAgentBody.ownerName).toBe(ownerRow!.username)

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
      ownerName: string | null
    }
    expect(putAgentBody.userId).toBe(agentDto.id)
    expect(putAgentBody.role).toBe("admin")
    expect(putAgentBody.isAgent).toBe(true)
    expect(putAgentBody.ownerName).toBe(ownerRow!.username)

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
      ownerName: string | null
    }
    expect(addHumanBody.userId).toBe(outsiderRow!.id)
    expect(addHumanBody.isAgent).toBe(false)
    expect(addHumanBody.ownerName).toBeNull()

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
      ownerName: string | null
    }>

    const ownerMember = members.find((m) => m.userId === ownerRow!.id)
    expect(ownerMember).toBeDefined()
    expect(ownerMember?.isAgent).toBe(false)
    expect(ownerMember?.ownerName).toBeNull()

    const humanMember = members.find((m) => m.userId === outsiderRow!.id)
    expect(humanMember).toBeDefined()
    expect(humanMember?.isAgent).toBe(false)
    expect(humanMember?.ownerName).toBeNull()

    const memberAgent = members.find((m) => m.userId === agentDto.id)
    expect(memberAgent).toBeDefined()
    expect(memberAgent?.isAgent).toBe(true)
    expect(memberAgent?.ownerName).toBe(ownerRow!.username)
  })

  it("页面详情署名字段 createdByIsAgent / updatedByIsAgent 与 createdByOwnerName / updatedByOwnerName 取值正确", async () => {
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
      createdByOwnerName: string | null
      updatedBy: number
      updatedByName: string
      updatedByIsAgent: boolean
      updatedByOwnerName: string | null
    }
    expect(createdPage.createdBy).toBe(ownerRow!.id)
    expect(createdPage.createdByName).toBe(ownerRow!.username)
    expect(createdPage.createdByIsAgent).toBe(false)
    expect(createdPage.createdByOwnerName).toBeNull()
    expect(createdPage.updatedBy).toBe(ownerRow!.id)
    expect(createdPage.updatedByName).toBe(ownerRow!.username)
    expect(createdPage.updatedByIsAgent).toBe(false)
    expect(createdPage.updatedByOwnerName).toBeNull()

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
    expect(pageDetail.createdByOwnerName).toBeNull()
    expect(pageDetail.updatedByIsAgent).toBe(false)
    expect(pageDetail.updatedByOwnerName).toBeNull()

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

    // 再次查页面详情：createdBy 为人类 (isAgent=false, ownerName=null)，updatedBy 为 Agent (isAgent=true, ownerName=owner.username)
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
    expect(afterUpdate.createdByOwnerName).toBeNull()
    expect(afterUpdate.updatedBy).toBe(agent.id)
    expect(afterUpdate.updatedByName).toBe(agent.username)
    expect(afterUpdate.updatedByIsAgent).toBe(true)
    expect(afterUpdate.updatedByOwnerName).toBe(ownerRow!.username)

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
    expect(agentPageDetail.createdByOwnerName).toBe(ownerRow!.username)
    expect(agentPageDetail.updatedBy).toBe(agent.id)
    expect(agentPageDetail.updatedByName).toBe(agent.username)
    expect(agentPageDetail.updatedByIsAgent).toBe(true)
    expect(agentPageDetail.updatedByOwnerName).toBe(ownerRow!.username)
  })

  it("评论 DTO 包含 isAgent 与 ownerName，且作者为人类/Agent 时取值正确", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const owner = await userSession(env, admin, "comment-owner@example.com")
    const prefix = "ciki_"

    const ownerRow = await findUserByEmail(
      env.DB,
      prefix,
      "comment-owner@example.com"
    )
    expect(ownerRow).not.toBeNull()

    // 1. 创建空间、页面与 agent
    const spaceRes = await jsonRequest(
      env,
      "POST",
      "/api/spaces",
      { name: "评论测试空间", description: "" },
      owner
    )
    const space = (await spaceRes.json()) as { id: number }

    const agentRes = await jsonRequest(
      env,
      "POST",
      "/api/me/agents",
      { username: "comment-bot" },
      owner
    )
    const agent = (await agentRes.json()) as { id: number; username: string }

    const pageRes = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        spaceId: space.id,
        title: "评论测试页面",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>正文</p>",
        contentText: "正文"
      },
      owner
    )
    const page = (await pageRes.json()) as { id: string }

    // 2. 人类发表主评论：POST /api/pages/:id/comments
    const postHumanCommentRes = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments`,
      { bodyMd: "人类发表的评论" },
      owner
    )
    expect(postHumanCommentRes.status).toBe(201)
    const humanCommentDto = (await postHumanCommentRes.json()) as {
      id: number
      authorName: string
      isAgent: boolean
      ownerName: string | null
    }
    expect(humanCommentDto.isAgent).toBe(false)
    expect(humanCommentDto.ownerName).toBeNull()

    // 3. Agent 发表回复
    const agentCommentId = await insertComment(env.DB, prefix, {
      pageId: Number(page.id),
      parentId: humanCommentDto.id,
      authorId: agent.id,
      bodyMd: "Agent 回复的评论",
      createdAt: new Date().toISOString()
    })
    expect(agentCommentId).toBeGreaterThan(0)

    // 4. 查询评论列表：GET /api/pages/:id/comments
    const listRes = await jsonRequest(
      env,
      "GET",
      `/api/pages/${page.id}/comments`,
      undefined,
      owner
    )
    expect(listRes.status).toBe(200)
    const listBody = (await listRes.json()) as {
      total: number
      threads: Array<{
        id: number
        authorName: string
        isAgent: boolean
        ownerName: string | null
        replies: Array<{
          id: number
          authorName: string
          isAgent: boolean
          ownerName: string | null
        }>
      }>
    }
    expect(listBody.total).toBe(2)
    const topThread = listBody.threads[0]
    expect(topThread.id).toBe(humanCommentDto.id)
    expect(topThread.isAgent).toBe(false)
    expect(topThread.ownerName).toBeNull()

    expect(topThread.replies).toHaveLength(1)
    const reply = topThread.replies[0]
    expect(reply.id).toBe(agentCommentId)
    expect(reply.authorName).toBe(agent.username)
    expect(reply.isAgent).toBe(true)
    expect(reply.ownerName).toBe(ownerRow!.username)
  })

  it("当 Agent 的 Owner 被删除或不存在时，各处 ownerName 均安全回落为 null", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const owner = await userSession(env, admin, "orphan-owner@example.com")
    const prefix = "ciki_"

    const ownerRow = await findUserByEmail(
      env.DB,
      prefix,
      "orphan-owner@example.com"
    )
    expect(ownerRow).not.toBeNull()

    // 1. 创建空间与 agent
    const spaceRes = await jsonRequest(
      env,
      "POST",
      "/api/spaces",
      { name: "孤儿测试空间", description: "" },
      owner
    )
    const space = (await spaceRes.json()) as { id: number }

    const agentRes = await jsonRequest(
      env,
      "POST",
      "/api/me/agents",
      { username: "orphan-bot" },
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

    // 创建页面并由 agent 成为 author
    const pageRes = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        spaceId: space.id,
        title: "孤儿 Agent 页面",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>正文</p>",
        contentText: "正文"
      },
      owner
    )
    const page = (await pageRes.json()) as { id: string }

    // 将页面的 created_by 和 updated_by 改为 agent
    await env.DB.prepare(
      `UPDATE ${prefix}pages SET created_by = ?, updated_by = ? WHERE id = ?`
    )
      .bind(agent.id, agent.id, Number(page.id))
      .run()

    // 插入 agent 评论
    await insertComment(env.DB, prefix, {
      pageId: Number(page.id),
      parentId: null,
      authorId: agent.id,
      bodyMd: "孤儿 Agent 的评论",
      createdAt: new Date().toISOString()
    })

    // 2. 彻底硬删除 owner 用户行
    await env.DB.prepare(`DELETE FROM ${usersTable(prefix)} WHERE id = ?`)
      .bind(ownerRow!.id)
      .run()

    // 3. 验证页面详情：createdByIsAgent 为 true，但 createdByOwnerName 回落为 null
    const getPageRes = await jsonRequest(
      env,
      "GET",
      `/api/pages/${page.id}`,
      undefined,
      admin
    )
    expect(getPageRes.status).toBe(200)
    const pageDetail = (await getPageRes.json()) as {
      createdByIsAgent: boolean
      createdByOwnerName: string | null
      updatedByIsAgent: boolean
      updatedByOwnerName: string | null
    }
    expect(pageDetail.createdByIsAgent).toBe(true)
    expect(pageDetail.createdByOwnerName).toBeNull()
    expect(pageDetail.updatedByIsAgent).toBe(true)
    expect(pageDetail.updatedByOwnerName).toBeNull()

    // 4. 验证评论列表：isAgent 为 true，但 ownerName 回落为 null
    const commentsRes = await jsonRequest(
      env,
      "GET",
      `/api/pages/${page.id}/comments`,
      undefined,
      admin
    )
    expect(commentsRes.status).toBe(200)
    const commentsBody = (await commentsRes.json()) as {
      threads: Array<{
        isAgent: boolean
        ownerName: string | null
      }>
    }
    expect(commentsBody.threads).toHaveLength(1)
    expect(commentsBody.threads[0].isAgent).toBe(true)
    expect(commentsBody.threads[0].ownerName).toBeNull()

    // 5. 验证空间成员列表：isAgent 为 true，但 ownerName 回落为 null
    const membersRes = await jsonRequest(
      env,
      "GET",
      `/api/spaces/${space.id}/members`,
      undefined,
      admin
    )
    expect(membersRes.status).toBe(200)
    const members = (await membersRes.json()) as Array<{
      userId: number
      isAgent: boolean
      ownerName: string | null
    }>
    const agentMember = members.find((m) => m.userId === agent.id)
    expect(agentMember).toBeDefined()
    expect(agentMember?.isAgent).toBe(true)
    expect(agentMember?.ownerName).toBeNull()

    // 6. 验证系统管理用户列表：isAgent 为 true，但 ownerName 回落为 null
    const adminUsersRes = await jsonRequest(
      env,
      "GET",
      "/api/admin/users",
      undefined,
      admin
    )
    expect(adminUsersRes.status).toBe(200)
    const adminUsers = (await adminUsersRes.json()) as Array<{
      id: number
      isAgent: boolean
      owner: unknown
      ownerName: string | null
    }>
    const adminAgent = adminUsers.find((u) => u.id === agent.id)
    expect(adminAgent).toBeDefined()
    expect(adminAgent?.isAgent).toBe(true)
    expect(adminAgent?.owner).toBeNull()
    expect(adminAgent?.ownerName).toBeNull()
  })

  it("当评论作者被彻底删除时，isAgent 为 false，ownerName 为 null，authorName 回落为已注销用户", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin, "deleted-author@example.com")
    const prefix = "ciki_"

    const userRow = await findUserByEmail(
      env.DB,
      prefix,
      "deleted-author@example.com"
    )
    expect(userRow).not.toBeNull()

    // 创建空间与页面
    const spaceRes = await jsonRequest(
      env,
      "POST",
      "/api/spaces",
      { name: "已注销作者测试空间", description: "" },
      user
    )
    const space = (await spaceRes.json()) as { id: number }

    const pageRes = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        spaceId: space.id,
        title: "已注销作者测试页面",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>正文</p>",
        contentText: "正文"
      },
      user
    )
    const page = (await pageRes.json()) as { id: string }

    // 发表评论
    const commentId = await insertComment(env.DB, prefix, {
      pageId: Number(page.id),
      parentId: null,
      authorId: userRow!.id,
      bodyMd: "已注销用户的评论",
      createdAt: new Date().toISOString()
    })

    // 彻底删除作者用户
    await env.DB.prepare(`DELETE FROM ${usersTable(prefix)} WHERE id = ?`)
      .bind(userRow!.id)
      .run()

    // 查询评论列表
    const commentsRes = await jsonRequest(
      env,
      "GET",
      `/api/pages/${page.id}/comments`,
      undefined,
      admin
    )
    expect(commentsRes.status).toBe(200)
    const commentsBody = (await commentsRes.json()) as {
      threads: Array<{
        id: number
        authorName: string
        isAgent: boolean
        ownerName: string | null
      }>
    }
    expect(commentsBody.threads).toHaveLength(1)
    expect(commentsBody.threads[0].id).toBe(commentId)
    expect(commentsBody.threads[0].authorName).toBe("已注销用户")
    expect(commentsBody.threads[0].isAgent).toBe(false)
    expect(commentsBody.threads[0].ownerName).toBeNull()
  })
})

describe("Agent 占位邮箱存量刷短：一次性数据修复 (Task #109)", () => {
  it("正则仅匹配严格的 agent-<36位uuid>@internal", () => {
    // 合法形态
    expect(
      LONG_AGENT_EMAIL_REGEX.test(
        "agent-84e9a354-94b3-4d82-ae1e-6b4a45f78005@internal"
      )
    ).toBe(true)
    expect(
      LONG_AGENT_EMAIL_REGEX.test(
        "agent-00000000-0000-0000-0000-000000000000@internal"
      )
    ).toBe(true)

    // 非法形态
    expect(LONG_AGENT_EMAIL_REGEX.test("agent-short@internal")).toBe(false)
    expect(LONG_AGENT_EMAIL_REGEX.test("Muse@internal")).toBe(false)
    expect(LONG_AGENT_EMAIL_REGEX.test("agent-84e9a354@internal")).toBe(false)
    expect(
      LONG_AGENT_EMAIL_REGEX.test(
        "agent-84E9A354-94B3-4D82-AE1E-6B4A45F78005@internal"
      )
    ).toBe(false)
    expect(
      LONG_AGENT_EMAIL_REGEX.test(
        "agent-84e9a354-94b3-4d82-ae1e-6b4a45f78005@example.com"
      )
    ).toBe(false)
    expect(
      LONG_AGENT_EMAIL_REGEX.test(
        "user-84e9a354-94b3-4d82-ae1e-6b4a45f78005@internal"
      )
    ).toBe(false)
  })

  it("仅修改 kind='agent' 且符合长式占位形态的邮箱，跳过真人与非长式 agent，且完全幂等", async () => {
    const { env } = await initializedContext()
    const prefix = "ciki_"

    // 1. 创建人类用户
    const ownerId = await createApprovedUser(env.DB, prefix, {
      email: "human_owner@example.com",
      username: "humanowner",
      password_hash: "hash",
      role: "user"
    })

    // 创建一个邮箱形似长式占位的人类用户（极端边界：kind=human 绝不可被碰）
    const humanWithLongAgentEmailId = await env.DB.prepare(
      `INSERT INTO ${usersTable(prefix)}
        (email, username, password_hash, role, is_active, approval_status,
         email_verified, language, kind, owner_user_id, avatar_key, created_at, updated_at)
       VALUES (?, ?, 'hash', 'user', 1, 'approved', 1, 'zh', 'human', NULL, '', ?, ?)`
    )
      .bind(
        "agent-11111111-1111-1111-1111-111111111111@internal",
        "fakehumanagent",
        new Date().toISOString(),
        new Date().toISOString()
      )
      .run()
      .then((r) => r.meta.last_row_id)

    // 2. 创建三个 agent 用户：
    // - agent1: 长式占位邮箱（待修复目标）
    // - agent2: 显式自定义邮箱（不应修改）
    // - agent3: 已经是短式邮箱（新生成口径，不应修改）
    const agent1Id = await env.DB.prepare(
      `INSERT INTO ${usersTable(prefix)}
        (email, username, password_hash, role, is_active, approval_status,
         email_verified, language, kind, owner_user_id, avatar_key, created_at, updated_at)
       VALUES (?, ?, ?, 'user', 1, 'approved', 1, 'zh', 'agent', ?, '', ?, ?)`
    )
      .bind(
        "agent-84e9a354-94b3-4d82-ae1e-6b4a45f78005@internal",
        "agenttarget1",
        AGENT_UNVERIFIABLE_PASSWORD_HASH,
        ownerId,
        new Date().toISOString(),
        new Date().toISOString()
      )
      .run()
      .then((r) => r.meta.last_row_id)

    const agent2Id = await createAgentUser(env.DB, prefix, {
      owner_user_id: ownerId,
      username: "agentcustom",
      email: "custom-agent@example.com"
    })

    const agent3Id = await createAgentUser(env.DB, prefix, {
      owner_user_id: ownerId,
      username: "agentshort"
    })

    // 验证初始状态
    const initHuman = await findUserById(
      env.DB,
      prefix,
      humanWithLongAgentEmailId
    )
    const initAgent1 = await findUserById(env.DB, prefix, agent1Id)
    const initAgent2 = await findUserById(env.DB, prefix, agent2Id)
    const initAgent3 = await findUserById(env.DB, prefix, agent3Id)

    expect(initHuman?.email).toBe(
      "agent-11111111-1111-1111-1111-111111111111@internal"
    )
    expect(initAgent1?.email).toBe(
      "agent-84e9a354-94b3-4d82-ae1e-6b4a45f78005@internal"
    )
    expect(initAgent2?.email).toBe("custom-agent@example.com")
    expect(initAgent3?.email).toBe("agentshort@internal")

    // 执行存量刷短
    const firstResult = await repairAgentEmails(env.DB, prefix)
    expect(firstResult.matchedCount).toBe(1)
    expect(firstResult.updatedCount).toBe(1)
    expect(firstResult.residualCount).toBe(0)

    // 校验执行后数据
    const afterHuman = await findUserById(
      env.DB,
      prefix,
      humanWithLongAgentEmailId
    )
    const afterAgent1 = await findUserById(env.DB, prefix, agent1Id)
    const afterAgent2 = await findUserById(env.DB, prefix, agent2Id)
    const afterAgent3 = await findUserById(env.DB, prefix, agent3Id)

    // 人类账号邮箱绝对不碰
    expect(afterHuman?.email).toBe(
      "agent-11111111-1111-1111-1111-111111111111@internal"
    )
    // 目标 agent 邮箱更新为 <username>@internal
    expect(afterAgent1?.email).toBe("agenttarget1@internal")
    // 不修改 updated_at 等无关字段（规格仅更新 email）
    expect(afterAgent1?.updated_at).toBe(initAgent1?.updated_at)
    // 自定义邮箱 agent 不碰
    expect(afterAgent2?.email).toBe("custom-agent@example.com")
    // 原本已是短式的 agent 不碰
    expect(afterAgent3?.email).toBe("agentshort@internal")

    // 第二遍执行验证幂等性（no-op）
    const secondResult = await repairAgentEmails(env.DB, prefix)
    expect(secondResult.matchedCount).toBe(0)
    expect(secondResult.updatedCount).toBe(0)
    expect(secondResult.residualCount).toBe(0)
  })
})
