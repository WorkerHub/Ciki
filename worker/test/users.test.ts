import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  userSession
} from "./support/app"
import {
  createAgentUser,
  deleteUser,
  findUserByEmail,
  updateUser
} from "../src/db/queries/users"
import { getTablePrefix } from "../src/lib/table-prefix"
import { softDeleteSubtree } from "../src/db/queries/pages"

interface ProfileResponse {
  id: number
  username: string
  avatarUrl: string | null
  isAgent: boolean
  ownerName: string | null
  createdAt: string
  email?: unknown
  password_hash?: unknown
  role?: unknown
  email_verified?: unknown
  language?: unknown
  is_active?: unknown
  approval_status?: unknown
}

interface PagesResponse {
  pages: Array<{
    id: number
    title: string
    spaceName: string
    createdAt: string
    updatedAt: string
  }>
  total: number
  page: number
  limit: number
  hasMore: boolean
}

async function createPage(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  input: {
    title: string
    parentId?: number | null
    spaceId?: number | null
    contentHtml?: string
    contentText?: string
  }
) {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/pages",
    {
      title: input.title,
      parentId: input.parentId ?? null,
      spaceId: input.spaceId ?? null,
      contentJson: JSON.stringify({ type: "doc" }),
      contentHtml: input.contentHtml ?? `<p>${input.title}</p>`,
      contentText: input.contentText ?? input.title
    },
    cookie
  )
  expect(res.status).toBe(201)
  return (await res.json()) as {
    id: number
    createdBy: number
    createdById: number
    updatedBy: number
    updatedById: number
  }
}

describe("作者主页后端接口：GET /api/users/:id/profile", () => {
  it("未登录会话访问返回 401 Unauthorized", async () => {
    const { env } = await initializedContext()
    const res = await jsonRequest(env, "GET", "/api/users/1/profile")
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "Unauthorized" })
  })

  it("id 非规范十进制正整数（非数字、0、负数、前导零、旧 UUID）返回 404", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    for (const badId of [
      "abc",
      "0",
      "-1",
      "01",
      "1.5",
      "123e4567-e89b-12d3-a456-426614174000"
    ]) {
      const res = await jsonRequest(
        env,
        "GET",
        `/api/users/${badId}/profile`,
        undefined,
        admin
      )
      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ error: "User not found" })
    }
  })

  it("用户不存在返回 404", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const res = await jsonRequest(
      env,
      "GET",
      "/api/users/999999/profile",
      undefined,
      admin
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: "User not found" })
  })

  it("人类用户返回公开资料，ownerName 为 null，绝不泄露敏感字段", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await userSession(env, admin, "alice@example.com")
    const prefix = getTablePrefix(env)

    const alice = await findUserByEmail(env.DB, prefix, "alice@example.com")
    expect(alice).not.toBeNull()

    // 设置头像 key
    await updateUser(env.DB, prefix, alice!.id, {
      avatar_key: "avatars/alice-test.png"
    })

    const res = await jsonRequest(
      env,
      "GET",
      `/api/users/${alice!.id}/profile`,
      undefined,
      admin
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ProfileResponse

    expect(body.id).toBe(alice!.id)
    expect(body.username).toBe(alice!.username)
    expect(body.avatarUrl).toBe("/api/files/avatars/alice-test.png")
    expect(body.isAgent).toBe(false)
    expect(body.ownerName).toBeNull()
    expect(body.createdAt).toBe(alice!.created_at)

    // 冻结契约断言：严格杜绝任何敏感字段
    expect(body.email).toBeUndefined()
    expect(body.password_hash).toBeUndefined()
    expect(body.role).toBeUndefined()
    expect(body.email_verified).toBeUndefined()
    expect(body.language).toBeUndefined()
    expect(body.is_active).toBeUndefined()
    expect(body.approval_status).toBeUndefined()
  })

  it("Agent 用户返回公开资料，带归属人 ownerName", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const prefix = getTablePrefix(env)

    await userSession(env, admin, "human-owner@example.com")
    const ownerRow = (await findUserByEmail(
      env.DB,
      prefix,
      "human-owner@example.com"
    ))!
    const ownerId = ownerRow.id
    const agentId = await createAgentUser(env.DB, prefix, {
      owner_user_id: ownerId,
      username: "deploy-agent",
      avatar_key: "avatars/agent.png"
    })

    const res = await jsonRequest(
      env,
      "GET",
      `/api/users/${agentId}/profile`,
      undefined,
      admin
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ProfileResponse

    expect(body.id).toBe(agentId)
    expect(body.username).toBe("deploy-agent")
    expect(body.avatarUrl).toBe("/api/files/avatars/agent.png")
    expect(body.isAgent).toBe(true)
    expect(body.ownerName).toBe(ownerRow.username)

    // 若 agent 的 owner 用户被注销删除，ownerName 安全回落为 null
    await deleteUser(env.DB, prefix, ownerId)
    const resAfterDelete = await jsonRequest(
      env,
      "GET",
      `/api/users/${agentId}/profile`,
      undefined,
      admin
    )
    expect(resAfterDelete.status).toBe(200)
    const bodyAfterDelete = (await resAfterDelete.json()) as ProfileResponse
    expect(bodyAfterDelete.isAgent).toBe(true)
    expect(bodyAfterDelete.ownerName).toBeNull()
  })

  it("用户改名后，按数字 id 的旧链接依然可达并返回新用户名（验收标准：Jim 真跑）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await userSession(env, admin, "charlie@example.com")
    const prefix = getTablePrefix(env)

    const charlie = await findUserByEmail(env.DB, prefix, "charlie@example.com")
    const originalId = charlie!.id

    // 改名
    await updateUser(env.DB, prefix, originalId, {
      username: "charlie-renamed"
    })

    // 使用原数字 id 访问
    const res = await jsonRequest(
      env,
      "GET",
      `/api/users/${originalId}/profile`,
      undefined,
      admin
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ProfileResponse
    expect(body.id).toBe(originalId)
    expect(body.username).toBe("charlie-renamed")
  })
})

