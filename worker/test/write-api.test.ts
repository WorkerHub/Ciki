/**
 * 写接口（二期规格 §3.2 / §3.3 / §2.5）：四个端点、写令牌中间件与空间范围。
 *
 * 字段是 snake_case 的冻结契约（建页/改页元信息精确六键），正文只收 TipTap JSON。
 * 权限与站内一致再叠令牌范围：任何越权/范围外一律 404，不泄露页面存在性。
 * 写入必须复用站内唯一写路径，所以这里同时断言 revision、作者与派生列。
 */
import { describe, expect, it } from "vitest"
import {
  adminSession,
  createApiToken,
  createImportToken,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"
import type { Env } from "../src/types"

const META_KEYS = [
  "id",
  "parent_id",
  "sort_order",
  "space_id",
  "title",
  "updated_at"
]

type Context = Awaited<ReturnType<typeof initializedContext>>

interface PageMeta {
  id: number
  space_id: number
  parent_id: number | null
  sort_order: number
  title: string
  updated_at: string
}

interface DbPageRow {
  id: number
  space_id: number
  parent_id: number | null
  sort_order: number
  title: string
  content_hash: string
  content_html: string
  content_text: string
  content_md: string
  created_by: number
  updated_by: number
  updated_at: string
  deleted_at: string | null
}

function doc(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }]
  }
}

function docJson(text: string): string {
  return JSON.stringify(doc(text))
}

async function issueWriteToken(
  env: Env,
  cookie: string,
  options: { spaceIds?: number[] | null } = {}
): Promise<{ id: number; token: string }> {
  return createApiToken(env, cookie, "write", options)
}

