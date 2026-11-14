import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  userSession
} from "./support/app"

interface SpaceDto {
  id: string
  slug: string
  name: string
  description: string
  myRole: "admin" | "editor" | "viewer"
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

interface MemberDto {
  userId: string
  username: string
  publicId: string
  email: string
  role: "admin" | "editor" | "viewer"
  createdAt: string
}

async function listSpaces(
  env: Parameters<typeof adminSession>[0],
  cookie: string
): Promise<SpaceDto[]> {
  const res = await jsonRequest(env, "GET", "/api/spaces", undefined, cookie)
  expect(res.status).toBe(200)
  return (await res.json()) as SpaceDto[]
}

async function createSpace(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  name: string,
  description = ""
): Promise<SpaceDto> {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/spaces",
    { name, description },
    cookie
  )
  expect(res.status).toBe(201)
  return (await res.json()) as SpaceDto
}

async function defaultSpace(
  env: Parameters<typeof adminSession>[0],
  cookie: string
): Promise<SpaceDto> {
  const space = (await listSpaces(env, cookie)).find((row) => row.isDefault)
  if (!space) throw new Error("default space missing")
  return space
}

async function meId(
  env: Parameters<typeof adminSession>[0],
  cookie: string
): Promise<string> {
  const me = (await (
    await jsonRequest(env, "GET", "/api/me", undefined, cookie)
  ).json()) as { id: string }
  return me.id
}

async function createPage(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  title: string,
  spaceId?: string
): Promise<{ id: string; spaceId: string }> {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/pages",
    {
      title,
      parentId: null,
      spaceId,
      contentJson: JSON.stringify({ type: "doc" }),
      contentHtml: `<p>${title}</p>`,
      contentText: title
    },
    cookie
  )
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string; spaceId: string }
}

describe("空间：创建、可见性与信息维护", () => {
  it("任何登录用户可建空间并成为 admin；默认空间在前，非成员看不到", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const alice = await userSession(env, admin, "alice@example.com")
    const bob = await userSession(env, admin, "bob@example.com")

    const space = await createSpace(env, alice, "研发空间", "内部资料")
    expect(space.myRole).toBe("admin")
    expect(space.isDefault).toBe(false)

    const aliceList = await listSpaces(env, alice)
    expect(aliceList.map((row) => row.id)).toEqual([
      (await defaultSpace(env, alice)).id,
      space.id
    ])
    expect(aliceList[0].myRole).toBe("editor")
    expect(aliceList[1].myRole).toBe("admin")

    const bobList = await listSpaces(env, bob)
    expect(bobList.map((row) => row.id)).toEqual([
      (await defaultSpace(env, bob)).id
    ])

    const detailDenied = await jsonRequest(
      env,
      "GET",
      `/api/spaces/${space.id}`,
      undefined,
      bob
    )
    expect(detailDenied.status).toBe(404)

    const renamed = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${space.id}`,
      { name: "研发中心", description: "新的描述" },
      alice
    )
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({
      name: "研发中心",
      description: "新的描述"
    })

    // 浏览器 textarea 常提交 CRLF：统一归一成 LF 后接受。
    const crlf = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${space.id}`,
      { description: "第一行\r\n第二行" },
      alice
    )
    expect(crlf.status).toBe(200)
    expect(await crlf.json()).toMatchObject({ description: "第一行\n第二行" })

    const invalidName = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${space.id}`,
      { name: "   " },
      alice
    )
    expect(invalidName.status).toBe(400)
    expect(await invalidName.json()).toMatchObject({
      code: "INVALID_SPACE_NAME"
    })

    const noop = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${space.id}`,
      {},
      alice
    )
    expect(noop.status).toBe(400)
  })
})

