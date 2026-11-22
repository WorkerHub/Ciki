import { describe, expect, it } from "vitest"
import {
  adminSession,
  enableSmtpConfig,
  initializedContext,
  jsonRequest
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
    const rawColumns = db.db.prepare("PRAGMA table_info(ciki_users)").all() as Array<{
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
    await env.DB.prepare(
      `UPDATE ${prefix}users SET is_active = 0 WHERE id = ?`
    )
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
  it("列表返回包含 kind 与 ownerUserId", async () => {
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
      ownerUserId: number | null
    }>

    const agentDto = users.find((u) => u.id === agentId)
    expect(agentDto).toBeDefined()
    expect(agentDto?.kind).toBe("agent")
    expect(agentDto?.ownerUserId).toBe(owner!.id)
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
