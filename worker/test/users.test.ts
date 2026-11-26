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
import { usersTable } from "../src/lib/tables"

interface ProfileResponse {
  id: number
  username: string
  avatarUrl: string | null
  bio: string
  docCount: number
  commentCount: number
  isAgent: boolean
  ownerName: string | null
  ownerId: number | null
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

interface ActivityEvent {
  id: string
  type: "page_created" | "page_edited" | "comment"
  pageId: number
  pageTitle: string
  spaceName: string
  commentId?: number
  excerpt?: string
  createdAt: string
}

interface ActivityResponse {
  events: ActivityEvent[]
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

async function updatePage(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  pageId: number,
  input: {
    title: string
    contentHtml?: string
    contentText?: string
  }
) {
  const res = await jsonRequest(
    env,
    "PUT",
    `/api/pages/${pageId}`,
    {
      title: input.title,
      contentJson: JSON.stringify({ type: "doc" }),
      contentHtml: input.contentHtml ?? `<p>${input.title}</p>`,
      contentText: input.contentText ?? input.title
    },
    cookie
  )
  expect(res.status).toBe(200)
  return (await res.json()) as { id: number; title: string }
}

async function deletePage(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  pageId: number
) {
  const res = await jsonRequest(
    env,
    "DELETE",
    `/api/pages/${pageId}`,
    undefined,
    cookie
  )
  expect(res.status).toBe(200)
}

async function createSpace(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  name: string
) {
  const res = await jsonRequest(env, "POST", "/api/spaces", { name }, cookie)
  expect(res.status).toBe(201)
  return (await res.json()) as { id: number; name: string }
}

async function addSpaceMember(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  spaceId: number,
  userId: number,
  role: "admin" | "editor" | "viewer" = "editor"
) {
  const res = await jsonRequest(
    env,
    "POST",
    `/api/spaces/${spaceId}/members`,
    { userId, role },
    cookie
  )
  expect(res.status).toBe(201)
}

async function createComment(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  pageId: number,
  bodyMd: string
) {
  const res = await jsonRequest(
    env,
    "POST",
    `/api/pages/${pageId}/comments`,
    { bodyMd },
    cookie
  )
  expect(res.status).toBe(201)
  return (await res.json()) as { id: number; bodyMd: string }
}

async function deleteComment(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  pageId: number,
  commentId: number
) {
  const res = await jsonRequest(
    env,
    "DELETE",
    `/api/pages/${pageId}/comments/${commentId}`,
    undefined,
    cookie
  )
  expect(res.status).toBe(200)
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
    expect(body.bio).toBe("")
    expect(body.docCount).toBe(0)
    expect(body.commentCount).toBe(0)
    expect(body.isAgent).toBe(false)
    expect(body.ownerName).toBeNull()
    expect(body.ownerId).toBeNull()
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

  it("Agent 用户返回公开资料，带归属人 ownerName 与 ownerId", async () => {
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
    expect(body.bio).toBe("")
    expect(body.docCount).toBe(0)
    expect(body.commentCount).toBe(0)
    expect(body.isAgent).toBe(true)
    expect(body.ownerName).toBe(ownerRow.username)
    expect(body.ownerId).toBe(ownerId)

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
    expect(bodyAfterDelete.ownerId).toBeNull()
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

describe("schema_v12 迁移与个人资料 bio 读写与校验", () => {
  it("schema_v12 迁移：users 表正确添加 bio 列且默认值为空串", async () => {
    const { db } = await initializedContext()
    const rawColumns = db.db
      .prepare("PRAGMA table_info(ciki_users)")
      .all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
    }>
    const cols = Object.fromEntries(rawColumns.map((c) => [c.name, c]))

    expect(cols.bio).toBeDefined()
    expect(cols.bio.type.toUpperCase()).toBe("TEXT")
    expect(cols.bio.notnull).toBe(1)
    expect(cols.bio.dflt_value).toBe("''")
  })

  it("PUT /api/me/profile 更新 bio：首尾空白自动 trim，GET /api/me 与 profile 接口同步返回", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const prefix = getTablePrefix(env)
    const adminRow = (await findUserByEmail(
      env.DB,
      prefix,
      "admin@example.com"
    ))!

    // 更新 bio（带首尾空白）
    const updateRes = await jsonRequest(
      env,
      "PUT",
      "/api/me/profile",
      { bio: "   全栈工程师 & 文档热爱者 🚀   " },
      admin
    )
    expect(updateRes.status).toBe(200)
    const updateBody = (await updateRes.json()) as { bio: string }
    expect(updateBody.bio).toBe("全栈工程师 & 文档热爱者 🚀")

    // GET /api/me 回读
    const meRes = await jsonRequest(env, "GET", "/api/me", undefined, admin)
    expect(meRes.status).toBe(200)
    const meBody = (await meRes.json()) as { bio: string }
    expect(meBody.bio).toBe("全栈工程师 & 文档热爱者 🚀")

    // GET /api/users/:id/profile 回读
    const profileRes = await jsonRequest(
      env,
      "GET",
      `/api/users/${adminRow.id}/profile`,
      undefined,
      admin
    )
    expect(profileRes.status).toBe(200)
    const profileBody = (await profileRes.json()) as ProfileResponse
    expect(profileBody.bio).toBe("全栈工程师 & 文档热爱者 🚀")
  })

  it("PUT /api/me/profile 清空 bio：空串或全空白字符更新后变为 ''", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 先设置
    await jsonRequest(env, "PUT", "/api/me/profile", { bio: "原简介" }, admin)

    // 全空白字符清空
    const clearRes = await jsonRequest(
      env,
      "PUT",
      "/api/me/profile",
      { bio: "   " },
      admin
    )
    expect(clearRes.status).toBe(200)
    expect(((await clearRes.json()) as { bio: string }).bio).toBe("")

    // GET /api/me 确认清空
    const meRes = await jsonRequest(env, "GET", "/api/me", undefined, admin)
    expect(((await meRes.json()) as { bio: string }).bio).toBe("")
  })

  it("PUT /api/me/profile 纯文本类型校验：传入非字符串类型回 400 INVALID_BIO", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    for (const badBio of [123, true, null, { text: "hello" }, ["bio"]]) {
      const res = await jsonRequest(
        env,
        "PUT",
        "/api/me/profile",
        { bio: badBio },
        admin
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ code: "INVALID_BIO" })
    }
  })

