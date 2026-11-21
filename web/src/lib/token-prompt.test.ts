import { describe, expect, it } from "vitest"
import { buildIntegrationPrompt } from "@/lib/token-prompt"

describe("buildIntegrationPrompt", () => {
  const SPACES = [
    { id: 1, name: "默认空间" },
    { id: 2, name: "研发空间" }
  ]

  it("中文只读 Token + 全部空间", () => {
    const prompt = buildIntegrationPrompt({
      lang: "zh-CN",
      origin: "https://wiki.example.com",
      kind: "read",
      spaceIds: null,
      spaces: SPACES
    })

    expect(prompt).toContain(
      "请把这个 Ciki 知识库接入你的工具集，之后我让你查资料、记内容时用它。"
    )
    expect(prompt).toContain("- 实例地址：https://wiki.example.com")
    expect(prompt).toContain(
      "- API Token：`{{CIKI_API_TOKEN}}`（占位符，Token 我随后单独发给你；收到后替换占位符，所有请求带请求头 `Authorization: Bearer <Token>`）"
    )
    expect(prompt).toContain("- 令牌权限：只读，范围：全部空间")
    expect(prompt).toContain(
      "常用接口：列空间与页面树（GET /api/read/spaces、GET /api/read/tree）、按 ID 读页面正文（GET /api/read/pages/:id）、全文搜索（GET /api/read/search）。"
    )
    expect(prompt).not.toContain("/api/write")
    expect(prompt).toContain(
      "先调一次列空间接口验证连通，再按我的指令读写。Token 不要写进任何公开文件、代码仓库或对外回复里。"
    )
    // 绝不包含明文
    expect(prompt).not.toContain("ciki_")
  })

  it("中文读写 Token + 指定空间", () => {
    const prompt = buildIntegrationPrompt({
      lang: "zh",
      origin: "https://wiki.example.com",
      kind: "write",
      spaceIds: [1, 2, 99],
      spaces: SPACES
    })

    expect(prompt).toContain(
      "- 令牌权限：读写，范围：指定空间：默认空间、研发空间、未知空间(#99)"
    )
    expect(prompt).toContain(
      "常用接口：列空间与页面树（GET /api/read/spaces、GET /api/read/tree）、按 ID 读页面正文（GET /api/read/pages/:id）、全文搜索（GET /api/read/search）；新建与更新页面（POST /api/write/pages、PUT /api/write/pages/:id）。"
    )
    // 用户约束：不要加骨架外内容
    expect(prompt).not.toContain("/api/write/files")
    expect(prompt).not.toContain("format=json")
  })

  it("英文只读 Token + 全部空间", () => {
    const prompt = buildIntegrationPrompt({
      lang: "en",
      origin: "https://wiki.example.com",
      kind: "read",
      spaceIds: null,
      spaces: SPACES
    })

    expect(prompt).toContain(
      "Please integrate this Ciki knowledge base into your toolset to look up information and record content when requested."
    )
    expect(prompt).toContain("- Instance URL: https://wiki.example.com")
    expect(prompt).toContain(
      "- API Token: `{{CIKI_API_TOKEN}}` (placeholder; the token will be provided separately in a moment. Replace the placeholder once received and include the header `Authorization: Bearer <Token>` with all requests)"
    )
    expect(prompt).toContain(
      "- Token permissions: Read-only, scope: All spaces"
    )
    expect(prompt).toContain(
      "Common endpoints: list spaces and page tree (GET /api/read/spaces, GET /api/read/tree), read page content by ID (GET /api/read/pages/:id), full-text search (GET /api/read/search)."
    )
    expect(prompt).not.toContain("/api/write")
    expect(prompt).toContain(
      "Call the list spaces endpoint first to verify connectivity, then proceed with reading or writing per my instructions. Do not write the token into any public files, code repositories, or external responses."
    )
  })

  it("英文读写 Token + 指定空间", () => {
    const prompt = buildIntegrationPrompt({
      lang: "en-US",
      origin: "https://wiki.example.com",
      kind: "write",
      spaceIds: [2, 100],
      spaces: SPACES
    })

    expect(prompt).toContain(
      "- Token permissions: Read-write, scope: Selected spaces: 研发空间, Unknown space (#100)"
    )
    expect(prompt).toContain(
      "Common endpoints: list spaces and page tree (GET /api/read/spaces, GET /api/read/tree), read page content by ID (GET /api/read/pages/:id), full-text search (GET /api/read/search); create and update pages (POST /api/write/pages, PUT /api/write/pages/:id)."
    )
  })

  it("无 window 时回退 origin 为空字符串", () => {
    const prompt = buildIntegrationPrompt({
      lang: "zh",
      kind: "read",
      spaceIds: null
    })
    expect(prompt).toContain("- 实例地址：")
  })
})
