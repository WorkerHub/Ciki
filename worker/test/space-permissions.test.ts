import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  userSession
} from "./support/app"

interface SpaceDto {
  id: string
  name: string
  myRole: "admin" | "editor" | "viewer"
  isDefault: boolean
}

interface PageDto {
  id: string
  spaceId: string
  title: string
}

interface SearchResult {
  results: Array<{
    pageId: string
    title: string
    snippet: string
    spaceId: string
    spaceName: string
  }>
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
  name: string
): Promise<SpaceDto> {
  const res = await jsonRequest(env, "POST", "/api/spaces", { name }, cookie)
  expect(res.status).toBe(201)
  return (await res.json()) as SpaceDto
}

async function createPage(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  title: string,
  spaceId: string,
  contentText = title,
  parentId: string | null = null
): Promise<PageDto> {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/pages",
    {
      title,
      parentId,
      spaceId,
      contentJson: JSON.stringify({ type: "doc" }),
      contentHtml: `<p>${contentText}</p>`,
      contentText
    },
    cookie
  )
  expect(res.status).toBe(201)
  return (await res.json()) as PageDto
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

async function search(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  query: string
): Promise<SearchResult> {
  const res = await jsonRequest(
    env,
    "GET",
    `/api/search?q=${encodeURIComponent(query)}`,
    undefined,
    cookie
  )
  expect(res.status).toBe(200)
  return (await res.json()) as SearchResult
}

async function scenario() {
  const { env } = await initializedContext()
  const admin = await adminSession(env)
  const alice = await userSession(env, admin, "alice@example.com")
  const bob = await userSession(env, admin, "bob@example.com")
  const viewer = await userSession(env, admin, "viewer@example.com")
  const editor = await userSession(env, admin, "editor@example.com")

  const defaultSpace = (await listSpaces(env, admin)).find(
    (row) => row.isDefault
  )
  if (!defaultSpace) throw new Error("default space missing")

  const space = await createSpace(env, admin, "机密空间")

  for (const [cookie, role] of [
    [viewer, "viewer"],
    [editor, "editor"]
  ] as const) {
    const res = await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space.id}/members`,
      { userId: await meId(env, cookie), role },
      admin
    )
    expect(res.status).toBe(201)
  }

  const page = await createPage(
    env,
    admin,
    "机密页",
    space.id,
    "机密词只在机密空间出现"
  )
  const defaultPage = await createPage(
    env,
    admin,
    "默认页",
    defaultSpace.id,
    "默认空间的正文"
  )

  return {
    env,
    admin,
    alice,
    bob,
    viewer,
    editor,
    space,
    defaultSpace,
    page,
    defaultPage
  }
}

describe("空间权限：非成员隔离", () => {
  it("空间列表、树、直链、回收站、搜索都不出现非成员空间", async () => {
    const { env, bob, space, page } = await scenario()

    expect((await listSpaces(env, bob)).map((row) => row.id)).not.toContain(
      space.id
    )

    const tree = await jsonRequest(
      env,
      "GET",
      `/api/pages?spaceId=${space.id}`,
      undefined,
      bob
    )
    expect(tree.status).toBe(404)

    for (const path of [
      `/api/pages/${page.id}`,
      `/api/pages/${page.id}/revisions`,
      `/api/pages/trash?spaceId=${space.id}`,
      `/api/spaces/${space.id}`,
      `/api/spaces/${space.id}/members`
    ]) {
      const res = await jsonRequest(env, "GET", path, undefined, bob)
      expect(res.status, path).toBe(404)
    }

    const write = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      {
        title: "越权改",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>x</p>",
        contentText: "x"
      },
      bob
    )
    expect(write.status).toBe(404)

    const removed = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}`,
      undefined,
      bob
    )
    expect(removed.status).toBe(404)

    // 用不可见页面当父页的探测：存在与不存在都只能得到 404。
    const probeCreate = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        title: "探测父页",
        spaceId: (await listSpaces(env, bob)).find((row) => row.isDefault)?.id,
        parentId: page.id,
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>x</p>",
        contentText: "x"
      },
      bob
    )
    expect(probeCreate.status).toBe(404)

    const bobPage = await createPage(
      env,
      bob,
      "bob 的默认页",
      (await listSpaces(env, bob)).find((row) => row.isDefault)?.id ?? ""
    )
    const probeMove = await jsonRequest(
      env,
      "POST",
      `/api/pages/${bobPage.id}/move`,
      { parentId: page.id },
      bob
    )
    expect(probeMove.status).toBe(404)

    const result = await search(env, bob, "机密词")
    expect(result.results).toEqual([])
    expect(JSON.stringify(result)).not.toContain("机密页")
  })
})