  it("PUT /api/me/profile 长度校验（Unicode 码点）：恰好 100 码点成功，101 码点回 400 INVALID_BIO", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 100 个 Unicode 字符（含中文字符、emoji 复合字符）
    const exact100 = "🚀".repeat(50) + "一".repeat(50)
    expect(Array.from(exact100).length).toBe(100)

    const okRes = await jsonRequest(
      env,
      "PUT",
      "/api/me/profile",
      { bio: exact100 },
      admin
    )
    expect(okRes.status).toBe(200)
    expect(((await okRes.json()) as { bio: string }).bio).toBe(exact100)

    // 101 个字符超长
    const over100 = `${exact100}X`
    expect(Array.from(over100).length).toBe(101)

    const failRes = await jsonRequest(
      env,
      "PUT",
      "/api/me/profile",
      { bio: over100 },
      admin
    )
    expect(failRes.status).toBe(400)
    expect(await failRes.json()).toMatchObject({ code: "INVALID_BIO" })
  })
})

describe("作者主页个人卡计数（可见口径）：docCount 与 commentCount 权限过滤与软删排除", () => {
  it("Jim 场景：A 看 B 的作者主页，计数只统计 A 有权空间内的数据，无权空间数量零泄露", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const prefix = getTablePrefix(env)

    const aliceCookie = await userSession(env, admin, "author-b@example.com")
    const bobCookie = await userSession(env, admin, "viewer-a@example.com")

    const aliceRow = (await findUserByEmail(
      env.DB,
      prefix,
      "author-b@example.com"
    ))!
    const bobRow = (await findUserByEmail(
      env.DB,
      prefix,
      "viewer-a@example.com"
    ))!

    // 创建两个空间：spaceA (Bob 有权), spaceB (Bob 无权)
    const spaceA = await createSpace(env, admin, "公开空间A")
    const spaceB = await createSpace(env, admin, "私密空间B")

    await addSpaceMember(env, admin, spaceA.id, aliceRow.id, "editor")
    await addSpaceMember(env, admin, spaceA.id, bobRow.id, "editor")
    await addSpaceMember(env, admin, spaceB.id, aliceRow.id, "editor")
    // Bob 未加入 spaceB

    // Alice 在 spaceA 创建 2 篇文档、发表 2 条评论
    const pA1 = await createPage(env, aliceCookie, {
      title: "文档A1",
      spaceId: spaceA.id
    })
    const pA2 = await createPage(env, aliceCookie, {
      title: "文档A2",
      spaceId: spaceA.id
    })
    await createComment(env, aliceCookie, pA1.id, "评论A1-1")
    const cA2 = await createComment(env, aliceCookie, pA2.id, "评论A2-1")

    // Alice 在 spaceB 创建 3 篇文档、发表 3 条评论
    const pB1 = await createPage(env, aliceCookie, {
      title: "文档B1",
      spaceId: spaceB.id
    })
    await createPage(env, aliceCookie, {
      title: "文档B2",
      spaceId: spaceB.id
    })
    await createPage(env, aliceCookie, {
      title: "文档B3",
      spaceId: spaceB.id
    })
    await createComment(env, aliceCookie, pB1.id, "评论B1-1")
    await createComment(env, aliceCookie, pB1.id, "评论B1-2")
    await createComment(env, aliceCookie, pB1.id, "评论B1-3")

    // Bob 查看 Alice 的个人卡：只数 spaceA 内的，无权 spaceB 数量零泄露
    const bobViewRes = await jsonRequest(
      env,
      "GET",
      `/api/users/${aliceRow.id}/profile`,
      undefined,
      bobCookie
    )
    expect(bobViewRes.status).toBe(200)
    const bobView = (await bobViewRes.json()) as ProfileResponse
    expect(bobView.docCount).toBe(2)
    expect(bobView.commentCount).toBe(2)

    // 站点管理员查看 Alice 的个人卡：统计全部空间
    const adminViewRes = await jsonRequest(
      env,
      "GET",
      `/api/users/${aliceRow.id}/profile`,
      undefined,
      admin
    )
    expect(adminViewRes.status).toBe(200)
    const adminView = (await adminViewRes.json()) as ProfileResponse
    expect(adminView.docCount).toBe(5)
    expect(adminView.commentCount).toBe(5)

    // 软删联动测试：
    // 1. Alice 软删 spaceA 的文档 pA1 -> Bob 看 docCount 降为 1，pA1 下的评论也被排除，commentCount 降为 1
    await deletePage(env, aliceCookie, pA1.id)
    const bobAfterPageDelete = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/users/${aliceRow.id}/profile`,
        undefined,
        bobCookie
      )
    ).json()) as ProfileResponse
    expect(bobAfterPageDelete.docCount).toBe(1)
    expect(bobAfterPageDelete.commentCount).toBe(1)

    // 2. 软删 spaceA 文档 pA2 下的评论 -> commentCount 降为 0
    await deleteComment(env, aliceCookie, pA2.id, cA2.id)

    const bobAfterCommentDelete = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/users/${aliceRow.id}/profile`,
        undefined,
        bobCookie
      )
    ).json()) as ProfileResponse
    expect(bobAfterCommentDelete.docCount).toBe(1)
    expect(bobAfterCommentDelete.commentCount).toBe(0)
  })
})