function writeRequest(
  env: Env,
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`
  }
  if (body !== undefined) headers["content-type"] = "application/json"
  return request(env, path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

async function listSpaces(
  env: Env,
  cookie: string
): Promise<Array<{ id: number; name: string; isDefault: boolean }>> {
  const res = await jsonRequest(env, "GET", "/api/spaces", undefined, cookie)
  expect(res.status).toBe(200)
  return (await res.json()) as Array<{
    id: number
    name: string
    isDefault: boolean
  }>
}

async function defaultSpaceId(env: Env, cookie: string): Promise<number> {
  const defaultSpace = (await listSpaces(env, cookie)).find(
    (row) => row.isDefault
  )
  if (!defaultSpace) throw new Error("default space missing")
  return defaultSpace.id
}

async function createSpace(
  env: Env,
  cookie: string,
  name: string
): Promise<number> {
  const res = await jsonRequest(env, "POST", "/api/spaces", { name }, cookie)
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: number }).id
}

async function meId(env: Env, cookie: string): Promise<number> {
  const res = await jsonRequest(env, "GET", "/api/me", undefined, cookie)
  expect(res.status).toBe(200)
  return ((await res.json()) as { id: number }).id
}

async function addMember(
  env: Env,
  admin: string,
  spaceId: number,
  userId: number,
  role: "admin" | "editor" | "viewer"
): Promise<void> {
  const res = await jsonRequest(
    env,
    "POST",
    `/api/spaces/${spaceId}/members`,
    { userId, role },
    admin
  )
  expect(res.status).toBe(201)
}

/** 用站内会话建页（写接口用例的布景，或对照组）。 */
async function sessionCreatePage(
  env: Env,
  cookie: string,
  input: {
    title: string
    spaceId?: number
    parentId?: number | null
    text?: string
  }
): Promise<PageMeta & { spaceId: number; parentId: number | null }> {
  const text = input.text ?? input.title
  const res = await jsonRequest(
    env,
    "POST",
    "/api/pages",
    {
      title: input.title,
      parentId: input.parentId ?? null,
      spaceId: input.spaceId ?? null,
      contentJson: docJson(text),
      contentHtml: `<p>${text}</p>`,
      contentText: text
    },
    cookie
  )
  expect(res.status).toBe(201)
  const page = (await res.json()) as {
    id: number
    spaceId: number
    parentId: number | null
    title: string
    sortOrder: number
    updatedAt: string
  }
  return {
    id: page.id,
    space_id: page.spaceId,
    parent_id: page.parentId,
    sort_order: page.sortOrder,
    title: page.title,
    updated_at: page.updatedAt,
    spaceId: page.spaceId,
    parentId: page.parentId
  }
}

function pageRow(context: Context, id: number): DbPageRow {
  const row = context.db.db
    .prepare("SELECT * FROM ciki_pages WHERE id = ?")
    .get(id) as DbPageRow | undefined
  if (!row) throw new Error(`page ${id} not found`)
  return row
}

async function revisions(
  env: Env,
  cookie: string,
  pageId: number
): Promise<Array<{ versionNo: number; title: string; editorId: number }>> {
  const res = await jsonRequest(
    env,
    "GET",
    `/api/pages/${pageId}/revisions`,
    undefined,
    cookie
  )
  expect(res.status).toBe(200)
  return (await res.json()) as Array<{
    versionNo: number
    title: string
    editorId: number
  }>
}

async function searchTitles(
  env: Env,
  cookie: string,
  query: string
): Promise<string[]> {
  const res = await jsonRequest(
    env,
    "GET",
    `/api/search?q=${encodeURIComponent(query)}`,
    undefined,
    cookie
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    results: Array<{ title: string }>
  }
  return body.results.map((row) => row.title)
}

async function seedCounter(
  context: Context,
  action: string,
  account: string,
  count: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  context.db.db
    .prepare(
      "INSERT INTO ciki_auth_counters (key, action, account, ip, count, window_start, locked_until, updated_at) VALUES (?, ?, ?, '', ?, ?, NULL, ?)"
    )
    .run(`${action}:${account}:`, action, account, count, now, now)
}

describe("写接口：鉴权只认读写令牌", () => {
  it("无令牌、会话 Cookie、只读令牌、导入令牌与坏令牌都 401（no-store）", async () => {
    const context = await initializedContext()
    const { env } = context
    const admin = await adminSession(env)
    const writeToken = await issueWriteToken(env, admin)

    const anonymous = await request(env, "/api/write/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "匿名", content_json: docJson("匿名") })
    })
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get("cache-control")).toContain("no-store")
    expect(await anonymous.json()).toEqual({ error: "Unauthorized" })

    // 会话 Cookie 在令牌接口上一律无效（职责分离）。
    const sessionOnly = await jsonRequest(
      env,
      "POST",
      "/api/write/pages",
      { title: "会话", content_json: docJson("会话") },
      admin
    )
    expect(sessionOnly.status).toBe(401)

    const readToken = await createApiToken(env, admin, "read")
    const importToken = await createImportToken(env, admin)
    for (const token of [readToken.token, importToken.token, "not-a-token"]) {
      const res = await writeRequest(env, token, "POST", "/api/write/pages", {
        title: "越界",
        content_json: docJson("越界")
      })
      expect(res.status).toBe(401)
    }

    // 有效令牌可用，并在成功后刷新 lastUsedAt。
    const created = await writeRequest(
      env,
      writeToken.token,
      "POST",
      "/api/write/pages",
      { title: "正常", content_json: docJson("正常") }
    )
    expect(created.status).toBe(201)
    const list = (await (
      await jsonRequest(env, "GET", "/api/me/tokens", undefined, admin)
    ).json()) as { tokens: Array<{ id: number; lastUsedAt: string | null }> }
    expect(
      list.tokens.find((row) => row.id === writeToken.id)?.lastUsedAt
    ).not.toBeNull()

    // 吊销后立即 401。
    await jsonRequest(
      env,
      "DELETE",
      `/api/me/tokens/${writeToken.id}`,
      undefined,
      admin
    )
    const revoked = await writeRequest(
      env,
      writeToken.token,
      "POST",
      "/api/write/pages",
      {
        title: "吊销后",
        content_json: docJson("吊销后")
      }
    )
    expect(revoked.status).toBe(401)
  })

  it("未知路径鉴权后仍回 JSON 404（不掉进 SPA 回落）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { token } = await issueWriteToken(env, admin)

    const anonymous = await request(env, "/api/write/nope")
    expect(anonymous.status).toBe(401)

    const res = await writeRequest(env, token, "GET", "/api/write/nope")
    expect(res.status).toBe(404)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.json()).toEqual({ error: "Not found" })
  })
})

describe("写接口：限流", () => {
  it("调用额度按用户 600 次 / 5 分钟；窗口过期后恢复", async () => {
    const context = await initializedContext()
    const { env } = context
    const admin = await adminSession(env)
    const { token } = await issueWriteToken(env, admin)
    const userId = await meId(env, admin)

    await seedCounter(context, "write", String(userId), 600)
    const limited = await writeRequest(env, token, "POST", "/api/write/pages", {
      title: "限流",
      content_json: docJson("限流")
    })
    expect(limited.status).toBe(429)
    const body = (await limited.json()) as { code: string; retryAfter: number }
    expect(body.code).toBe("RATE_LIMITED")
    expect(body.retryAfter).toBeGreaterThanOrEqual(290)
    expect(body.retryAfter).toBeLessThanOrEqual(300)

    const now = Math.floor(Date.now() / 1000)
    context.db.db
      .prepare("UPDATE ciki_auth_counters SET window_start = ? WHERE key = ?")
      .run(now - 301, `write:${userId}:`)
    const recovered = await writeRequest(
      env,
      token,
      "POST",
      "/api/write/pages",
      { title: "恢复", content_json: docJson("恢复") }
    )
    expect(recovered.status).toBe(201)
  })

  it("令牌爆破按 IP 20 次 / 5 分钟（先拒后验）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { token } = await issueWriteToken(env, admin)

    for (let attempt = 1; attempt <= 19; attempt += 1) {
      const res = await writeRequest(
        env,
        "wrong-token",
        "POST",
        "/api/write/pages",
        {
          title: "爆破",
          content_json: docJson("爆破")
        }
      )
      expect(res.status).toBe(401)
    }
    const twentieth = await writeRequest(
      env,
      "wrong-token",
      "POST",
      "/api/write/pages",
      {
        title: "爆破",
        content_json: docJson("爆破")
      }
    )
    expect(twentieth.status).toBe(429)
    expect(await twentieth.json()).toMatchObject({ code: "RATE_LIMITED" })

    const blocked = await writeRequest(env, token, "POST", "/api/write/pages", {
      title: "被挡",
      content_json: docJson("被挡")
    })
    expect(blocked.status).toBe(429)
  })
})

describe("写接口：建页", () => {
  it("默认空间建页：201 精确六键、排同级末尾、revision 与派生列齐全", async () => {
    const context = await initializedContext()
    const { env } = context
    const admin = await adminSession(env)
    const adminId = await meId(env, admin)
    const spaceId = await defaultSpaceId(env, admin)
    const { token } = await issueWriteToken(env, admin)

    const first = await writeRequest(env, token, "POST", "/api/write/pages", {
      title: "<b>第一章</b>",
      content_json: doc("第一章正文")
    })
    expect(first.status).toBe(201)
    const firstPage = (await first.json()) as PageMeta
    expect(Object.keys(firstPage).sort()).toEqual(META_KEYS)
    expect(firstPage).toMatchObject({
      space_id: spaceId,
      parent_id: null,
      sort_order: 0,
      title: "第一章"
    })
    expect(typeof firstPage.updated_at).toBe("string")

    const row = pageRow(context, firstPage.id)
    expect(row.created_by).toBe(adminId)
    expect(row.updated_by).toBe(adminId)
    expect(row.content_html).toContain("第一章正文")
    expect(row.content_text).toBe("第一章正文")
    expect(row.content_md).toContain("第一章正文")
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/)

    const history = await revisions(env, admin, firstPage.id)
    expect(history).toHaveLength(1)
    expect(history[0].editorId).toBe(adminId)

    // 新页永远排同级末尾；FTS 同步可搜到。
    const second = await writeRequest(env, token, "POST", "/api/write/pages", {
      title: "第二章",
      content_json: doc("第二章正文")
    })
    expect(second.status).toBe(201)
    expect(((await second.json()) as PageMeta).sort_order).toBe(1)
    expect(await searchTitles(env, admin, "第一章")).toContain("第一章")

    // 指定父页（同空间）：parent_id 透传。
    const child = await writeRequest(env, token, "POST", "/api/write/pages", {
      space_id: spaceId,
      parent_id: firstPage.id,
      title: "子页",
      content_json: doc("子页正文")
    })
    expect(child.status).toBe(201)
    const childPage = (await child.json()) as PageMeta
    expect(childPage.parent_id).toBe(firstPage.id)
    expect(childPage.space_id).toBe(spaceId)
    expect(childPage.sort_order).toBe(0)
  })

  it("指定空间建页；父页已删 409、父页不存在/越权/跨空间矩阵", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { token } = await issueWriteToken(env, admin)
    const otherSpace = await createSpace(env, admin, "第二空间")
    const defaultId = await defaultSpaceId(env, admin)

    const created = await writeRequest(env, token, "POST", "/api/write/pages", {
      space_id: otherSpace,
      title: "另一空间",
      content_json: doc("另一空间正文")
    })
    expect(created.status).toBe(201)
    expect(((await created.json()) as PageMeta).space_id).toBe(otherSpace)

    // 父页已软删 → 409 PARENT_DELETED。
    const parent = await sessionCreatePage(env, admin, { title: "将删父页" })
    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${parent.id}`,
      undefined,
      admin
    )
    const deletedParent = await writeRequest(
      env,
      token,
      "POST",
      "/api/write/pages",
      {
        space_id: defaultId,
        parent_id: parent.id,
        title: "孤儿",
        content_json: docJson("孤儿")
      }
    )
    expect(deletedParent.status).toBe(409)
    expect(await deletedParent.json()).toMatchObject({ code: "PARENT_DELETED" })

    // 父页不存在 → 404（写接口通用「按不存在处理」，不泄露存在性）。
    const missingParent = await writeRequest(
      env,
      token,
      "POST",
      "/api/write/pages",
      {
        parent_id: 999_999,
        title: "无处安放",
        content_json: docJson("无处安放")
      }
    )
    expect(missingParent.status).toBe(404)
    expect(await missingParent.json()).toEqual({ error: "Page not found" })

    // 父页在别的空间 → 409 SPACE_MISMATCH（两个空间都可写时给出明确冲突）。
    const otherParent = (await (
      await writeRequest(env, token, "POST", "/api/write/pages", {
        space_id: otherSpace,
        title: "别空间父页",
        content_json: docJson("别空间父页")
      })
    ).json()) as PageMeta
    const wrongSpace = await writeRequest(
      env,
      token,
      "POST",
      "/api/write/pages",
      {
        space_id: defaultId,
        parent_id: otherParent.id,
        title: "跨空间",
        content_json: docJson("跨空间")
      }
    )
    expect(wrongSpace.status).toBe(409)
    expect(await wrongSpace.json()).toMatchObject({ code: "SPACE_MISMATCH" })

    // 不带 space_id 时落默认空间（与导入接口同口径）：父页在别空间同样是 409。
    const omittedSpace = await writeRequest(
      env,
      token,
      "POST",
      "/api/write/pages",
      {
        parent_id: otherParent.id,
        title: "默认空间落点",
        content_json: docJson("默认空间落点")
      }
    )
    expect(omittedSpace.status).toBe(409)
    expect(await omittedSpace.json()).toMatchObject({ code: "SPACE_MISMATCH" })

    // 不存在的空间 → 404 SPACE_NOT_FOUND。
    const missingSpace = await writeRequest(
      env,
      token,
      "POST",
      "/api/write/pages",
      {
        space_id: 999_999,
        title: "无空间",
        content_json: docJson("无空间")
      }
    )
    expect(missingSpace.status).toBe(404)
    expect(await missingSpace.json()).toMatchObject({ code: "SPACE_NOT_FOUND" })
  })

  it("入参错误：标题/正文/父空间 id 与体积上限", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { token } = await issueWriteToken(env, admin)

    const invalidJson = await writeRequest(
      env,
      token,
      "POST",
      "/api/write/pages",
      {
        title: "坏正文",
        content_json: "not-json"
      }
    )
    expect(invalidJson.status).toBe(400)
    expect(await invalidJson.json()).toMatchObject({
      code: "INVALID_CONTENT_JSON"
    })

    const unrenderable = await writeRequest(
      env,
      token,
      "POST",
      "/api/write/pages",
      {
        title: "坏结构",
        content_json: { type: "doc", content: [{ type: "nope-not-a-node" }] }
      }
    )
    expect(unrenderable.status).toBe(400)
    expect(await unrenderable.json()).toMatchObject({
      code: "INVALID_CONTENT_JSON"
    })

    const missingTitle = await writeRequest(
      env,
      token,
      "POST",
      "/api/write/pages",
      {
        content_json: docJson("没有标题")
      }
    )
    expect(missingTitle.status).toBe(400)
    expect(await missingTitle.json()).toMatchObject({ error: "Title required" })

    const longTitle = await writeRequest(
      env,
      token,
      "POST",
      "/api/write/pages",
      {
        title: "x".repeat(256),
        content_json: docJson("长标题")
      }
    )
    expect(longTitle.status).toBe(400)
    expect(await longTitle.json()).toMatchObject({
      error: "Title must be 1-255 characters"
    })

    const huge = await writeRequest(env, token, "POST", "/api/write/pages", {
      title: "超大正文",
      content_json: doc("x".repeat(800_001))
    })
    expect(huge.status).toBe(413)
    expect(await huge.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" })

    const badParent = await writeRequest(
      env,
      token,
      "POST",
      "/api/write/pages",
      {
        parent_id: "abc",
        title: "坏父页",
        content_json: docJson("坏父页")
      }
    )
    expect(badParent.status).toBe(400)
    expect(await badParent.json()).toMatchObject({
      error: "parent_id must be an integer or null"
    })

    const badSpace = await writeRequest(
      env,
      token,
      "POST",
      "/api/write/pages",
      {
        space_id: "abc",
        title: "坏空间",
        content_json: docJson("坏空间")
      }
    )
    expect(badSpace.status).toBe(400)
    expect(await badSpace.json()).toMatchObject({
      error: "space_id must be an integer"
    })

    const badBody = await request(env, "/api/write/pages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: "{"
    })
    expect(badBody.status).toBe(400)
    expect(await badBody.json()).toEqual({ error: "Invalid request body" })
  })
})