describe("空间：成员管理与最后一名 admin", () => {
  it("空间 admin 可添加/改角色/移除成员；editor 与 viewer 不可管理", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const owner = await userSession(env, admin, "owner@example.com")
    const target = await userSession(env, admin, "target@example.com")
    const outsider = await userSession(env, admin, "outsider@example.com")
    const space = await createSpace(env, owner, "项目空间")

    const targetId = await meId(env, target)
    const added = await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space.id}/members`,
      { userId: targetId, role: "viewer" },
      owner
    )
    expect(added.status).toBe(201)
    expect(await added.json()).toMatchObject({
      userId: targetId,
      email: "target@example.com",
      role: "viewer"
    })

    const duplicate = await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space.id}/members`,
      { userId: targetId, role: "viewer" },
      owner
    )
    expect(duplicate.status).toBe(409)

    const members = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/spaces/${space.id}/members`,
        undefined,
        owner
      )
    ).json()) as MemberDto[]
    expect(members.map((row) => [row.email, row.role])).toEqual([
      ["owner@example.com", "admin"],
      ["target@example.com", "viewer"]
    ])

    const promoted = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${space.id}/members/${targetId}`,
      { role: "editor" },
      owner
    )
    expect(promoted.status).toBe(200)
    expect(await promoted.json()).toMatchObject({ role: "editor" })

    // editor 不能管理成员，也不能改空间信息。
    const editorDenied = await jsonRequest(
      env,
      "GET",
      `/api/spaces/${space.id}/members`,
      undefined,
      target
    )
    expect(editorDenied.status).toBe(403)
    const editorPut = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${space.id}`,
      { name: "editor 改空间" },
      target
    )
    expect(editorPut.status).toBe(403)

    // 候选：排除已在空间的成员，支持按邮箱搜索。
    const candidates = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/spaces/${space.id}/member-candidates?q=outsider`,
        undefined,
        owner
      )
    ).json()) as Array<{ userId: string; email: string }>
    expect(candidates.map((row) => row.email)).toEqual(["outsider@example.com"])
    expect(candidates[0].userId).toBe(await meId(env, outsider))

    const removed = await jsonRequest(
      env,
      "DELETE",
      `/api/spaces/${space.id}/members/${targetId}`,
      undefined,
      owner
    )
    expect(removed.status).toBe(200)
    const after = await jsonRequest(
      env,
      "GET",
      `/api/spaces/${space.id}`,
      undefined,
      target
    )
    expect(after.status).toBe(404)
  })

  it("最后一名空间 admin 不能被降级或移除", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const owner = await userSession(env, admin, "solo@example.com")
    const space = await createSpace(env, owner, "单人空间")
    const ownerId = await meId(env, owner)

    const demote = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${space.id}/members/${ownerId}`,
      { role: "viewer" },
      owner
    )
    expect(demote.status).toBe(409)
    expect(await demote.json()).toMatchObject({ code: "LAST_SPACE_ADMIN" })

    const remove = await jsonRequest(
      env,
      "DELETE",
      `/api/spaces/${space.id}/members/${ownerId}`,
      undefined,
      owner
    )
    expect(remove.status).toBe(409)
    expect(await remove.json()).toMatchObject({ code: "LAST_SPACE_ADMIN" })
  })
})

describe("空间：删除守卫与管理面总览", () => {
  it("默认空间不可删；有页面（含回收站）不可删，清空后可删", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const space = await createSpace(env, admin, "待删空间")
    const fallback = await defaultSpace(env, admin)

    const defaultDelete = await jsonRequest(
      env,
      "DELETE",
      `/api/spaces/${fallback.id}`,
      undefined,
      admin
    )
    expect(defaultDelete.status).toBe(409)
    expect(await defaultDelete.json()).toMatchObject({
      code: "SPACE_DEFAULT_PROTECTED"
    })

    const page = await createPage(env, admin, "占位页", space.id)
    expect(page.spaceId).toBe(space.id)

    const blocked = await jsonRequest(
      env,
      "DELETE",
      `/api/spaces/${space.id}`,
      undefined,
      admin
    )
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({ code: "SPACE_NOT_EMPTY" })

    // 软删仍在回收站 → 仍算有页面。
    const trashed = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}`,
      undefined,
      admin
    )
    expect(trashed.status).toBe(200)
    const stillBlocked = await jsonRequest(
      env,
      "DELETE",
      `/api/spaces/${space.id}`,
      undefined,
      admin
    )
    expect(stillBlocked.status).toBe(409)

    const purged = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/permanent`,
      undefined,
      admin
    )
    expect(purged.status).toBe(200)

    const deleted = await jsonRequest(
      env,
      "DELETE",
      `/api/spaces/${space.id}`,
      undefined,
      admin
    )
    expect(deleted.status).toBe(200)
    const gone = await jsonRequest(
      env,
      "GET",
      `/api/spaces/${space.id}`,
      undefined,
      admin
    )
    expect(gone.status).toBe(404)
  })

  it("系统管理面空间总览：站点管理员可见计数，普通用户 403", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)
    const space = await createSpace(env, admin, "统计空间")
    await createPage(env, admin, "统计页", space.id)
    const trashedPage = await createPage(env, admin, "统计回收页", space.id)
    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${trashedPage.id}`,
      undefined,
      admin
    )

    const res = await jsonRequest(
      env,
      "GET",
      "/api/admin/spaces",
      undefined,
      admin
    )
    expect(res.status).toBe(200)
    const overview = (await res.json()) as Array<{
      id: string
      slug: string
      isDefault: boolean
      pageCount: number
      trashedPageCount: number
      memberCount: number
    }>
    const target = overview.find((row) => row.id === space.id)
    expect(target).toMatchObject({
      // 与 GET /api/spaces 同口径：系统管理要能拼出 /s/<slug>/settings 入口。
      slug: space.slug,
      isDefault: false,
      pageCount: 1,
      trashedPageCount: 1,
      memberCount: 1
    })
    expect(overview.find((row) => row.isDefault)?.isDefault).toBe(true)

    const denied = await jsonRequest(
      env,
      "GET",
      "/api/admin/spaces",
      undefined,
      user
    )
    expect(denied.status).toBe(403)
  })
})
