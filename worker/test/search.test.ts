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
  contentText: string,
  spaceId?: string
) {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/pages",
    {
      title,
      ...(spaceId ? { spaceId } : {}),
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
  query: string,
  limit?: number
): Promise<SearchResult> {
  const res = await jsonRequest(
    env,
    "GET",
    `/api/search?q=${encodeURIComponent(query)}${limit ? `&limit=${limit}` : ""}`,
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

describe("搜索：纯数字按页面编号置顶", () => {
  it("编号命中置顶，即使标题与正文都不含这串数字", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createPage(env, admin, "发布流程", "与编号无关的正文")

    const result = await search(env, admin, page.id)
    expect(result.results.map((item) => item.pageId)).toEqual([page.id])
    expect(result.results[0]).toMatchObject({
      title: "发布流程",
      spaceName: "默认空间"
    })

    // 置顶不越界：总数仍不超过 limit
    const single = await search(env, admin, page.id, 1)
    expect(single.results.map((item) => item.pageId)).toEqual([page.id])
  })

  it("与 FTS 命中重合时只出现一次，且编号命中在最前", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const target = await createPage(env, admin, "周会纪要", "无关正文")
    // 标题里带上目标页的编号：这条会被 FTS 词法命中，编号查也命中
    const other = await createPage(
      env,
      admin,
      `${target.id} 号笔记`,
      "编号出现在标题里"
    )

    const result = await search(env, admin, target.id)
    const ids = result.results.map((item) => item.pageId)
    expect(ids[0]).toBe(target.id)
    expect(ids.filter((id) => id === target.id)).toHaveLength(1)
    expect(ids).toContain(other.id)
  })

  it("无权空间的页面按编号也查不到", async () => {
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
    const secret = await createPage(
      env,
      admin,
      "机密编号页",
      "专属正文",
      space.id
    )

    const invisible = await search(env, user, secret.id)
    expect(invisible.results).toEqual([])
    expect(JSON.stringify(invisible)).not.toContain("机密编号页")

    const visible = await search(env, admin, secret.id)
    expect(visible.results[0]).toMatchObject({
      pageId: secret.id,
      title: "机密编号页",
      spaceName: "机密空间"
    })
  })

  it("已软删的页面按编号查不到", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createPage(env, admin, "待删除页", "待删除正文")

    await jsonRequest(env, "DELETE", `/api/pages/${page.id}`, undefined, admin)
    const result = await search(env, admin, page.id)
    expect(result.results.map((item) => item.pageId)).not.toContain(page.id)
  })

  it("非数字查询不受编号规则影响", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const first = await createPage(env, admin, "部署手册", "部署的正文")
    const second = await createPage(env, admin, "部署记录", "部署的历史")

    const result = await search(env, admin, "部署")
    expect(result.results.map((item) => item.pageId).sort()).toEqual(
      [first.id, second.id].sort()
    )
  })
})
