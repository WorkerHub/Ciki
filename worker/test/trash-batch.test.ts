import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  userSession
} from "./support/app"

interface SpaceDto {
  id: number
  name: string
  myRole: "admin" | "editor" | "viewer"
  isDefault: boolean
}

interface PageDto {
  id: number
  spaceId: number
  parentId: number | null
  title: string
}

interface TrashItemDto {
  id: number
  parentId: number | null
  title: string
  deletedAt: string
  updatedAt: string
  spaceId: number
  spaceName: string
  createdAt: string
  childCount: number
}

interface BatchResultDto {
  results: Array<{
    id: number
    ok: boolean
    error?: string
    code?: string
  }>
}

async function fetchMeId(
  env: Parameters<typeof adminSession>[0],
  cookie: string
): Promise<number> {
  const response = await jsonRequest(env, "GET", "/api/me", undefined, cookie)
  const me = (await response.json()) as { id: number }
  return me.id
}

async function createSpaceHelper(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  name: string
): Promise<SpaceDto> {
  const response = await jsonRequest(
    env,
    "POST",
    "/api/spaces",
    { name },
    cookie
  )
  expect(response.status).toBe(201)
  return (await response.json()) as SpaceDto
}

async function addSpaceMember(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  spaceId: number,
  userId: number,
  role: "admin" | "editor" | "viewer"
): Promise<void> {
  const response = await jsonRequest(
    env,
    "POST",
    `/api/spaces/${spaceId}/members`,
    { userId, role },
    cookie
  )
  expect(response.status).toBe(201)
}

async function createPageHelper(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  title: string,
  spaceId?: number,
  parentId: number | null = null
): Promise<PageDto> {
  const payload: Record<string, unknown> = {
    title,
    parentId,
    contentJson: JSON.stringify({ type: "doc" }),
    contentHtml: `<p>${title}</p>`,
    contentText: title
  }
  if (spaceId !== undefined) {
    payload.spaceId = spaceId
  }
  const response = await jsonRequest(env, "POST", "/api/pages", payload, cookie)
  expect(response.status).toBe(201)
  return (await response.json()) as PageDto
}