describe("写接口：改页", () => {
  it("只改正文 / 只改标题 / 两者同改；无改动不涨版本", async () => {
    const context = await initializedContext()
    const { env } = context
    const admin = await adminSession(env)
    const adminId = await meId(env, admin)
    const { token } = await issueWriteToken(env, admin)

    const created = await writeRequest(env, token, "POST", "/api/write/pages", {
      title: "原标题",
      content_json: doc("原正文")
    })
    const page = (await created.json()) as PageMeta

    // 只改正文：标题保持，追加一条版本。
    const contentOnly = await writeRequest(
      env,
      token,
      "PUT",
      `/api/write/pages/${page.id}`,
      { content_json: doc("新正文") }
    )
    expect(contentOnly.status).toBe(200)
    const afterContent = (await contentOnly.json()) as PageMeta
    expect(Object.keys(afterContent).sort()).toEqual(META_KEYS)
    expect(afterContent.title).toBe("原标题")
    expect(pageRow(context, page.id).content_text).toBe("新正文")
    expect(await revisions(env, admin, page.id)).toHaveLength(2)

    // 只改标题：不读正文、不产版本，作者记为令牌主人。
    const titleOnly = await writeRequest(
      env,
      token,
      "PUT",
      `/api/write/pages/${page.id}`,
      { title: "新标题" }
    )
    expect(titleOnly.status).toBe(200)
    const afterTitle = (await titleOnly.json()) as PageMeta
    expect(afterTitle.title).toBe("新标题")
    const rowAfterTitle = pageRow(context, page.id)
    expect(rowAfterTitle.updated_by).toBe(adminId)
    expect(rowAfterTitle.content_text).toBe("新正文")
    expect(await revisions(env, admin, page.id)).toHaveLength(2)
    expect(await searchTitles(env, admin, "新标题")).toContain("新标题")

    // 两者同改：追加版本。
    const both = await writeRequest(
      env,
      token,
      "PUT",
      `/api/write/pages/${page.id}`,
      { title: "第三标题", content_json: doc("第三正文") }
    )
    expect(both.status).toBe(200)
    expect(((await both.json()) as PageMeta).title).toBe("第三标题")
    expect(await revisions(env, admin, page.id)).toHaveLength(3)

    // 完全无改动：不涨版本、updated_at 原样返回。
    const before = pageRow(context, page.id)
    const noop = await writeRequest(
      env,
      token,
      "PUT",
      `/api/write/pages/${page.id}`,
      { title: "第三标题", content_json: doc("第三正文") }
    )
    expect(noop.status).toBe(200)
    const noopPage = (await noop.json()) as PageMeta
    expect(noopPage.updated_at).toBe(before.updated_at)
    expect(await revisions(env, admin, page.id)).toHaveLength(3)
  })

  it("画布块：支持包含 excalidraw 节点的正文建页与更新", async () => {
    const context = await initializedContext()
    const { env } = context
    const admin = await adminSession(env)
    const { token } = await issueWriteToken(env, admin)

    const sceneKey = "pages/1b3e5a7d-890f-4e3b-b21c-4f8a9e0d1c2b.json"
    const previewKey = "pages/7fa3c5b1-e221-4d1a-8c90-9f201b1a3e45.png"
    const excalidrawDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "画布正文" }]
        },
        {
          type: "excalidraw",
          attrs: {
            sceneKey,
            previewKey,
            extractedText: "架构设计图",
            width: 720
          }
        }
      ]
    }

    const created = await writeRequest(env, token, "POST", "/api/write/pages", {
      title: "画布写接口页",
      content_json: excalidrawDoc
    })
    expect(created.status).toBe(201)
    const page = (await created.json()) as PageMeta

    const row = pageRow(context, page.id)
    expect(row.content_html).toContain('data-type="excalidraw"')
    expect(row.content_html).toContain(`data-scene-key="${sceneKey}"`)
    expect(row.content_html).toContain(`data-preview-key="${previewKey}"`)
    expect(row.content_html).toContain(`src="/api/files/${previewKey}"`)
    expect(row.content_html).toContain('alt="架构设计图"')
    expect(row.content_html).toContain('width="720"')
    expect(row.content_text).toContain("架构设计图")
    expect(row.content_md).toContain(
      `![架构设计图](https://ciki.oneboy.app/api/files/${previewKey})`
    )

    // 更新页面继续带画布块
    const updated = await writeRequest(
      env,
      token,
      "PUT",
      `/api/write/pages/${page.id}`,
      {
        content_json: {
          type: "doc",
          content: [
            {
              type: "excalidraw",
              attrs: {
                sceneKey,
                previewKey,
                extractedText: "更新后架构设计图",
                width: 600
              }
            }
          ]
        }
      }
    )
    expect(updated.status).toBe(200)
    const rowUpdated = pageRow(context, page.id)
    expect(rowUpdated.content_html).toContain('alt="更新后架构设计图"')
    expect(rowUpdated.content_html).toContain('width="600"')
    expect(rowUpdated.content_text).toContain("更新后架构设计图")
  })

  it("至少给一个字段；页面不存在/已删/坏 id 一律 404；正文错误码", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { token } = await issueWriteToken(env, admin)

    const page = (await (
      await writeRequest(env, token, "POST", "/api/write/pages", {
        title: "目标页",
        content_json: doc("目标页正文")
      })
    ).json()) as PageMeta

    const empty = await writeRequest(
      env,
      token,
      "PUT",
      `/api/write/pages/${page.id}`,
      {}
    )
    expect(empty.status).toBe(400)
    expect(await empty.json()).toEqual({
      error: "title or content_json required"
    })

    const badJson = await writeRequest(
      env,
      token,
      "PUT",
      `/api/write/pages/${page.id}`,
      { content_json: "not-json" }
    )
    expect(badJson.status).toBe(400)
    expect(await badJson.json()).toMatchObject({ code: "INVALID_CONTENT_JSON" })

    const badId = await writeRequest(
      env,
      token,
      "PUT",
      "/api/write/pages/not-an-id",
      { title: "坏 id" }
    )
    expect(badId.status).toBe(404)

    const missing = await writeRequest(
      env,
      token,
      "PUT",
      "/api/write/pages/999999",
      { title: "不存在" }
    )
    expect(missing.status).toBe(404)

    await writeRequest(env, token, "DELETE", `/api/write/pages/${page.id}`)
    const deleted = await writeRequest(
      env,
      token,
      "PUT",
      `/api/write/pages/${page.id}`,
      { title: "已删" }
    )
    expect(deleted.status).toBe(404)
  })
})

