import { describe, expect, it } from "vitest"
import { adminSession, initializedContext, jsonRequest } from "./support/app"

interface SearchResult {
  query: string
  results: Array<{
    pageId: string
    title: string
    snippet: string
    updatedAt: string
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
