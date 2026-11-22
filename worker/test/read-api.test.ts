/**
 * 三个只读接口（规格一期 §二.3）：冻结契约逐字核对 + 可见性 + 软删排除 + 双向令牌隔离。
 *
 * 字段是 snake_case（`parent_id` / `space_id` / `sort_order` / `updated_at` /
 * `created_at` / `content_json`）——这是用户冻结的契约，Muse 连接器按此接入，所以这里
 * 断言的是**精确的键集合**，多一个少一个都算破坏契约。
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

const TREE_KEYS = [
  "id",
  "parent_id",
  "sort_order",
  "space_id",
  "title",
  "updated_at"
]
const SEARCH_KEYS = ["id", "snippet", "title", "updated_at"]

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52
])

function formWith(
  bytes: Uint8Array,
  type: string,
  filename = "upload.bin"
): FormData {
  const form = new FormData()
  form.append("file", new File([bytes], filename, { type }))
  return form
}

function uploadFile(
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

async function readToken(env: Env, cookie: string): Promise<string> {
  return (await createApiToken(env, cookie, "read")).token
}

function readGet(env: Env, token: string, path: string): Promise<Response> {
  return request(env, path, { headers: { authorization: `Bearer ${token}` } })
}

interface TreeEntry {
  id: string
  title: string
  parent_id: string | null
  space_id: number
  sort_order: number
  updated_at: string
}

async function tree(env: Env, token: string): Promise<TreeEntry[]> {
  const res = await readGet(env, token, "/api/read/tree")
  expect(res.status).toBe(200)
  return (await res.json()) as TreeEntry[]
}

async function search(
  env: Env,
  token: string,
  query: string
): Promise<
  Array<{ id: string; title: string; snippet: string; updated_at: string }>
> {
  const res = await readGet(
    env,
    token,
    `/api/read/search?q=${encodeURIComponent(query)}`
  )
  expect(res.status).toBe(200)
  return (await res.json()) as Array<{
    id: string
    title: string
    snippet: string
    updated_at: string
  }>
}

async function createPage(
  env: Env,
  cookie: string,
  input: {
    title: string
    text?: string
    spaceId?: string
    parentId?: string
  }
): Promise<{ id: string; title: string }> {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/pages",
    {
      title: input.title,
      parentId: input.parentId ?? null,
      spaceId: input.spaceId ?? null,
      contentJson: JSON.stringify({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: input.text ?? input.title }]
          }
        ]
      }),
      contentHtml: `<p>${input.text ?? input.title}</p>`,
      contentText: input.text ?? input.title
    },
    cookie
  )
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string; title: string }
}

describe("只读接口：鉴权只认只读令牌", () => {
  it("没有令牌、只有会话 Cookie、或令牌无效都回 401（且 no-store）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const token = await readToken(env, admin)

    const anonymous = await request(env, "/api/read/tree")
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get("cache-control")).toContain("no-store")

    // 会话 Cookie 不认：读接口的调用方是外部连接器，职责分离。
    const sessionOnly = await jsonRequest(
      env,
      "GET",
      "/api/read/tree",
      undefined,
      admin
    )
    expect(sessionOnly.status).toBe(401)

    const bogus = await readGet(env, "not-a-real-token", "/api/read/tree")
    expect(bogus.status).toBe(401)

    expect((await readGet(env, token, "/api/read/tree")).status).toBe(200)
  })
})

describe("只读接口：tree", () => {
  it("字段是冻结契约的 snake_case 键集合；软删页面不出现", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const token = await readToken(env, admin)
    const kept = await createPage(env, admin, { title: "保留页" })
    const dropped = await createPage(env, admin, { title: "删除页" })
    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${dropped.id}`,
      undefined,
      admin
    )

    const entries = await tree(env, token)
    const ids = entries.map((entry) => entry.id)
    expect(ids).toContain(kept.id)
    expect(ids).not.toContain(dropped.id)

    const entry = entries.find((item) => item.id === kept.id)
    expect(entry).toBeDefined()
    expect(Object.keys(entry ?? {}).sort()).toEqual(TREE_KEYS)
    expect(entry?.title).toBe("保留页")
    expect(entry?.parent_id).toBeNull()
    const row = db.db
      .prepare("SELECT space_id, sort_order FROM ciki_pages WHERE id = ?")
      .get(Number(kept.id)) as { space_id: number; sort_order: number }
    expect(entry?.space_id).toBe(row.space_id)
    expect(entry?.sort_order).toBe(row.sort_order)
  })

  it("同父级下 sort_order 与数组次序一致，两字段始终等于库值", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const token = await readToken(env, admin)
    const parent = await createPage(env, admin, { title: "父页" })
    const first = await createPage(env, admin, {
      title: "甲",
      parentId: parent.id
    })
    const second = await createPage(env, admin, {
      title: "乙",
      parentId: parent.id
    })

    // 把第二个子页拖到同级最前：move 把该组整组重排成 0..n-1。
    const moved = await jsonRequest(
      env,
      "POST",
      `/api/pages/${second.id}/move`,
      { parentId: parent.id, sortOrder: 0 },
      admin
    )
    expect(moved.status).toBe(200)

    const entries = await tree(env, token)
    const siblings = entries.filter((entry) => entry.parent_id === parent.id)
    expect(siblings.map((entry) => entry.id)).toEqual([second.id, first.id])
    expect(siblings.map((entry) => entry.sort_order)).toEqual([0, 1])

    // 全树不变量：同一 (space_id, parent_id) 组内 sort_order 随数组次序严格递增，
    // 且每一项都与库里的值一致。
    entries.forEach((entry, index) => {
      const row = db.db
        .prepare("SELECT space_id, sort_order FROM ciki_pages WHERE id = ?")
        .get(entry.id) as { space_id: number; sort_order: number }
      expect(entry.space_id).toBe(row.space_id)
      expect(entry.sort_order).toBe(row.sort_order)

      const previous = entries[index - 1]
      if (
        previous &&
        previous.parent_id === entry.parent_id &&
        previous.space_id === entry.space_id
      ) {
        expect(previous.sort_order).toBeLessThan(entry.sort_order)
      }
    })
  })
})

describe("只读接口：search", () => {
  it("与站内搜索同口径（同一批命中、同一支 bm25 排序），上限 20 条", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const token = await readToken(env, admin)
    const page = await createPage(env, admin, {
      title: "团队知识库",
      text: "这是团队协作与知识沉淀的正文"
    })

    const hits = await search(env, token, "团队")
    expect(Object.keys(hits[0]).sort()).toEqual(SEARCH_KEYS)
    expect(hits.map((hit) => hit.id)).toContain(page.id)
    expect(hits[0].snippet).not.toContain("<")

    // 与站内搜索（会话口径）结果同口径。
    const site = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/search?q=%E5%9B%A2%E9%98%9F",
        undefined,
        admin
      )
    ).json()) as { results: Array<{ pageId: string }> }
    expect(hits.map((hit) => hit.id)).toEqual(
      site.results.map((hit) => hit.pageId)
    )

    // 上限 20：造 25 条同词页面。
    for (let index = 0; index < 25; index += 1) {
      await createPage(env, admin, {
        title: `批量页面 ${index}`,
        text: "批量关键词 内容"
      })
    }
    expect(await search(env, token, "批量关键词")).toHaveLength(20)

    // 空词/纯标点：空数组，不报错。
    expect(await search(env, token, "")).toEqual([])
    expect(await search(env, token, "!!!")).toEqual([])
  })

  it("软删页面搜不到", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const token = await readToken(env, admin)
    const page = await createPage(env, admin, {
      title: "可恢复页面",
      text: "可恢复的正文"
    })
    await jsonRequest(env, "DELETE", `/api/pages/${page.id}`, undefined, admin)
    expect(await search(env, token, "可恢复页面")).toEqual([])
  })
})

describe("只读接口：pages/:id", () => {
  it("默认给 markdown；?format=json 给 content_json；已删/不存在 404", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const token = await readToken(env, admin)
    const page = await createPage(env, admin, {
      title: "接口页",
      text: "接口正文"
    })

    const markdownRes = await readGet(env, token, `/api/read/pages/${page.id}`)
    expect(markdownRes.status).toBe(200)
    const markdownBody = (await markdownRes.json()) as Record<string, unknown>
    expect(Object.keys(markdownBody).sort()).toEqual([
      "created_at",
      "id",
      "markdown",
      "parent_id",
      "sort_order",
      "space_id",
      "title",
      "updated_at"
    ])
    expect(markdownBody.markdown).toBe("接口正文")
    expect(markdownBody.title).toBe("接口页")
    const row = db.db
      .prepare("SELECT space_id, sort_order FROM ciki_pages WHERE id = ?")
      .get(Number(page.id)) as { space_id: number; sort_order: number }
    expect(markdownBody.space_id).toBe(row.space_id)
    expect(markdownBody.sort_order).toBe(row.sort_order)
    // content_md 不含标题行（下载时由前端拼一级标题）。
    expect(String(markdownBody.markdown)).not.toContain("# 接口页")

    const jsonRes = await readGet(
      env,
      token,
      `/api/read/pages/${page.id}?format=json`
    )
    expect(jsonRes.status).toBe(200)
    const jsonBody = (await jsonRes.json()) as Record<string, unknown>
    expect(Object.keys(jsonBody).sort()).toEqual([
      "content_json",
      "created_at",
      "id",
      "parent_id",
      "sort_order",
      "space_id",
      "title",
      "updated_at"
    ])
    expect(jsonBody.space_id).toBe(row.space_id)
    expect(jsonBody.sort_order).toBe(row.sort_order)
    expect(jsonBody.markdown).toBeUndefined()
    expect(JSON.parse(String(jsonBody.content_json))).toMatchObject({
      type: "doc"
    })

    const missing = await readGet(env, token, "/api/read/pages/不存在的页面")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: "Page not found" })

    await jsonRequest(env, "DELETE", `/api/pages/${page.id}`, undefined, admin)
    const deleted = await readGet(env, token, `/api/read/pages/${page.id}`)
    expect(deleted.status).toBe(404)
  })
})

describe("只读接口：空间可见性 = 令牌持有人的读权限", () => {
  it("非成员空间：tree / search / get 三处都不出现", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)

    const spaceRes = await jsonRequest(
      env,
      "POST",
      "/api/spaces",
      { name: "机密空间" },
      admin
    )
    expect(spaceRes.status).toBe(201)
    const space = (await spaceRes.json()) as { id: string }
    const secret = await createPage(env, admin, {
      title: "机密标题",
      text: "专属关键词",
      spaceId: space.id
    })

    // 站点管理员（令牌持有人）看得到全部空间。
    const adminToken = await readToken(env, admin)
    const adminTree = await tree(env, adminToken)
    expect(adminTree.map((entry) => entry.id)).toContain(secret.id)
    // space_id 透传页面真实所属空间，不会被写成默认空间。
    expect(adminTree.find((entry) => entry.id === secret.id)?.space_id).toBe(
      Number(space.id)
    )
    expect(
      (await search(env, adminToken, "专属关键词")).map((hit) => hit.id)
    ).toContain(secret.id)

    // 普通成员（只在默认空间）看不到。
    const userToken = await readToken(env, user)
    expect((await tree(env, userToken)).map((entry) => entry.id)).not.toContain(
      secret.id
    )
    expect(await search(env, userToken, "专属关键词")).toEqual([])
    const denied = await readGet(env, userToken, `/api/read/pages/${secret.id}`)
    expect(denied.status).toBe(404)
    expect(JSON.stringify(await denied.json())).not.toContain("机密标题")
  })
})

describe("双向令牌隔离（服务端校验，不靠前端）", () => {
  it("导入令牌调读接口 401；只读令牌调导入接口与写接口 401", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const importToken = await createImportToken(env, admin)
    const token = await readToken(env, admin)

    // 导入令牌 → 读接口：按说被读接口中间件拒（两张表都不含它的哈希）。
    for (const path of [
      "/api/read/spaces",
      "/api/read/tree",
      "/api/read/search?q=x",
      "/api/read/pages/whatever",
      "/api/read/files/pages/0f3c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b.png"
    ]) {
      const res = await request(env, path, {
        headers: { authorization: `Bearer ${importToken.token}` }
      })
      expect(res.status).toBe(401)
    }

    // 只读令牌 → 导入接口：被导入令牌中间件拒。
    for (const path of ["/api/import/parents", "/api/import/spaces"]) {
      const res = await request(env, path, {
        headers: { authorization: `Bearer ${token}` }
      })
      expect(res.status).toBe(401)
    }

    // 只读令牌 → 会话写接口：会话中间件不认 Bearer，同样 401。
    const write = await request(env, "/api/pages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "偷写",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "",
        contentText: ""
      })
    })
    expect(write.status).toBe(401)
  })
})

describe("只读接口：GET /api/read/files/:key", () => {
  it("本人可用 read 令牌与 write 令牌读回文件（200 + 字节一致 + 响应头一致 + 刷新 last_used_at）", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const writeTokenObj = await createApiToken(env, admin, "write")
    const readTokenObj = await createApiToken(env, admin, "read")

    // 1. 上传图片（PNG）
    const uploadRes = await uploadFile(
      env,
      writeTokenObj.token,
      formWith(PNG, "image/png", "sample.png")
    )
    expect(uploadRes.status).toBe(201)
    const image = (await uploadRes.json()) as { key: string; url: string }

    // 用 read 令牌读回
    const readRes = await readGet(
      env,
      readTokenObj.token,
      `/api/read/files/${image.key}`
    )
    expect(readRes.status).toBe(200)
    expect(readRes.headers.get("content-type")).toBe("image/png")
    expect(readRes.headers.get("content-length")).toBe(String(PNG.length))
    expect(readRes.headers.get("cache-control")).toContain("private")
    expect(readRes.headers.get("etag")).toBeTruthy()
    const readBytes = new Uint8Array(await readRes.arrayBuffer())
    expect(readBytes).toEqual(PNG)

    // 验证 read 令牌 last_used_at 已刷新
    const readRow = db.db
      .prepare("SELECT last_used_at FROM ciki_api_tokens WHERE id = ?")
      .get(readTokenObj.id) as { last_used_at: string | null }
    expect(readRow.last_used_at).not.toBeNull()

    // 用 write 令牌读回
    const writeRes = await readGet(
      env,
      writeTokenObj.token,
      `/api/read/files/${image.key}`
    )
    expect(writeRes.status).toBe(200)
    const writeBytes = new Uint8Array(await writeRes.arrayBuffer())
    expect(writeBytes).toEqual(PNG)

    // 2. 上传 Excalidraw 场景 JSON
    const sceneJson = JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {}
    })
    const jsonUploadRes = await uploadFile(
      env,
      writeTokenObj.token,
      formWith(
        new TextEncoder().encode(sceneJson),
        "application/json",
        "scene.json"
      )
    )
    expect(jsonUploadRes.status).toBe(201)
    const sceneImage = (await jsonUploadRes.json()) as {
      key: string
      url: string
    }

    const sceneReadRes = await readGet(
      env,
      readTokenObj.token,
      `/api/read/files/${sceneImage.key}`
    )
    expect(sceneReadRes.status).toBe(200)
    expect(sceneReadRes.headers.get("content-type")).toBe("application/json")
    const sceneText = await sceneReadRes.text()
    expect(JSON.parse(sceneText)).toMatchObject({
      type: "excalidraw",
      version: 2
    })
  })

  it("跨账号归属校验：读他人上传的文件一律 404（不泄露存在性）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin, "other@example.com")

    const adminWriteToken = await createApiToken(env, admin, "write")
    const userReadToken = await createApiToken(env, user, "read")
    const userWriteToken = await createApiToken(env, user, "write")

    // Admin 上传文件
    const uploadRes = await uploadFile(
      env,
      adminWriteToken.token,
      formWith(PNG, "image/png", "admin.png")
    )
    expect(uploadRes.status).toBe(201)
    const image = (await uploadRes.json()) as { key: string }

    // Other user 尝试用 read 令牌和 write 令牌读取 Admin 的文件
    const userRead = await readGet(
      env,
      userReadToken.token,
      `/api/read/files/${image.key}`
    )
    expect(userRead.status).toBe(404)
    expect(await userRead.json()).toEqual({ error: "File not found" })

    const userWrite = await readGet(
      env,
      userWriteToken.token,
      `/api/read/files/${image.key}`
    )
    expect(userWrite.status).toBe(404)
    expect(await userWrite.json()).toEqual({ error: "File not found" })
  })

  it("无元数据存量对象、对象不存在、key 形状非法一律 404", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)
    const token = await readToken(env, admin)
    const id = "0f3c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b"

    // 存量对象无 customMetadata 或无 uploaderId
    await r2.put(`pages/${id}.png`, PNG, {
      httpMetadata: { contentType: "image/png" }
    })
    const noMeta = await readGet(env, token, `/api/read/files/pages/${id}.png`)
    expect(noMeta.status).toBe(404)
    expect(await noMeta.json()).toEqual({ error: "File not found" })

    // 对象不存在
    const missing = await readGet(
      env,
      token,
      `/api/read/files/pages/11111111-2222-3333-4444-555555555555.png`
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: "File not found" })

    // key 形状非法
    for (const badKey of [
      `misc/${id}.png`,
      `pages/sub/${id}.png`,
      `pages/${id}.svg`,
      `pages/${id.toUpperCase()}.png`,
      "invalid-key"
    ]) {
      const bad = await readGet(env, token, `/api/read/files/${badKey}`)
      expect(bad.status).toBe(404)
      expect(await bad.json()).toEqual({ error: "File not found" })
    }
  })

  it("鉴权分支：无令牌、会话 Cookie、导入令牌、无效令牌、已吊销、被停用/未批准用户全 401（且带 no-store）", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const adminToken = await createApiToken(env, admin, "write")

    // 上传一个文件
    const uploadRes = await uploadFile(
      env,
      adminToken.token,
      formWith(PNG, "image/png")
    )
    const { key } = (await uploadRes.json()) as { key: string }

    // 1. 无令牌
    const anon = await request(env, `/api/read/files/${key}`)
    expect(anon.status).toBe(401)
    expect(anon.headers.get("cache-control")).toContain("no-store")

    // 2. 只有会话 Cookie
    const cookieOnly = await request(env, `/api/read/files/${key}`, {
      headers: { cookie: admin }
    })
    expect(cookieOnly.status).toBe(401)
    expect(cookieOnly.headers.get("cache-control")).toContain("no-store")

    // 3. 导入令牌
    const importToken = await createImportToken(env, admin)
    const importRes = await request(env, `/api/read/files/${key}`, {
      headers: { authorization: `Bearer ${importToken.token}` }
    })
    expect(importRes.status).toBe(401)
    expect(importRes.headers.get("cache-control")).toContain("no-store")

    // 4. 无效令牌
    const invalidRes = await request(env, `/api/read/files/${key}`, {
      headers: { authorization: "Bearer invalid-token-string" }
    })
    expect(invalidRes.status).toBe(401)
    expect(invalidRes.headers.get("cache-control")).toContain("no-store")

    // 5. 已吊销令牌
    const doomedToken = await createApiToken(env, admin, "read")
    await jsonRequest(
      env,
      "DELETE",
      `/api/me/tokens/${doomedToken.id}`,
      undefined,
      admin
    )
    const revokedRes = await request(env, `/api/read/files/${key}`, {
      headers: { authorization: `Bearer ${doomedToken.token}` }
    })
    expect(revokedRes.status).toBe(401)
    expect(revokedRes.headers.get("cache-control")).toContain("no-store")

    // 6. 用户被停用
    const userCookie = await userSession(env, admin, "deactivated@example.com")
    const userToken = await createApiToken(env, userCookie, "read")
    db.db
      .prepare("UPDATE ciki_users SET is_active = 0 WHERE email = ?")
      .run("deactivated@example.com")
    const deactivatedRes = await request(env, `/api/read/files/${key}`, {
      headers: { authorization: `Bearer ${userToken.token}` }
    })
    expect(deactivatedRes.status).toBe(401)
    expect(deactivatedRes.headers.get("cache-control")).toContain("no-store")
  })

  it("会话端点 GET /api/files/:key 回归正常：保持无归属校验且需会话", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin, "user2@example.com")
    const adminToken = await createApiToken(env, admin, "write")

    // Admin 上传
    const uploadRes = await uploadFile(
      env,
      adminToken.token,
      formWith(PNG, "image/png")
    )
    const { key } = (await uploadRes.json()) as { key: string }

    // Admin 会话可读
    const adminSessionRead = await request(env, `/api/files/${key}`, {
      headers: { cookie: admin }
    })
    expect(adminSessionRead.status).toBe(200)

    // User 会话也可读（会话端点供页面展示，不设归属拦截）
    const userSessionRead = await request(env, `/api/files/${key}`, {
      headers: { cookie: user }
    })
    expect(userSessionRead.status).toBe(200)

    // 匿名请求会话端点回 401
    const anon = await request(env, `/api/files/${key}`)
    expect(anon.status).toBe(401)
  })
})