describe("写接口：移动", () => {
  it("同级重排、换父、环检测与入参校验", async () => {
    const context = await initializedContext()
    const { env } = context
    const admin = await adminSession(env)
    const { token } = await issueWriteToken(env, admin)

    const a = (await (
      await writeRequest(env, token, "POST", "/api/write/pages", {
        title: "A",
        content_json: doc("A")
      })
    ).json()) as PageMeta
    const b = (await (
      await writeRequest(env, token, "POST", "/api/write/pages", {
        title: "B",
        content_json: doc("B")
      })
    ).json()) as PageMeta
    const c = (await (
      await writeRequest(env, token, "POST", "/api/write/pages", {
        title: "C",
        content_json: doc("C")
      })
    ).json()) as PageMeta

    // 把 C 拖到同级最前：整组重排为 0..n-1。
    const reorder = await writeRequest(
      env,
      token,
      "POST",
      `/api/write/pages/${c.id}/move`,
      { parent_id: null, index: 0 }
    )
    expect(reorder.status).toBe(200)
    expect(await reorder.json()).toEqual({ success: true })
    expect(pageRow(context, c.id).sort_order).toBe(0)
    expect(pageRow(context, a.id).sort_order).toBe(1)
    expect(pageRow(context, b.id).sort_order).toBe(2)

    // 换父：B 挂到 A 下，目标层级从 0 开始。
    const reparent = await writeRequest(
      env,
      token,
      "POST",
      `/api/write/pages/${b.id}/move`,
      { parent_id: a.id, index: 0 }
    )
    expect(reparent.status).toBe(200)
    expect(pageRow(context, b.id).parent_id).toBe(a.id)
    expect(pageRow(context, b.id).sort_order).toBe(0)
    // 旧同级重排：从根级抽走 B 后，C 仍为 0、A 补齐为 1。
    expect(pageRow(context, c.id).sort_order).toBe(0)
    expect(pageRow(context, a.id).sort_order).toBe(1)

    // 移进自身子树 → 409 PAGE_MOVE_CYCLE。
    const cycle = await writeRequest(
      env,
      token,
      "POST",
      `/api/write/pages/${a.id}/move`,
      { parent_id: b.id, index: 0 }
    )
    expect(cycle.status).toBe(409)
    expect(await cycle.json()).toMatchObject({ code: "PAGE_MOVE_CYCLE" })

    // 父页已删 / 不存在 → 409 PARENT_DELETED（契约原文）。
    const deletedParent = await sessionCreatePage(env, admin, {
      title: "将删父页"
    })
    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${deletedParent.id}`,
      undefined,
      admin
    )
    for (const parentId of [deletedParent.id, 999_999]) {
      const res = await writeRequest(
        env,
        token,
        "POST",
        `/api/write/pages/${a.id}/move`,
        { parent_id: parentId, index: 0 }
      )
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ code: "PARENT_DELETED" })
    }

    // 入参：parent_id / index 必填，index 必须是非负整数。
    for (const body of [
      { index: 0 },
      { parent_id: null },
      { parent_id: null, index: -1 },
      { parent_id: null, index: 1.5 },
      { parent_id: null, index: "0" }
    ]) {
      const res = await writeRequest(
        env,
        token,
        "POST",
        `/api/write/pages/${a.id}/move`,
        body
      )
      expect(res.status).toBe(400)
    }
  })

  it("跨空间移动：整棵子树换空间，旧的同级重排", async () => {
    const context = await initializedContext()
    const { env } = context
    const admin = await adminSession(env)
    const { token } = await issueWriteToken(env, admin)
    const defaultId = await defaultSpaceId(env, admin)
    const otherSpace = await createSpace(env, admin, "目标空间")

    const sibling = await sessionCreatePage(env, admin, { title: "留下的同级" })
    const moving = await sessionCreatePage(env, admin, { title: "要搬的页" })
    const child = await sessionCreatePage(env, admin, {
      title: "随行的子页",
      parentId: moving.id
    })
    const existingTarget = await sessionCreatePage(env, admin, {
      title: "目标空间现有页",
      spaceId: otherSpace
    })
    expect(moving.space_id).toBe(defaultId)

    const moved = await writeRequest(
      env,
      token,
      "POST",
      `/api/write/pages/${moving.id}/move`,
      { space_id: otherSpace, parent_id: null, index: 0 }
    )
    expect(moved.status).toBe(200)

    expect(pageRow(context, moving.id).space_id).toBe(otherSpace)
    expect(pageRow(context, moving.id).parent_id).toBeNull()
    expect(pageRow(context, moving.id).sort_order).toBe(0)
    // 子树跟着换空间，父子不跨空间。
    expect(pageRow(context, child.id).space_id).toBe(otherSpace)
    // 目标空间原根页被挤到 1；源空间的同级重排回 0。
    expect(pageRow(context, existingTarget.id).sort_order).toBe(1)
    expect(pageRow(context, sibling.id).sort_order).toBe(0)
  })
})

describe("写接口：删除", () => {
  it("软删整棵子树进回收站、清 FTS，站内可恢复；重复删 404", async () => {
    const context = await initializedContext()
    const { env } = context
    const admin = await adminSession(env)
    const { token } = await issueWriteToken(env, admin)
    const spaceId = await defaultSpaceId(env, admin)

    const parent = (await (
      await writeRequest(env, token, "POST", "/api/write/pages", {
        title: "待删父页",
        content_json: doc("待删父页正文")
      })
    ).json()) as PageMeta
    const child = (await (
      await writeRequest(env, token, "POST", "/api/write/pages", {
        space_id: spaceId,
        parent_id: parent.id,
        title: "待删子页",
        content_json: doc("待删子页正文")
      })
    ).json()) as PageMeta

    const removed = await writeRequest(
      env,
      token,
      "DELETE",
      `/api/write/pages/${parent.id}`
    )
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ success: true })
    expect(pageRow(context, parent.id).deleted_at).not.toBeNull()
    expect(pageRow(context, child.id).deleted_at).not.toBeNull()
    expect(await searchTitles(env, admin, "待删父页")).not.toContain("待删父页")

    const trash = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/trash?spaceId=${spaceId}`,
        undefined,
        admin
      )
    ).json()) as Array<{ id: number }>
    expect(trash.map((row) => row.id)).toContain(parent.id)

    // 与站内删除同一语义：会话面能恢复整棵子树。
    const restore = await jsonRequest(
      env,
      "POST",
      `/api/pages/${parent.id}/restore`,
      undefined,
      admin
    )
    expect(restore.status).toBe(200)

    const again = await writeRequest(
      env,
      token,
      "DELETE",
      `/api/write/pages/${parent.id}`
    )
    expect(again.status).toBe(200)
    const removedTwice = await writeRequest(
      env,
      token,
      "DELETE",
      `/api/write/pages/${parent.id}`
    )
    expect(removedTwice.status).toBe(404)
  })
})