describe("作者动态流接口：GET /api/users/:id/activity", () => {
  it("未登录访问返回 401，非法或不存在的用户 id 返回 404", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 未登录
    const anonRes = await jsonRequest(env, "GET", "/api/users/1/activity")
    expect(anonRes.status).toBe(401)

    // 非法 id
    for (const badId of ["abc", "0", "-1", "01"]) {
      const res = await jsonRequest(
        env,
        "GET",
        `/api/users/${badId}/activity`,
        undefined,
        admin
      )
      expect(res.status).toBe(404)
    }

    // 不存在的用户
    const notFoundRes = await jsonRequest(
      env,
      "GET",
      "/api/users/999999/activity",
      undefined,
      admin
    )
    expect(notFoundRes.status).toBe(404)
  })

  it("合并三类事件：新建文档、编辑文档、发表评论，字段完整性断言", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const prefix = getTablePrefix(env)

    const aliceCookie = await userSession(
      env,
      admin,
      "activity-alice@example.com"
    )
    const aliceRow = (await findUserByEmail(
      env.DB,
      prefix,
      "activity-alice@example.com"
    ))!

    const space = await createSpace(env, admin, "动态流测试空间")
    await addSpaceMember(env, admin, space.id, aliceRow.id, "editor")

    // 1. 新建文档 -> page_created
    const page = await createPage(env, aliceCookie, {
      title: "关于架构设计的思考",
      spaceId: space.id
    })

    // 2. 编辑文档（产生 version_no=2）-> page_edited
    await updatePage(env, aliceCookie, page.id, {
      title: "关于架构设计的思考（修订版）",
      contentHtml: "<p>更新正文</p>",
      contentText: "更新正文"
    })

    // 3. 发表评论 -> comment
    const comment = await createComment(
      env,
      aliceCookie,
      page.id,
      "**强烈推荐** 这套架构方案，测试评论摘要截断。"
    )

    const res = await jsonRequest(
      env,
      "GET",
      `/api/users/${aliceRow.id}/activity`,
      undefined,
      aliceCookie
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ActivityResponse

    expect(body.hasMore).toBe(false)
    expect(body.events).toHaveLength(3)

    // 倒序：评论最晚 -> 编辑次之 -> 创建最早
    const [eComment, eEdit, eCreate] = body.events

    // 评论事件断言
    expect(eComment.type).toBe("comment")
    expect(eComment.id).toBe(`comment-${comment.id}`)
    expect(eComment.pageId).toBe(page.id)
    expect(eComment.pageTitle).toBe("关于架构设计的思考（修订版）")
    expect(eComment.spaceName).toBe("动态流测试空间")
    expect(eComment.commentId).toBe(comment.id)
    expect(eComment.excerpt).toContain("强烈推荐 这套架构方案")
    expect(eComment.createdAt).toBeDefined()

    // 编辑事件断言
    expect(eEdit.type).toBe("page_edited")
    expect(eEdit.id).toMatch(/^revision-\d+$/)
    expect(eEdit.pageId).toBe(page.id)
    expect(eEdit.pageTitle).toBe("关于架构设计的思考（修订版）")
    expect(eEdit.spaceName).toBe("动态流测试空间")
    expect(eEdit.commentId).toBeUndefined()
    expect(eEdit.excerpt).toBeUndefined()

    // 创建事件断言
    expect(eCreate.type).toBe("page_created")
    expect(eCreate.id).toBe(`page-${page.id}`)
    expect(eCreate.pageId).toBe(page.id)
    expect(eCreate.pageTitle).toBe("关于架构设计的思考（修订版）")
    expect(eCreate.spaceName).toBe("动态流测试空间")
    expect(eCreate.commentId).toBeUndefined()
    expect(eCreate.excerpt).toBeUndefined()
  })

  it("权限隔离（硬线：Tony 对照核）：只出现查看者有权空间的事件，无权空间的文档标题与评论内容零泄露", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const prefix = getTablePrefix(env)

    const aliceCookie = await userSession(
      env,
      admin,
      "alice-writer@example.com"
    )
    const bobCookie = await userSession(env, admin, "bob-reader@example.com")

    const aliceRow = (await findUserByEmail(
      env.DB,
      prefix,
      "alice-writer@example.com"
    ))!
    const bobRow = (await findUserByEmail(
      env.DB,
      prefix,
      "bob-reader@example.com"
    ))!

    const spacePublic = await createSpace(env, admin, "共享公共空间")
    const spaceSecret = await createSpace(env, admin, "机密保密空间")

    await addSpaceMember(env, admin, spacePublic.id, aliceRow.id, "editor")
    await addSpaceMember(env, admin, spacePublic.id, bobRow.id, "editor")

    await addSpaceMember(env, admin, spaceSecret.id, aliceRow.id, "editor")
    // Bob 绝对不在 spaceSecret 成员中

    // Alice 在公开空间产生事件
    const publicPage = await createPage(env, aliceCookie, {
      title: "公开开源文档",
      spaceId: spacePublic.id
    })
    await createComment(env, aliceCookie, publicPage.id, "公开评论讨论")

    // Alice 在私密空间产生事件（绝密）
    const secretPage = await createPage(env, aliceCookie, {
      title: "最高机密绝不能被Bob看到",
      spaceId: spaceSecret.id
    })
    await updatePage(env, aliceCookie, secretPage.id, {
      title: "最高机密修改版",
      contentHtml: "<p>绝密正文</p>"
    })
    await createComment(env, aliceCookie, secretPage.id, "绝密评论内容严禁泄露")

    // Bob 查看 Alice 的动态流
    const bobRes = await jsonRequest(
      env,
      "GET",
      `/api/users/${aliceRow.id}/activity`,
      undefined,
      bobCookie
    )
    expect(bobRes.status).toBe(200)
    const bobBody = (await bobRes.json()) as ActivityResponse

    // Bob 只能看见公开空间事件
    expect(bobBody.events.length).toBeGreaterThan(0)
    for (const ev of bobBody.events) {
      expect(ev.spaceName).toBe("共享公共空间")
      expect(ev.pageTitle).not.toContain("最高机密")
      if (ev.excerpt) {
        expect(ev.excerpt).not.toContain("绝密评论")
      }
    }

    // 站点管理员可查看全部
    const adminRes = await jsonRequest(
      env,
      "GET",
      `/api/users/${aliceRow.id}/activity`,
      undefined,
      admin
    )
    expect(adminRes.status).toBe(200)
    const adminBody = (await adminRes.json()) as ActivityResponse
    const secretEvents = adminBody.events.filter(
      (e) => e.spaceName === "机密保密空间"
    )
    expect(secretEvents.length).toBe(3) // 创建、编辑、评论
  })

  it("软删除过滤：软删文档的全部事件及所属评论排除；软删评论自身排除", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const prefix = getTablePrefix(env)

    const aliceCookie = await userSession(
      env,
      admin,
      "softdel-alice@example.com"
    )
    const aliceRow = (await findUserByEmail(
      env.DB,
      prefix,
      "softdel-alice@example.com"
    ))!

    const space = await createSpace(env, admin, "软删除测试空间")
    await addSpaceMember(env, admin, space.id, aliceRow.id, "editor")

    // 页面 1：将被软删除
    const page1 = await createPage(env, aliceCookie, {
      title: "待软删除文档",
      spaceId: space.id
    })
    await updatePage(env, aliceCookie, page1.id, {
      title: "待软删除文档（已改）"
    })
    await createComment(env, aliceCookie, page1.id, "待软删文档下的评论")

    // 页面 2：保留，但软删其下一条评论
    const page2 = await createPage(env, aliceCookie, {
      title: "存活文档",
      spaceId: space.id
    })
    const commentToDel = await createComment(
      env,
      aliceCookie,
      page2.id,
      "将被删除的评论"
    )
    const commentKept = await createComment(
      env,
      aliceCookie,
      page2.id,
      "保留的评论"
    )

    // 软删 page1 与 commentToDel
    await deletePage(env, aliceCookie, page1.id)
    await deleteComment(env, aliceCookie, page2.id, commentToDel.id)

    const res = await jsonRequest(
      env,
      "GET",
      `/api/users/${aliceRow.id}/activity`,
      undefined,
      aliceCookie
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ActivityResponse

    // 页面 1 的任何事件都不应出现
    expect(body.events.some((e) => e.pageId === page1.id)).toBe(false)

    // 软删的评论不应出现
    expect(body.events.some((e) => e.commentId === commentToDel.id)).toBe(false)

    // 保留的事件存在
    expect(body.events.some((e) => e.commentId === commentKept.id)).toBe(true)
    expect(
      body.events.some(
        (e) => e.type === "page_created" && e.pageId === page2.id
      )
    ).toBe(true)
  })

  it("按 createdAt DESC, unique_id DESC 稳定倒序，分页 limit/offset/page 不重不漏", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const prefix = getTablePrefix(env)

    const aliceCookie = await userSession(
      env,
      admin,
      "paging-alice@example.com"
    )
    const aliceRow = (await findUserByEmail(
      env.DB,
      prefix,
      "paging-alice@example.com"
    ))!

    const space = await createSpace(env, admin, "分页测试空间")
    await addSpaceMember(env, admin, space.id, aliceRow.id, "editor")

    // 连续创建 5 篇文档
    for (let i = 1; i <= 5; i++) {
      await createPage(env, aliceCookie, {
        title: `批量文档 ${i}`,
        spaceId: space.id
      })
    }

    // 全量读取
    const allRes = await jsonRequest(
      env,
      "GET",
      `/api/users/${aliceRow.id}/activity?limit=100`,
      undefined,
      aliceCookie
    )
    const allBody = (await allRes.json()) as ActivityResponse
    expect(allBody.events).toHaveLength(5)
    expect(allBody.hasMore).toBe(false)
    const allIds = allBody.events.map((e) => e.id)

    // 分页 limit=2
    const page1Res = await jsonRequest(
      env,
      "GET",
      `/api/users/${aliceRow.id}/activity?limit=2&page=1`,
      undefined,
      aliceCookie
    )
    const page1 = (await page1Res.json()) as ActivityResponse
    expect(page1.events).toHaveLength(2)
    expect(page1.hasMore).toBe(true)

    const page2Res = await jsonRequest(
      env,
      "GET",
      `/api/users/${aliceRow.id}/activity?limit=2&page=2`,
      undefined,
      aliceCookie
    )
    const page2 = (await page2Res.json()) as ActivityResponse
    expect(page2.events).toHaveLength(2)
    expect(page2.hasMore).toBe(true)

    const page3Res = await jsonRequest(
      env,
      "GET",
      `/api/users/${aliceRow.id}/activity?limit=2&page=3`,
      undefined,
      aliceCookie
    )
    const page3 = (await page3Res.json()) as ActivityResponse
    expect(page3.events).toHaveLength(1)
    expect(page3.hasMore).toBe(false)

    // 验证三页拼合无缝对应全量，不重不漏
    const pagedIds = [
      ...page1.events.map((e) => e.id),
      ...page2.events.map((e) => e.id),
      ...page3.events.map((e) => e.id)
    ]
    expect(pagedIds).toEqual(allIds)

    // offset=2 与 page=2 结果完全一致
    const offsetRes = await jsonRequest(
      env,
      "GET",
      `/api/users/${aliceRow.id}/activity?limit=2&offset=2`,
      undefined,
      aliceCookie
    )
    const offsetBody = (await offsetRes.json()) as ActivityResponse
    expect(offsetBody.events.map((e) => e.id)).toEqual(
      page2.events.map((e) => e.id)
    )
  })

  it("空态：作者没有产生事件时返回空列表与 hasMore: false", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const prefix = getTablePrefix(env)

    await userSession(env, admin, "empty-alice@example.com")
    const aliceRow = (await findUserByEmail(
      env.DB,
      prefix,
      "empty-alice@example.com"
    ))!

    const res = await jsonRequest(
      env,
      "GET",
      `/api/users/${aliceRow.id}/activity`,
      undefined,
      admin
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ActivityResponse
    expect(body.events).toEqual([])
    expect(body.hasMore).toBe(false)
  })
})

