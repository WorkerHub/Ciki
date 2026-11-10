/**
 * 三个只读接口（规格一期 §二.3）：冻结契约逐字核对 + 可见性 + 软删排除 + 双向令牌隔离。
 *
 * 字段是 snake_case（`parent_id` / `updated_at` / `created_at` / `content_json`）——这是
 * 用户冻结的契约，Muse 连接器按此接入，所以这里断言的是**精确的键集合**，多一个少一个
 * 都算破坏契约。
 */
import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"
import type { Env } from "../src/types"

const READ_TOKEN_PATH = "/api/me/read-token"
const IMPORT_TOKEN_PATH = "/api/me/import-token"

const TREE_KEYS = ["id", "parent_id", "title", "updated_at"]
const SEARCH_KEYS = ["id", "snippet", "title", "updated_at"]

async function readToken(env: Env, cookie: string): Promise<string> {
  const res = await jsonRequest(env, "POST", READ_TOKEN_PATH, {}, cookie)
  expect(res.status).toBe(200)
  return ((await res.json()) as { token: string }).token
}

function readGet(env: Env, token: string, path: string): Promise<Response> {
  return request(env, path, { headers: { authorization: `Bearer ${token}` } })
}

interface TreeEntry {
  id: string
  title: string
  parent_id: string | null
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
  input: { title: string; text?: string; spaceId?: string }
): Promise<{ id: string; title: string }> {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/pages",
    {
      title: input.title,
      parentId: null,
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
    const { env } = await initializedContext()
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
    const { env } = await initializedContext()
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
      "title",
      "updated_at"
    ])
    expect(markdownBody.markdown).toBe("接口正文")
    expect(markdownBody.title).toBe("接口页")
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
      "title",
      "updated_at"
    ])
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
    expect((await tree(env, adminToken)).map((entry) => entry.id)).toContain(
      secret.id
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
    const importToken = (await (
      await jsonRequest(env, "POST", IMPORT_TOKEN_PATH, {}, admin)
    ).json()) as { token: string }
    const token = await readToken(env, admin)

    // 导入令牌 → 读接口：按说被只读令牌中间件拒。
    for (const path of [
      "/api/read/tree",
      "/api/read/search?q=x",
      "/api/read/pages/whatever"
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