describe("写接口：空间范围与角色", () => {
  it("范围外页面四端点全 404，且响应不含标题；建页落范围外空间 404", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const defaultId = await defaultSpaceId(env, admin)
    const otherSpace = await createSpace(env, admin, "范围外空间")
    const hidden = await sessionCreatePage(env, admin, {
      title: "范围外机密页",
      spaceId: otherSpace
    })
    // 令牌范围只给默认空间（站点管理员同样受范围收窄）。
    const { token } = await issueWriteToken(env, admin, {
      spaceIds: [defaultId]
    })

    const cases: Array<[string, string, unknown]> = [
      ["PUT", `/api/write/pages/${hidden.id}`, { title: "改名" }],
      [
        "POST",
        `/api/write/pages/${hidden.id}/move`,
        { parent_id: null, index: 0 }
      ],
      ["DELETE", `/api/write/pages/${hidden.id}`, undefined]
    ]
    for (const [method, path, body] of cases) {
      const res = await writeRequest(env, token, method, path, body)
      expect(res.status).toBe(404)
      const text = JSON.stringify(await res.json())
      expect(text).not.toContain("范围外机密页")
    }

    const createOut = await writeRequest(
      env,
      token,
      "POST",
      "/api/write/pages",
      {
        space_id: otherSpace,
        title: "范围外新页",
        content_json: docJson("范围外新页")
      }
    )
    expect(createOut.status).toBe(404)
    expect(await createOut.json()).toMatchObject({ code: "SPACE_NOT_FOUND" })

    // 范围内建页仍可用。
    const inside = await writeRequest(env, token, "POST", "/api/write/pages", {
      title: "范围内新页",
      content_json: docJson("范围内新页")
    })
    expect(inside.status).toBe(201)
  })

  it("viewer 角色在目标空间只读：四个端点一律 404", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const viewer = await userSession(env, admin, "viewer@example.com")
    const viewerId = await meId(env, viewer)
    const space = await createSpace(env, admin, "只读空间")
    await addMember(env, admin, space, viewerId, "viewer")
    const page = await sessionCreatePage(env, admin, {
      title: "只读页",
      spaceId: space
    })
    const { token } = await issueWriteToken(env, viewer)

    const create = await writeRequest(env, token, "POST", "/api/write/pages", {
      space_id: space,
      title: "越权新建",
      content_json: docJson("越权新建")
    })
    expect(create.status).toBe(404)

    const update = await writeRequest(
      env,
      token,
      "PUT",
      `/api/write/pages/${page.id}`,
      { title: "越权改" }
    )
    expect(update.status).toBe(404)
    expect(JSON.stringify(await update.json())).not.toContain("只读页")

    const move = await writeRequest(
      env,
      token,
      "POST",
      `/api/write/pages/${page.id}/move`,
      { parent_id: null, index: 0 }
    )
    expect(move.status).toBe(404)

    const remove = await writeRequest(
      env,
      token,
      "DELETE",
      `/api/write/pages/${page.id}`
    )
    expect(remove.status).toBe(404)

    // 非成员空间（普通用户看不见）同样 404。
    const closed = await createSpace(env, admin, "非成员空间")
    const closedPage = await sessionCreatePage(env, admin, {
      title: "非成员页",
      spaceId: closed
    })
    const outsider = await writeRequest(
      env,
      token,
      "PUT",
      `/api/write/pages/${closedPage.id}`,
      { title: "越权" }
    )
    expect(outsider.status).toBe(404)
  })
})

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52
])