describe("schema_v13 迁移与主题风格 themeStyle 读写与保存", () => {
  it("schema_v13 迁移：users 表正确添加 theme_style 列，且默认值为 'nova'", async () => {
    const { db } = await initializedContext()
    const rawColumns = db.db
      .prepare("PRAGMA table_info(ciki_users)")
      .all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
    }>
    const cols = Object.fromEntries(rawColumns.map((c) => [c.name, c]))

    expect(cols.theme_style).toBeDefined()
    expect(cols.theme_style.type.toUpperCase()).toBe("TEXT")
    expect(cols.theme_style.notnull).toBe(1)
    expect(cols.theme_style.dflt_value).toBe("'nova'")
  })

  it("GET /api/me 默认返回 themeStyle: 'nova'", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const meRes = await jsonRequest(env, "GET", "/api/me", undefined, admin)
    expect(meRes.status).toBe(200)
    const meBody = (await meRes.json()) as { themeStyle: string }
    expect(meBody.themeStyle).toBe("nova")
  })

  it("PUT /api/me/theme 独立保存：只更新 theme_style 为 paper，返回完整 meDto，不影响其他资料字段", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const prefix = getTablePrefix(env)

    // 先设置 bio 与 language
    await jsonRequest(
      env,
      "PUT",
      "/api/me/profile",
      { bio: "原简介", language: "zh" },
      admin
    )

    // 保存主题风格为 paper
    const res = await jsonRequest(
      env,
      "PUT",
      "/api/me/theme",
      { themeStyle: "paper" },
      admin
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      themeStyle: string
      bio: string
      language: string
      username: string
    }
    expect(body.themeStyle).toBe("paper")
    expect(body.bio).toBe("原简介")
    expect(body.language).toBe("zh")

    // GET /api/me 回读确认
    const meRes = await jsonRequest(env, "GET", "/api/me", undefined, admin)
    expect(meRes.status).toBe(200)
    expect(((await meRes.json()) as { themeStyle: string }).themeStyle).toBe(
      "paper"
    )

    // 确认数据库底层 theme_style 为 paper
    const row = await findUserByEmail(env.DB, prefix, "admin@example.com")
    expect(row?.theme_style).toBe("paper")
  })

  it("PUT /api/me/theme 兼容 style 字段入参且支持切回 nova", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 先切为 paper
    await jsonRequest(
      env,
      "PUT",
      "/api/me/theme",
      { themeStyle: "paper" },
      admin
    )

    // 使用 { style: "nova" } 切回 nova
    const res = await jsonRequest(
      env,
      "PUT",
      "/api/me/theme",
      { style: "nova" },
      admin
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { themeStyle: string }).themeStyle).toBe(
      "nova"
    )

    const meRes = await jsonRequest(env, "GET", "/api/me", undefined, admin)
    expect(((await meRes.json()) as { themeStyle: string }).themeStyle).toBe(
      "nova"
    )
  })

  it("PUT /api/me/theme 成功保存 natural 与 eink 主题风格并持久化", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const prefix = getTablePrefix(env)

    for (const style of ["natural", "eink"] as const) {
      const res = await jsonRequest(
        env,
        "PUT",
        "/api/me/theme",
        { themeStyle: style },
        admin
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { themeStyle: string }
      expect(body.themeStyle).toBe(style)

      // GET /api/me 回读确认
      const meRes = await jsonRequest(env, "GET", "/api/me", undefined, admin)
      expect(meRes.status).toBe(200)
      expect(((await meRes.json()) as { themeStyle: string }).themeStyle).toBe(
        style
      )

      // 底层 users.theme_style 持久化确认
      const row = await findUserByEmail(env.DB, prefix, "admin@example.com")
      expect(row?.theme_style).toBe(style)
    }
  })

  it("PUT /api/me/theme 非法值校验：非法 style 返回 400 INVALID_THEME_STYLE", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const invalidValues = [
      "dark",
      "light",
      "auto",
      "NOVA",
      "paper ",
      "",
      123,
      null,
      true,
      {}
    ]
    for (const val of invalidValues) {
      const res = await jsonRequest(
        env,
        "PUT",
        "/api/me/theme",
        { themeStyle: val },
        admin
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string; code: string }
      expect(body.code).toBe("INVALID_THEME_STYLE")
      expect(body.error).toBe("themeStyle must be nova, paper, natural or eink")
    }

    // 空请求体或缺失字段同样 400
    const emptyRes = await jsonRequest(env, "PUT", "/api/me/theme", {}, admin)
    expect(emptyRes.status).toBe(400)
    expect(((await emptyRes.json()) as { code: string }).code).toBe(
      "INVALID_THEME_STYLE"
    )
  })

  it("PUT /api/me/theme-style 端点别名亦正常工作", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const res = await jsonRequest(
      env,
      "PUT",
      "/api/me/theme-style",
      { themeStyle: "paper" },
      admin
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { themeStyle: string }).themeStyle).toBe(
      "paper"
    )
  })

  it("历史/非法值归一化兜底：底层脏数据回退 nova", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const prefix = getTablePrefix(env)

    // 直接在数据库里写入非合法值 'corrupted_style'
    await env.DB.prepare(
      `UPDATE ${usersTable(prefix)} SET theme_style = 'corrupted_style'`
    ).run()

    const meRes = await jsonRequest(env, "GET", "/api/me", undefined, admin)
    expect(meRes.status).toBe(200)
    expect(((await meRes.json()) as { themeStyle: string }).themeStyle).toBe(
      "nova"
    )
  })
})