describe("作者页面列表接口：GET /api/users/:id/pages 权限过滤与分页", () => {
  it("未登录会话访问返回 401 Unauthorized", async () => {
    const { env } = await initializedContext()
    const res = await jsonRequest(env, "GET", "/api/users/1/pages")
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "Unauthorized" })
  })

  it("用户不存在或 id 非法返回 404", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const res1 = await jsonRequest(
      env,
      "GET",
      "/api/users/999999/pages",
      undefined,
      admin
    )
    expect(res1.status).toBe(404)
    const res2 = await jsonRequest(
      env,
      "GET",
      "/api/users/bad/pages",
      undefined,
      admin
    )
    expect(res2.status).toBe(404)
  })

  it("权限隔离（验收标准：Tony 对照核 & Jim 真跑）：A 看 B 只能看见 A 有权空间的 B 的页面，无权空间页面标题零泄露，软删页面排除", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const alice = await userSession(env, admin, "alice@example.com") // 查看者 A
    const bob = await userSession(env, admin, "bob@example.com") // 作者 B
    const prefix = getTablePrefix(env)

    const aliceRow = (await findUserByEmail(
      env.DB,
      prefix,
      "alice@example.com"
    ))!
    const bobRow = (await findUserByEmail(env.DB, prefix, "bob@example.com"))!

    // 1. Bob 创建空间 1（共享空间）：Bob 建空间后是 admin，邀请 Alice 进入空间 1
    const space1Res = await jsonRequest(
      env,
      "POST",
      "/api/spaces",
      { name: "共享空间 1" },
      bob
    )
    expect(space1Res.status).toBe(201)
    const space1 = (await space1Res.json()) as { id: number; name: string }

    // 将 Alice 添加为空间 1 的成员
    const addMemberRes = await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space1.id}/members`,
      { userId: aliceRow.id, role: "viewer" },
      bob
    )
    expect(addMemberRes.status).toBe(201)

    // 2. Bob 创建空间 2（私有空间）：只有 Bob 是成员，Alice 不是成员
    const space2Res = await jsonRequest(
      env,
      "POST",
      "/api/spaces",
      { name: "绝密空间 2" },
      bob
    )
    expect(space2Res.status).toBe(201)
    const space2 = (await space2Res.json()) as { id: number; name: string }

    // 3. Bob 在共享空间 1 创建正常页面 P1
    const p1 = await createPage(env, bob, {
      title: "公开文档 P1",
      spaceId: space1.id
    })

    // 4. Bob 在共享空间 1 创建页面 P1_Trash，随后将其软删除
    const pTrash = await createPage(env, bob, {
      title: "回收站文档 P_Trash",
      spaceId: space1.id
    })
    // 执行软删
    const deleteStmts = softDeleteSubtree(
      env.DB,
      prefix,
      pTrash.id,
      new Date().toISOString()
    )
    for (const stmt of deleteStmts) await stmt.run()

    // 5. Bob 在私有空间 2 创建私密页面 P2
    const p2 = await createPage(env, bob, {
      title: "机密文档 P2",
      spaceId: space2.id
    })

    // ── 核心断言 1：Alice 作为普通成员查看 Bob 的作者主页 ──────────────────────────────
    const aliceViewRes = await jsonRequest(
      env,
      "GET",
      `/api/users/${bobRow.id}/pages`,
      undefined,
      alice
    )
    expect(aliceViewRes.status).toBe(200)
    const aliceView = (await aliceViewRes.json()) as PagesResponse

    expect(aliceView.total).toBe(1)
    expect(aliceView.pages).toHaveLength(1)
    expect(aliceView.pages[0].id).toBe(p1.id)
    expect(aliceView.pages[0].title).toBe("公开文档 P1")
    expect(aliceView.pages[0].spaceName).toBe("共享空间 1")
    expect(aliceView.pages[0].createdAt).toBeDefined()
    expect(aliceView.pages[0].updatedAt).toBeDefined()

    // 严密检查：机密文档与回收站文档的任何痕迹（ID、标题）零泄露
    const allTitles = aliceView.pages.map((p) => p.title).join(" ")
    expect(allTitles).not.toContain("机密文档")
    expect(allTitles).not.toContain("绝密空间")
    expect(allTitles).not.toContain("回收站文档")

    // ── 核心断言 2：Bob 本人看自己主页 ──────────────────────────────────────────────
    const bobSelfRes = await jsonRequest(
      env,
      "GET",
      `/api/users/${bobRow.id}/pages`,
      undefined,
      bob
    )
    expect(bobSelfRes.status).toBe(200)
    const bobSelf = (await bobSelfRes.json()) as PagesResponse
    // Bob 能看到自己在空间 1 与空间 2 的 2 篇正常页面（软删的依然排除）
    expect(bobSelf.total).toBe(2)
    expect(bobSelf.pages.map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort())

    // ── 核心断言 3：站点管理员看 Bob 主页 ──────────────────────────────────────────
    const adminViewRes = await jsonRequest(
      env,
      "GET",
      `/api/users/${bobRow.id}/pages`,
      undefined,
      admin
    )
    expect(adminViewRes.status).toBe(200)
    const adminView = (await adminViewRes.json()) as PagesResponse
    // 管理员全空间可见（见空间 1 和空间 2 的 2 篇，软删同样排除）
    expect(adminView.total).toBe(2)
    expect(adminView.pages.map((p) => p.id).sort()).toEqual(
      [p1.id, p2.id].sort()
    )
  })

  it("分页与排序：按 updatedAt 倒序；支持 limit/page 与 limit/offset", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const charlie = await userSession(env, admin, "charlie@example.com")
    const prefix = getTablePrefix(env)
    const charlieRow = (await findUserByEmail(
      env.DB,
      prefix,
      "charlie@example.com"
    ))!

    const spaceRes = await jsonRequest(
      env,
      "POST",
      "/api/spaces",
      { name: "分页测试空间" },
      charlie
    )
    const space = (await spaceRes.json()) as { id: number }

    // 创建 5 篇页面，每篇设定不同时间保证排序
    const pageIds: number[] = []
    for (let i = 1; i <= 5; i++) {
      const p = await createPage(env, charlie, {
        title: `页面序号 ${i}`,
        spaceId: space.id
      })
      pageIds.push(p.id)
    }

    // 测试 limit=2&page=1
    const p1Res = await jsonRequest(
      env,
      "GET",
      `/api/users/${charlieRow.id}/pages?limit=2&page=1`,
      undefined,
      charlie
    )
    expect(p1Res.status).toBe(200)
    const p1 = (await p1Res.json()) as PagesResponse
    expect(p1.total).toBe(5)
    expect(p1.page).toBe(1)
    expect(p1.limit).toBe(2)
    expect(p1.hasMore).toBe(true)
    expect(p1.pages).toHaveLength(2)

    // 测试 limit=2&page=2
    const p2Res = await jsonRequest(
      env,
      "GET",
      `/api/users/${charlieRow.id}/pages?limit=2&page=2`,
      undefined,
      charlie
    )
    const p2 = (await p2Res.json()) as PagesResponse
    expect(p2.page).toBe(2)
    expect(p2.hasMore).toBe(true)
    expect(p2.pages).toHaveLength(2)

    // 测试 limit=2&page=3（最后一页）
    const p3Res = await jsonRequest(
      env,
      "GET",
      `/api/users/${charlieRow.id}/pages?limit=2&page=3`,
      undefined,
      charlie
    )
    const p3 = (await p3Res.json()) as PagesResponse
    expect(p3.page).toBe(3)
    expect(p3.hasMore).toBe(false)
    expect(p3.pages).toHaveLength(1)

    // 测试 offset 参数：offset=2 与 page=2 结果一致
    const offsetRes = await jsonRequest(
      env,
      "GET",
      `/api/users/${charlieRow.id}/pages?limit=2&offset=2`,
      undefined,
      charlie
    )
    const offsetBody = (await offsetRes.json()) as PagesResponse
    expect(offsetBody.pages.map((p) => p.id)).toEqual(p2.pages.map((p) => p.id))
  })

  it("空态：作者没有创建页面或查看者无权查看任何页面时，返回 200 空列表", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await userSession(env, admin, "david@example.com")
    const prefix = getTablePrefix(env)
    const davidRow = (await findUserByEmail(
      env.DB,
      prefix,
      "david@example.com"
    ))!

    const res = await jsonRequest(
      env,
      "GET",
      `/api/users/${davidRow.id}/pages`,
      undefined,
      admin
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as PagesResponse
    expect(body.total).toBe(0)
    expect(body.pages).toEqual([])
    expect(body.hasMore).toBe(false)
  })
})

describe("页面详情读接口补全 id 字段：createdById 与 updatedById", () => {
  it("GET /api/pages/:id 与创建/更新响应中包含 createdById 与 updatedById", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const prefix = getTablePrefix(env)
    const adminRow = (await findUserByEmail(
      env.DB,
      prefix,
      "admin@example.com"
    ))!

    // 创建页面
    const created = await createPage(env, admin, {
      title: "补全字段测试"
    })
    expect(created.createdBy).toBe(adminRow.id)
    expect(created.createdById).toBe(adminRow.id)
    expect(created.updatedBy).toBe(adminRow.id)
    expect(created.updatedById).toBe(adminRow.id)

    // GET /api/pages/:id
    const getRes = await jsonRequest(
      env,
      "GET",
      `/api/pages/${created.id}`,
      undefined,
      admin
    )
    expect(getRes.status).toBe(200)
    const detail = (await getRes.json()) as {
      id: number
      createdBy: number
      createdById: number
      updatedBy: number
      updatedById: number
    }
    expect(detail.createdBy).toBe(adminRow.id)
    expect(detail.createdById).toBe(adminRow.id)
    expect(detail.updatedBy).toBe(adminRow.id)
    expect(detail.updatedById).toBe(adminRow.id)
  })
})