function formWith(bytes: Uint8Array, type: string): FormData {
  const form = new FormData()
  form.append("file", new File([bytes], "upload.bin", { type }))
  return form
}

function writeUpload(
  env: Env,
  token: string,
  form: FormData
): Promise<Response> {
  return request(env, "/api/write/files", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form
  })
}

/** 上传成功后的四键响应（与 `/api/import/files` 完全同形状）。 */
interface UploadedImage {
  key: string
  url: string
  contentType: string
  size: number
}

describe("写接口：图片上传（第五端点）", () => {
  it("write 令牌上传 PNG：201 四键、落 pages/、对象进图片桶", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)
    const { token } = await issueWriteToken(env, admin)

    const res = await writeUpload(env, token, formWith(PNG, "image/png"))
    expect(res.status).toBe(201)
    const image = (await res.json()) as UploadedImage
    // 精确四键：与 /api/import/files 同一份 handleImageUpload，不多不少。
    expect(Object.keys(image).sort()).toEqual([
      "contentType",
      "key",
      "size",
      "url"
    ])
    // 落正文图目录 pages/（与插件导入的 imports/ 分开）。
    expect(image.key).toMatch(/^pages\/[0-9a-f-]{36}\.png$/)
    expect(image.url).toBe(`/api/files/${image.key}`)
    expect(image.contentType).toBe("image/png")
    expect(image.size).toBe(PNG.length)
    expect(r2.store.has(image.key)).toBe(true)
  })

  it("只认 write 令牌：read 令牌、已吊销 write 令牌、导入令牌与会话 Cookie 全 401", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const readToken = await createApiToken(env, admin, "read")
    const importToken = await createImportToken(env, admin)
    const doomed = await issueWriteToken(env, admin)
    await jsonRequest(
      env,
      "DELETE",
      `/api/me/tokens/${doomed.id}`,
      undefined,
      admin
    )

    for (const token of [
      readToken.token,
      importToken.token,
      doomed.token,
      "not-a-token"
    ]) {
      const res = await writeUpload(env, token, formWith(PNG, "image/png"))
      expect(res.status).toBe(401)
      expect(res.headers.get("cache-control")).toContain("no-store")
    }

    const sessionOnly = await request(env, "/api/write/files", {
      method: "POST",
      headers: { cookie: admin },
      body: formWith(PNG, "image/png")
    })
    expect(sessionOnly.status).toBe(401)
  })

  it("上传不受令牌空间范围限制；非图片 400、超 10MB 413", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const defaultId = await defaultSpaceId(env, admin)
    const otherSpace = await createSpace(env, admin, "范围外空间")
    // 范围只给默认空间：上传仍然放行（文件没有空间维度）。
    const { token } = await issueWriteToken(env, admin, {
      spaceIds: [defaultId]
    })

    const ok = await writeUpload(env, token, formWith(PNG, "image/png"))
    expect(ok.status).toBe(201)

    const notImage = await writeUpload(
      env,
      token,
      formWith(
        new TextEncoder().encode("<svg onload=alert(1)></svg>"),
        "image/svg+xml"
      )
    )
    expect(notImage.status).toBe(400)

    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    big.set(PNG)
    const tooLarge = await writeUpload(env, token, formWith(big, "image/png"))
    expect(tooLarge.status).toBe(413)
    expect(await tooLarge.json()).toMatchObject({
      code: "FILE_TOO_LARGE",
      limitBytes: 10 * 1024 * 1024
    })

    // 但把这个文件引用到范围外空间建页仍按页面级权限 404。
    const image = (await ok.json()) as UploadedImage
    const outOfScope = await writeRequest(
      env,
      token,
      "POST",
      "/api/write/pages",
      {
        space_id: otherSpace,
        title: "范围外带图页",
        content_json: JSON.stringify({
          type: "doc",
          content: [{ type: "image", attrs: { src: image.url, alt: "图" } }]
        })
      }
    )
    expect(outOfScope.status).toBe(404)
    expect(await outOfScope.json()).toMatchObject({ code: "SPACE_NOT_FOUND" })
  })

  it("上传计入现有 write 桶（不新开桶）", async () => {
    const context = await initializedContext()
    const { env } = context
    const admin = await adminSession(env)
    const userId = await meId(env, admin)
    const { token } = await issueWriteToken(env, admin)

    const created = await writeUpload(env, token, formWith(PNG, "image/png"))
    expect(created.status).toBe(201)
    const counter = context.db.db
      .prepare(
        "SELECT count FROM ciki_auth_counters WHERE action = 'write' AND account = ?"
      )
      .get(String(userId)) as { count: number } | undefined
    expect(counter?.count).toBe(1)

    // 桶满后上传同样 429（与四个写端点共用一份额度）。
    context.db.db
      .prepare(
        "UPDATE ciki_auth_counters SET count = 600 WHERE action = 'write' AND account = ?"
      )
      .run(String(userId))
    const limited = await writeUpload(env, token, formWith(PNG, "image/png"))
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED" })
  })

  it("端到端：上传的地址写进 content_json 建页，读回 contentHtml 仍保留文件地址", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { token } = await issueWriteToken(env, admin)

    const uploaded = (await (
      await writeUpload(env, token, formWith(PNG, "image/png"))
    ).json()) as UploadedImage

    const created = await writeRequest(env, token, "POST", "/api/write/pages", {
      title: "带图页",
      content_json: JSON.stringify({
        type: "doc",
        content: [{ type: "image", attrs: { src: uploaded.url, alt: "图" } }]
      })
    })
    expect(created.status).toBe(201)
    const page = (await created.json()) as PageMeta

    const detail = await jsonRequest(
      env,
      "GET",
      `/api/pages/${page.id}`,
      undefined,
      admin
    )
    expect(detail.status).toBe(200)
    const body = (await detail.json()) as { contentHtml: string }
    // 消毒白名单认 pages/ 前缀：地址原样保留，不会降级成「未转存」占位。
    expect(body.contentHtml).toContain(uploaded.url)
    expect(body.contentHtml).not.toContain("data-original-src")
  })

  it("写接口：embed 上传（POST /api/write/files/embeds）与建页一条龙", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)
    const { token } = await issueWriteToken(env, admin)

    const html = "<!DOCTYPE html><html><body><h1>Animation</h1></body></html>"
    const htmlBytes = new TextEncoder().encode(html)
    const form = new FormData()
    form.append(
      "file",
      new File([htmlBytes], "anim.html", { type: "text/html" })
    )

    // 1. write 令牌上传
    const res = await request(env, "/api/write/files/embeds", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form
    })
    expect(res.status).toBe(201)
    const embed = (await res.json()) as UploadedImage
    expect(embed.key).toMatch(/^embeds\/[0-9a-f-]{36}\.html$/)
    expect(embed.url).toBe(`/api/files/${embed.key}`)
    expect(embed.contentType).toBe("text/html; charset=utf-8")
    expect(embed.size).toBe(htmlBytes.length)
    expect(r2.store.has(embed.key)).toBe(true)

    // 2. read 令牌与会话 Cookie 被拒 401
    const readToken = await createApiToken(env, admin, "read")
    const readRes = await request(env, "/api/write/files/embeds", {
      method: "POST",
      headers: { authorization: `Bearer ${readToken.token}` },
      body: form
    })
    expect(readRes.status).toBe(401)

    const sessionRes = await request(env, "/api/write/files/embeds", {
      method: "POST",
      headers: { cookie: admin },
      body: form
    })
    expect(sessionRes.status).toBe(401)

    // 3. 校验：非 .html 400，超 1MB 413
    const badForm = new FormData()
    badForm.append(
      "file",
      new File([htmlBytes], "anim.txt", { type: "text/plain" })
    )
    const badRes = await request(env, "/api/write/files/embeds", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: badForm
    })
    expect(badRes.status).toBe(400)

    const bigForm = new FormData()
    bigForm.append(
      "file",
      new File([new Uint8Array(1024 * 1024 + 1)], "big.html", {
        type: "text/html"
      })
    )
    const bigRes = await request(env, "/api/write/files/embeds", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: bigForm
    })
    expect(bigRes.status).toBe(413)

    // 4. 一条龙建页：在 content_json 中引用 htmlEmbed 节点
    const createPageRes = await writeRequest(
      env,
      token,
      "POST",
      "/api/write/pages",
      {
        title: "带 embed 动画页",
        content_json: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "htmlEmbed",
              attrs: {
                key: embed.key,
                height: 500,
                name: "anim.html"
              }
            }
          ]
        })
      }
    )
    expect(createPageRes.status).toBe(201)
    const page = (await createPageRes.json()) as PageMeta

    // 5. 会话读回：contentHtml 包含合法的 html-embed 载具，contentMd 包含派生链接
    const detail = await jsonRequest(
      env,
      "GET",
      `/api/pages/${page.id}`,
      undefined,
      admin
    )
    expect(detail.status).toBe(200)
    const detailBody = (await detail.json()) as {
      contentHtml: string
      contentMd: string
    }
    expect(detailBody.contentHtml).toContain('data-type="html-embed"')
    expect(detailBody.contentHtml).toContain(`data-key="${embed.key}"`)
    expect(detailBody.contentHtml).toContain('data-height="500"')
    expect(detailBody.contentHtml).toContain('data-name="anim.html"')
    expect(detailBody.contentMd).toContain(
      `[HTML 动画：anim.html](https://ciki.oneboy.app/api/files/${embed.key})`
    )
  })
})