describe("回收站跨空间汇总与批量处理接口", () => {
  it("默认汇总全部可访问空间，字段完整且子树计数准确", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const techSpace = await createSpaceHelper(env, admin, "研发空间")
    const designSpace = await createSpaceHelper(env, admin, "设计空间")

    const techParent = await createPageHelper(
      env,
      admin,
      "架构设计",
      techSpace.id
    )
    const techChild = await createPageHelper(
      env,
      admin,
      "存储模块",
      techSpace.id,
      techParent.id
    )
    await createPageHelper(env, admin, "索引细节", techSpace.id, techChild.id)

    const designPage = await createPageHelper(
      env,
      admin,
      "首页稿",
      designSpace.id
    )

    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${techParent.id}`,
      undefined,
      admin
    )
    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${designPage.id}`,
      undefined,
      admin
    )

    const allTrashResponse = await jsonRequest(
      env,
      "GET",
      "/api/pages/trash",
      undefined,
      admin
    )
    expect(allTrashResponse.status).toBe(200)
    const allTrash = (await allTrashResponse.json()) as TrashItemDto[]

    const techItem = allTrash.find((item) => item.id === techParent.id)
    expect(techItem).toBeDefined()
    expect(techItem?.spaceId).toBe(techSpace.id)
    expect(techItem?.spaceName).toBe("研发空间")
    expect(techItem?.title).toBe("架构设计")
    expect(techItem?.childCount).toBe(2)
    expect(typeof techItem?.createdAt).toBe("string")
    expect(typeof techItem?.deletedAt).toBe("string")
    expect(typeof techItem?.updatedAt).toBe("string")

    const designItem = allTrash.find((item) => item.id === designPage.id)
    expect(designItem).toBeDefined()
    expect(designItem?.spaceId).toBe(designSpace.id)
    expect(designItem?.spaceName).toBe("设计空间")
    expect(designItem?.title).toBe("首页稿")
    expect(designItem?.childCount).toBe(0)

    const filteredResponse = await jsonRequest(
      env,
      "GET",
      `/api/pages/trash?spaceId=${techSpace.id}`,
      undefined,
      admin
    )
    expect(filteredResponse.status).toBe(200)
    const filteredTrash = (await filteredResponse.json()) as TrashItemDto[]
    expect(filteredTrash.map((item) => item.id)).toEqual([techParent.id])

    const badSpace = await jsonRequest(
      env,
      "GET",
      "/api/pages/trash?spaceId=abc",
      undefined,
      admin
    )
    expect(badSpace.status).toBe(400)
  })

  it("普通用户只汇总自己是成员的空间，未加入空间不泄露", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const memberUser = await userSession(env, admin, "member@example.com")
    const memberUserId = await fetchMeId(env, memberUser)

    const joinedSpace = await createSpaceHelper(env, admin, "成员可见空间")
    const secretSpace = await createSpaceHelper(env, admin, "保密空间")

    await addSpaceMember(env, admin, joinedSpace.id, memberUserId, "viewer")

    const visiblePage = await createPageHelper(
      env,
      admin,
      "成员公告",
      joinedSpace.id
    )
    const secretPage = await createPageHelper(
      env,
      admin,
      "保密草案",
      secretSpace.id
    )

    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${visiblePage.id}`,
      undefined,
      admin
    )
    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${secretPage.id}`,
      undefined,
      admin
    )

    const memberTrashResponse = await jsonRequest(
      env,
      "GET",
      "/api/pages/trash",
      undefined,
      memberUser
    )
    expect(memberTrashResponse.status).toBe(200)
    const memberTrash = (await memberTrashResponse.json()) as TrashItemDto[]

    expect(memberTrash.some((item) => item.id === visiblePage.id)).toBe(true)
    expect(memberTrash.some((item) => item.id === secretPage.id)).toBe(false)

    const forbiddenSpaceResponse = await jsonRequest(
      env,
      "GET",
      `/api/pages/trash?spaceId=${secretSpace.id}`,
      undefined,
      memberUser
    )
    expect(forbiddenSpaceResponse.status).toBe(404)
  })

  it("批量恢复：成功恢复整棵子树并重建索引，逐项返回成败", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const viewer = await userSession(env, admin, "viewer_restore@example.com")
    const viewerId = await fetchMeId(env, viewer)

    const space = await createSpaceHelper(env, admin, "恢复测试空间")
    await addSpaceMember(env, admin, space.id, viewerId, "viewer")

    const parentA = await createPageHelper(env, admin, "父页A", space.id)
    const childA = await createPageHelper(
      env,
      admin,
      "子页A",
      space.id,
      parentA.id
    )
    const parentB = await createPageHelper(env, admin, "父页B", space.id)

    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${parentA.id}`,
      undefined,
      admin
    )
    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${parentB.id}`,
      undefined,
      admin
    )

    const viewerBatch = await jsonRequest(
      env,
      "POST",
      "/api/pages/trash/batch",
      { action: "restore", ids: [parentA.id] },
      viewer
    )
    expect(viewerBatch.status).toBe(200)
    const viewerResults = (await viewerBatch.json()) as BatchResultDto
    expect(viewerResults.results).toEqual([
      { id: parentA.id, ok: false, error: "Forbidden", code: "FORBIDDEN" }
    ])

    const adminBatch = await jsonRequest(
      env,
      "POST",
      "/api/pages/trash/batch",
      {
        action: "restore",
        ids: [parentA.id, 999999, parentB.id]
      },
      admin
    )
    expect(adminBatch.status).toBe(200)
    const adminResults = (await adminBatch.json()) as BatchResultDto
    expect(adminResults.results).toEqual([
      { id: parentA.id, ok: true },
      { id: 999999, ok: false, error: "Page not found" },
      { id: parentB.id, ok: true }
    ])

    const childDetail = await jsonRequest(
      env,
      "GET",
      `/api/pages/${childA.id}`,
      undefined,
      admin
    )
    expect(childDetail.status).toBe(200)
  })

  it("批量恢复：父页未恢复时子页独立恢复返回 PARENT_DELETED", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const space = await createSpaceHelper(env, admin, "父未恢复空间")
    const parent = await createPageHelper(env, admin, "主页", space.id)
    const child = await createPageHelper(
      env,
      admin,
      "分录",
      space.id,
      parent.id
    )

    await jsonRequest(env, "DELETE", `/api/pages/${child.id}`, undefined, admin)
    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${parent.id}`,
      undefined,
      admin
    )

    const batchResponse = await jsonRequest(
      env,
      "POST",
      "/api/pages/trash/batch",
      { action: "restore", ids: [child.id] },
      admin
    )
    expect(batchResponse.status).toBe(200)
    const body = (await batchResponse.json()) as BatchResultDto
    expect(body.results).toEqual([
      {
        id: child.id,
        ok: false,
        error: "Restore the parent page first",
        code: "PARENT_DELETED"
      }
    ])
  })

  it("批量彻底删除：彻底清除子树与历史，验证 PAGE_NOT_DELETED 与只读权限", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const viewer = await userSession(env, admin, "viewer_purge@example.com")
    const viewerId = await fetchMeId(env, viewer)

    const space = await createSpaceHelper(env, admin, "彻删测试空间")
    await addSpaceMember(env, admin, space.id, viewerId, "viewer")

    const pageA = await createPageHelper(env, admin, "彻删页A", space.id)
    const childA = await createPageHelper(
      env,
      admin,
      "彻删子页A",
      space.id,
      pageA.id
    )
    const activePage = await createPageHelper(env, admin, "未删页", space.id)

    await jsonRequest(env, "DELETE", `/api/pages/${pageA.id}`, undefined, admin)

    const viewerPurge = await jsonRequest(
      env,
      "POST",
      "/api/pages/trash/batch",
      { action: "purge", ids: [pageA.id] },
      viewer
    )
    expect(viewerPurge.status).toBe(200)
    const viewerBody = (await viewerPurge.json()) as BatchResultDto
    expect(viewerBody.results).toEqual([
      { id: pageA.id, ok: false, error: "Forbidden", code: "FORBIDDEN" }
    ])

    const adminPurge = await jsonRequest(
      env,
      "POST",
      "/api/pages/trash/batch",
      { action: "purge", ids: [pageA.id, activePage.id, 888888] },
      admin
    )
    expect(adminPurge.status).toBe(200)
    const adminBody = (await adminPurge.json()) as BatchResultDto
    expect(adminBody.results).toEqual([
      { id: pageA.id, ok: true },
      {
        id: activePage.id,
        ok: false,
        error: "Page is not in trash",
        code: "PAGE_NOT_DELETED"
      },
      { id: 888888, ok: false, error: "Page not found" }
    ])

    const pageCount = db.db
      .prepare("SELECT COUNT(*) AS count FROM ciki_pages WHERE id IN (?, ?)")
      .get(pageA.id, childA.id) as { count: number }
    expect(pageCount.count).toBe(0)
  })

  it("批量接口参数非法校验", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const badAction = await jsonRequest(
      env,
      "POST",
      "/api/pages/trash/batch",
      { action: "unknown", ids: [1] },
      admin
    )
    expect(badAction.status).toBe(400)

    const missingIds = await jsonRequest(
      env,
      "POST",
      "/api/pages/trash/batch",
      { action: "restore" },
      admin
    )
    expect(missingIds.status).toBe(400)

    const emptyBatch = await jsonRequest(
      env,
      "POST",
      "/api/pages/trash/batch",
      { action: "restore", ids: [] },
      admin
    )
    expect(emptyBatch.status).toBe(200)
    expect(await emptyBatch.json()).toEqual({ results: [] })
  })
})