describe("空间权限：viewer 只读", () => {
  it("可读树/详情/搜索，所有写接口与成员接口被拒", async () => {
    const { env, admin, viewer, space, page } = await scenario()

    const spaces = await listSpaces(env, viewer)
    expect(spaces.find((row) => row.id === space.id)?.myRole).toBe("viewer")

    const tree = await jsonRequest(
      env,
      "GET",
      `/api/pages?spaceId=${space.id}`,
      undefined,
      viewer
    )
    expect(tree.status).toBe(200)
    const nodes = (await tree.json()) as Array<{ id: string }>
    expect(nodes.map((row) => row.id)).toEqual([page.id])

    const detail = await jsonRequest(
      env,
      "GET",
      `/api/pages/${page.id}`,
      undefined,
      viewer
    )
    expect(detail.status).toBe(200)

    const result = await search(env, viewer, "机密词")
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({
      pageId: page.id,
      spaceId: space.id,
      spaceName: "机密空间"
    })

    const create = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        title: "viewer 新建",
        spaceId: space.id,
        parentId: null,
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>x</p>",
        contentText: "x"
      },
      viewer
    )
    expect(create.status).toBe(403)

    const update = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      {
        title: "viewer 改",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>x</p>",
        contentText: "x"
      },
      viewer
    )
    expect(update.status).toBe(403)

    const move = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/move`,
      { parentId: null },
      viewer
    )
    expect(move.status).toBe(403)

    const remove = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}`,
      undefined,
      viewer
    )
    expect(remove.status).toBe(403)

    const revisions = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${page.id}/revisions`,
        undefined,
        viewer
      )
    ).json()) as Array<{ id: string }>
    const rollback = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/revisions/${revisions[0].id}/restore`,
      undefined,
      viewer
    )
    expect(rollback.status).toBe(403)

    for (const [method, path, body] of [
      ["GET", `/api/spaces/${space.id}/members`, undefined],
      [
        "POST",
        `/api/spaces/${space.id}/members`,
        { userId: "x", role: "viewer" }
      ],
      ["PUT", `/api/spaces/${space.id}`, { name: "viewer 改空间" }],
      ["DELETE", `/api/spaces/${space.id}`, undefined]
    ] as const) {
      const res = await jsonRequest(env, method, path, body, viewer)
      expect(res.status, `${method} ${path}`).toBe(403)
    }

    // 回收站是空间作用域的：viewer 能看到本空间的回收站。
    const deleted = await createPage(
      env,
      admin,
      "viewer 可见的回收页",
      space.id
    )
    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${deleted.id}`,
      undefined,
      admin
    )
    const trash = await jsonRequest(
      env,
      "GET",
      `/api/pages/trash?spaceId=${space.id}`,
      undefined,
      viewer
    )
    expect(trash.status).toBe(200)
    expect(
      ((await trash.json()) as Array<{ id: string }>).map((row) => row.id)
    ).toContain(deleted.id)
  })
})

describe("空间权限：editor 可写页面，不可管理空间", () => {
  it("新建/编辑/删除/恢复页面成功；成员与空间信息被拒", async () => {
    const { env, editor, space } = await scenario()

    const created = await createPage(
      env,
      editor,
      "editor 新页",
      space.id,
      "editor 正文"
    )
    expect(created.spaceId).toBe(space.id)

    const updated = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${created.id}`,
      {
        title: "editor 改过",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>改过</p>",
        contentText: "改过"
      },
      editor
    )
    expect(updated.status).toBe(200)

    const removed = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${created.id}`,
      undefined,
      editor
    )
    expect(removed.status).toBe(200)
    const restored = await jsonRequest(
      env,
      "POST",
      `/api/pages/${created.id}/restore`,
      undefined,
      editor
    )
    expect(restored.status).toBe(200)

    const members = await jsonRequest(
      env,
      "GET",
      `/api/spaces/${space.id}/members`,
      undefined,
      editor
    )
    expect(members.status).toBe(403)
    const addMember = await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space.id}/members`,
      { userId: "x", role: "viewer" },
      editor
    )
    expect(addMember.status).toBe(403)
    const rename = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${space.id}`,
      { name: "editor 改空间" },
      editor
    )
    expect(rename.status).toBe(403)
    const removeSpace = await jsonRequest(
      env,
      "DELETE",
      `/api/spaces/${space.id}`,
      undefined,
      editor
    )
    expect(removeSpace.status).toBe(403)
  })
})

describe("空间权限：站点管理员与跨空间移动", () => {
  it("站点管理员看全量空间并可管理；跨空间移动改 spaceId 并重挂", async () => {
    const { env, admin, space, defaultSpace, page } = await scenario()

    const spaces = await listSpaces(env, admin)
    expect(spaces.find((row) => row.id === space.id)?.myRole).toBe("admin")
    expect(spaces.find((row) => row.id === defaultSpace.id)?.myRole).toBe(
      "admin"
    )

    const members = await jsonRequest(
      env,
      "GET",
      `/api/spaces/${space.id}/members`,
      undefined,
      admin
    )
    expect(members.status).toBe(200)

    // 跨空间且未给父页：重挂到目标空间根。
    const moved = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/move`,
      { spaceId: defaultSpace.id },
      admin
    )
    expect(moved.status).toBe(200)
    const detail = (await (
      await jsonRequest(env, "GET", `/api/pages/${page.id}`, undefined, admin)
    ).json()) as PageDto
    expect(detail.spaceId).toBe(defaultSpace.id)
    expect((await listSpaces(env, admin)).length).toBeGreaterThan(1)

    const defaultTree = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages?spaceId=${defaultSpace.id}`,
        undefined,
        admin
      )
    ).json()) as Array<{ id: string }>
    expect(defaultTree.map((row) => row.id)).toContain(page.id)

    // 目标父页属于另一个空间 → 409。
    const bParent = await createPage(env, admin, "B 父页", space.id)
    const defaultChild = await createPage(
      env,
      admin,
      "默认空间子页",
      defaultSpace.id
    )
    const mismatch = await jsonRequest(
      env,
      "POST",
      `/api/pages/${defaultChild.id}/move`,
      { spaceId: space.id, parentId: page.id },
      admin
    )
    expect(mismatch.status).toBe(409)
    expect(await mismatch.json()).toMatchObject({ code: "SPACE_MISMATCH" })

    const crossWithParent = await jsonRequest(
      env,
      "POST",
      `/api/pages/${defaultChild.id}/move`,
      { spaceId: space.id, parentId: bParent.id },
      admin
    )
    expect(crossWithParent.status).toBe(200)

    // 同空间内移入自身子树 → 409。
    const cycle = await jsonRequest(
      env,
      "POST",
      `/api/pages/${bParent.id}/move`,
      { parentId: defaultChild.id },
      admin
    )
    expect(cycle.status).toBe(409)
    expect(await cycle.json()).toMatchObject({ code: "PAGE_MOVE_CYCLE" })

    // 跨空间移动整棵子树：后代一起改 space_id，之后在目标空间软删能级联。
    const moveRoot = await createPage(env, admin, "跨空间根", space.id)
    const moveChild = await createPage(
      env,
      admin,
      "跨空间子页",
      space.id,
      "跨空间子页",
      moveRoot.id
    )
    const moveSubtree = await jsonRequest(
      env,
      "POST",
      `/api/pages/${moveRoot.id}/move`,
      { spaceId: defaultSpace.id },
      admin
    )
    expect(moveSubtree.status).toBe(200)

    const childDetail = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${moveChild.id}`,
        undefined,
        admin
      )
    ).json()) as PageDto
    expect(childDetail.spaceId).toBe(defaultSpace.id)

    const sourceTree = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages?spaceId=${space.id}`,
        undefined,
        admin
      )
    ).json()) as Array<{ id: string; children: Array<{ id: string }> }>
    const sourceIds = sourceTree.flatMap((node) => [
      node.id,
      ...node.children.map((child) => child.id)
    ])
    expect(sourceIds).not.toContain(moveRoot.id)
    expect(sourceIds).not.toContain(moveChild.id)

    const cascade = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${moveRoot.id}`,
      undefined,
      admin
    )
    expect(cascade.status).toBe(200)
    const childGone = await jsonRequest(
      env,
      "GET",
      `/api/pages/${moveChild.id}`,
      undefined,
      admin
    )
    expect(childGone.status).toBe(404)
  })
})