describe("写接口：建空间 POST /api/write/spaces", () => {
  it("不限范围 write 令牌成功建空间，响应 201 精确三键，新空间归属令牌账号且自动成为 admin 成员", async () => {
    const context = await initializedContext()
    const { env, db } = context
    const admin = await adminSession(env)
    const userCookie = await userSession(env, admin, "creator@example.com")
    const userId = await meId(env, userCookie)
    const token = await issueWriteToken(env, userCookie)

    const res = await writeRequest(
      env,
      token.token,
      "POST",
      "/api/write/spaces",
      {
        title: "研发空间",
        description: "技术文档"
      }
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      id: number
      slug: string
      title: string
    }
    expect(Object.keys(body).sort()).toEqual(["id", "slug", "title"])
    expect(body.title).toBe("研发空间")
    expect(body.slug).toBe(`space-${body.id}`)

    // 验证 DB 空间行归属
    const space = db.db
      .prepare("SELECT * FROM ciki_spaces WHERE id = ?")
      .get(body.id) as { name: string; description: string; created_by: number }
    expect(space.name).toBe("研发空间")
    expect(space.description).toBe("技术文档")
    expect(space.created_by).toBe(userId)

    // 验证成员角色为 admin
    const member = db.db
      .prepare(
        "SELECT * FROM ciki_space_members WHERE space_id = ? AND user_id = ?"
      )
      .get(body.id, userId) as { role: string }
    expect(member.role).toBe("admin")
  })

  it("slug 由服务端按规则生成，冲突时递增后缀", async () => {
    const context = await initializedContext()
    const { env } = context
    const admin = await adminSession(env)
    const token = await issueWriteToken(env, admin)

    const res1 = await writeRequest(
      env,
      token.token,
      "POST",
      "/api/write/spaces",
      {
        title: "Research Lab"
      }
    )
    expect(res1.status).toBe(201)
    const body1 = (await res1.json()) as {
      id: number
      slug: string
      title: string
    }
    expect(body1.slug).toBe("research-lab")

    // 重名空间再次创建，slug 冲突递增
    const res2 = await writeRequest(
      env,
      token.token,
      "POST",
      "/api/write/spaces",
      {
        title: "Research Lab"
      }
    )
    expect(res2.status).toBe(201)
    const body2 = (await res2.json()) as {
      id: number
      slug: string
      title: string
    }
    expect(body2.id).not.toBe(body1.id)
    expect(body2.slug).toBe(`space-${body2.id}`)
  })

  it("参数校验：title 缺失/非法回 400 INVALID_SPACE_NAME，description 超限回 400 INVALID_SPACE_DESCRIPTION", async () => {
    const context = await initializedContext()
    const { env } = context
    const admin = await adminSession(env)
    const token = await issueWriteToken(env, admin)

    // 空请求体 / 缺少 title
    const emptyRes = await writeRequest(
      env,
      token.token,
      "POST",
      "/api/write/spaces",
      {}
    )
    expect(emptyRes.status).toBe(400)
    expect(await emptyRes.json()).toMatchObject({ code: "INVALID_SPACE_NAME" })

    // title 为空串或全空格
    const whitespaceRes = await writeRequest(
      env,
      token.token,
      "POST",
      "/api/write/spaces",
      {
        title: "   "
      }
    )
    expect(whitespaceRes.status).toBe(400)
    expect(await whitespaceRes.json()).toMatchObject({
      code: "INVALID_SPACE_NAME"
    })

    // title 超过 64 字符
    const tooLongTitleRes = await writeRequest(
      env,
      token.token,
      "POST",
      "/api/write/spaces",
      {
        title: "a".repeat(65)
      }
    )
    expect(tooLongTitleRes.status).toBe(400)
    expect(await tooLongTitleRes.json()).toMatchObject({
      code: "INVALID_SPACE_NAME"
    })

    // description 超过 500 字符
    const tooLongDescRes = await writeRequest(
      env,
      token.token,
      "POST",
      "/api/write/spaces",
      {
        title: "合法名称",
        description: "d".repeat(501)
      }
    )
    expect(tooLongDescRes.status).toBe(400)
    expect(await tooLongDescRes.json()).toMatchObject({
      code: "INVALID_SPACE_DESCRIPTION"
    })
  })

  it("隔离矩阵：受限范围 write 令牌回 403 Forbidden", async () => {
    const context = await initializedContext()
    const { env } = context
    const admin = await adminSession(env)
    const restrictedToken = await issueWriteToken(env, admin, { spaceIds: [1] })

    const res = await writeRequest(
      env,
      restrictedToken.token,
      "POST",
      "/api/write/spaces",
      { title: "受限令牌建空间" }
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })
  })

  it("隔离矩阵：read 令牌、导入令牌、会话 Cookie、匿名访问一律 401", async () => {
    const context = await initializedContext()
    const { env } = context
    const admin = await adminSession(env)

    // read 令牌
    const readToken = await createApiToken(env, admin, "read")
    const readRes = await writeRequest(
      env,
      readToken.token,
      "POST",
      "/api/write/spaces",
      { title: "只读令牌尝试建空间" }
    )
    expect(readRes.status).toBe(401)
    expect(readRes.headers.get("cache-control")).toContain("no-store")

    // 导入令牌
    const importToken = await createImportToken(env, admin)
    const importRes = await writeRequest(
      env,
      importToken.token,
      "POST",
      "/api/write/spaces",
      { title: "导入令牌尝试建空间" }
    )
    expect(importRes.status).toBe(401)

    // 仅会话 Cookie（无 Bearer 令牌）
    const sessionRes = await jsonRequest(
      env,
      "POST",
      "/api/write/spaces",
      { title: "会话尝试调用写接口建空间" },
      admin
    )
    expect(sessionRes.status).toBe(401)

    // 匿名
    const anonRes = await request(env, "/api/write/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "匿名建空间" })
    })
    expect(anonRes.status).toBe(401)
  })
})
