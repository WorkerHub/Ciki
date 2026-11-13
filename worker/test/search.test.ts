import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  userSession
} from "./support/app"

interface SearchResult {
  query: string
  results: Array<{
    pageId: string
    title: string
    snippet: string
    updatedAt: string
    spaceId: string
    spaceName: string
  }>
}

async function createPage(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  title: string,
  contentText: string
) {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/pages",
    {
      title,
      parentId: null,
      contentJson: JSON.stringify({ type: "doc" }),
      contentHtml: `<p>${contentText}</p>`,
      contentText
    },
    cookie
  )
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string; title: string }
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

describe("搜索：CJK 两字命中、改名/改文更新、软删排除", () => {
  it("保存后可用两字中文搜到，片段为纯文本", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createPage(
      env,
      admin,
      "团队知识库",
      "这是团队协作与知识沉淀的正文内容"
    )

    const result = await search(env, admin, "团队")
    expect(result.query).toBe("团队")
    expect(result.results.map((item) => item.pageId)).toEqual([page.id])
    expect(result.results[0].title).toBe("团队知识库")
    expect(result.results[0].snippet).toContain("团队")
    expect(result.results[0].snippet).not.toContain("<")
  })

  it("拉丁词按前缀命中", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await createPage(env, admin, "API Guide", "ciki search works fine")

    const result = await search(env, admin, "cik")
    expect(result.results).toHaveLength(1)
    expect(result.results[0].title).toBe("API Guide")
  })

  it("改名/改文后索引更新；不再匹配旧内容", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createPage(env, admin, "旧标题", "旧的正文内容")
    expect((await search(env, admin, "旧标题")).results).toHaveLength(1)

    const update = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      {
        title: "新标题",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>新的正文</p>",
        contentText: "新的正文"
      },
      admin
    )
    expect(update.status).toBe(200)

    expect((await search(env, admin, "旧标题")).results).toHaveLength(0)
    expect((await search(env, admin, "新标题")).results).toHaveLength(1)
    expect((await search(env, admin, "新的正文")).results).toHaveLength(1)
  })

  it("软删后不出现；恢复后重现", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createPage(env, admin, "可恢复页面", "可恢复的正文")

    await jsonRequest(env, "DELETE", `/api/pages/${page.id}`, undefined, admin)
    expect((await search(env, admin, "可恢复页面")).results).toHaveLength(0)

    await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/restore`,
      undefined,
      admin
    )
    expect((await search(env, admin, "可恢复页面")).results).toHaveLength(1)
  })

  it("空词或只有标点返回空结果", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    expect((await search(env, admin, "   ")).results).toEqual([])
    expect((await search(env, admin, "!!!")).results).toEqual([])
  })
})

describe("搜索：片段与标题必须是纯文本", () => {
  it("恶意 contentText / title 不会以 HTML 形式回显", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await createPage(
      env,
      admin,
      "团队页面",
      "<img src=x onerror=alert(1)>团队知识"
    )

    const result = await search(env, admin, "团队")
    expect(result.results).toHaveLength(1)
    const hit = result.results[0]
    expect(hit.snippet).not.toContain("<")
    expect(hit.snippet).not.toContain(">")
    expect(hit.snippet).not.toContain("onerror")
    expect(hit.snippet).toContain("团队知识")
    expect(hit.title).not.toContain("<")
  })
})

describe("搜索：空间过滤与标注", () => {
  it("非成员空间的命中不出现；成员结果带 spaceId/spaceName", async () => {
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

    const pageRes = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        title: "机密标题",
        spaceId: space.id,
        parentId: null,
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>专属关键词</p>",
        contentText: "专属关键词"
      },
      admin
    )
    expect(pageRes.status).toBe(201)

    const invisible = await search(env, user, "专属关键词")
    expect(invisible.results).toEqual([])
    expect(JSON.stringify(invisible)).not.toContain("机密标题")

    const visible = await search(env, admin, "专属关键词")
    expect(visible.results).toHaveLength(1)
    expect(visible.results[0]).toMatchObject({
      title: "机密标题",
      spaceId: space.id,
      spaceName: "机密空间"
    })
  })
})

describe("搜索：新建页的索引行按页面 id 写入", () => {
  it("先保存一页让版本 rowid 与页面 id 错位，再新建的页面仍按自己的标题搜到自己", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const older = await createPage(env, admin, "旧页面", "旧的正文")
    // 保存一次：该页产生第二条版本，此后新建页面的版本 rowid 会领先于页面 id。
    const saved = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${older.id}`,
      {
        title: "旧页面",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>旧的正文改</p>",
        contentText: "旧的正文改"
      },
      admin
    )
    expect(saved.status).toBe(200)
    const fresh = await createPage(env, admin, "新页面", "新的正文")

    // 新页按自己的标题搜到自己，且只命中自己。
    expect(
      (await search(env, admin, "新页面")).results.map((hit) => hit.pageId)
    ).toEqual([fresh.id])
    // 旧页仍按自己的标题搜到自己。
    expect(
      (await search(env, admin, "旧页面")).results.map((hit) => hit.pageId)
    ).toEqual([older.id])

    // 索引行的 page_id 必须等于真实页面 id，且没有指向不存在页面的行。
    const rows = db.db
      .prepare("SELECT page_id FROM ciki_pages_fts")
      .all() as Array<{ page_id: number }>
    expect(
      rows.map((row) => Number(row.page_id)).sort((a, b) => a - b)
    ).toEqual([Number(older.id), Number(fresh.id)].sort((a, b) => a - b))
    const orphans = db.db
      .prepare(
        "SELECT COUNT(*) AS count FROM ciki_pages_fts WHERE page_id NOT IN (SELECT id FROM ciki_pages)"
      )
      .get() as { count: number }
    expect(orphans.count).toBe(0)
  })
})
