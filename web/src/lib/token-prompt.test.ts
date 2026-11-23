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
      "你正在接入 Ciki 知识库服务。请遵循以下配置和规范进行接口调用："
    )
    expect(prompt).toContain("- 实例地址：https://wiki.example.com")
    expect(prompt).toContain(
      "- 认证方式：HTTP Header `Authorization: Bearer {{CIKI_API_TOKEN}}`"
    )
    expect(prompt).toContain(
      "- 说明：Token 我随后单独发给你。收到后请替换占位符 `{{CIKI_API_TOKEN}}`，切勿将 Token 硬编码进公开文件、代码仓库或对外回复中。"
    )
    expect(prompt).toContain("- 权限类型：只读")
    expect(prompt).toContain("- 空间范围：全部空间")
    expect(prompt).toContain("#### 读取接口：")
    expect(prompt).toContain(
      "- 列出有效可见空间：`GET https://wiki.example.com/api/read/spaces`"
    )
    expect(prompt).toContain(
      "- 获取空间页面树（扁平列表）：`GET https://wiki.example.com/api/read/tree`"
    )
    expect(prompt).toContain(
      "- 全文搜索：`GET https://wiki.example.com/api/read/search?q={关键词}`"
    )
    expect(prompt).toContain(
      "- 获取页面详情/Markdown：`GET https://wiki.example.com/api/read/pages/:id`"
    )
    expect(prompt).toContain(
      "- 获取页面富文本结构：`GET https://wiki.example.com/api/read/pages/:id?format=json`"
    )
    expect(prompt).not.toContain("/api/write")
    expect(prompt).toContain("### 4. 接入与验证步骤")
    expect(prompt).toContain(
      "1. 第一步：先调用 `GET https://wiki.example.com/api/read/spaces` 验证网络连通性与 Token 有效性，并确认你有权访问的空间列表。"
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

    expect(prompt).toContain("- 权限类型：读写")
    expect(prompt).toContain(
      "- 空间范围：指定空间（共 3 个）：默认空间、研发空间、未知空间(#99)"
    )
    expect(prompt).toContain("#### 写入接口：")
    expect(prompt).toContain(
      "- 创建页面：`POST https://wiki.example.com/api/write/pages`"
    )
    expect(prompt).toContain(
      "- 更新页面：`PUT https://wiki.example.com/api/write/pages/:id`"
    )
    expect(prompt).toContain(
      "- 移动页面：`POST https://wiki.example.com/api/write/pages/:id/move`"
    )
    expect(prompt).toContain(
      "- 删除页面（移入回收站）：`DELETE https://wiki.example.com/api/write/pages/:id`"
    )
    expect(prompt).toContain("#### 文件上传：")
    expect(prompt).toContain(
      "- 上传图片：`POST https://wiki.example.com/api/write/files`（multipart/form-data，表单字段 `file`）"
    )
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
      "You are integrating with the Ciki knowledge base service. Please follow the configuration and specifications below:"
    )
    expect(prompt).toContain("- Instance URL: https://wiki.example.com")
    expect(prompt).toContain(
      "- Authentication: HTTP Header `Authorization: Bearer {{CIKI_API_TOKEN}}`"
    )
    expect(prompt).toContain("- Permission: Read-only")
    expect(prompt).toContain("- Space Scope: All spaces")
    expect(prompt).toContain("#### Read APIs:")
    expect(prompt).toContain(
      "- List accessible spaces: `GET https://wiki.example.com/api/read/spaces`"
    )
    expect(prompt).not.toContain("/api/write")
    expect(prompt).toContain("### 4. Integration & Verification Steps")
  })

  it("英文读写 Token + 指定空间", () => {
    const prompt = buildIntegrationPrompt({
      lang: "en-US",
      origin: "https://wiki.example.com",
      kind: "write",
      spaceIds: [2, 100],
      spaces: SPACES
    })

    expect(prompt).toContain("- Permission: Read-write")
    expect(prompt).toContain(
      "- Space Scope: Selected spaces (2 total): 研发空间, Unknown space (#100)"
    )
    expect(prompt).toContain("#### Write APIs:")
    expect(prompt).toContain(
      "- Create page: `POST https://wiki.example.com/api/write/pages`"
    )
    expect(prompt).toContain(
      "- Update page: `PUT https://wiki.example.com/api/write/pages/:id`"
    )
    expect(prompt).toContain(
      "- Move page: `POST https://wiki.example.com/api/write/pages/:id/move`"
    )
    expect(prompt).toContain(
      "- Delete page (move to trash): `DELETE https://wiki.example.com/api/write/pages/:id`"
    )
    expect(prompt).toContain("#### File Upload:")
    expect(prompt).toContain(
      "- Upload image: `POST https://wiki.example.com/api/write/files` (multipart/form-data, form field `file`)"
    )
  })

  it("空数组指定空间边界", () => {
    const zhPrompt = buildIntegrationPrompt({
      lang: "zh",
      origin: "https://wiki.example.com",
      kind: "read",
      spaceIds: [],
      spaces: SPACES
    })
    expect(zhPrompt).toContain("- 空间范围：指定空间（共 0 个）：无")

    const enPrompt = buildIntegrationPrompt({
      lang: "en",
      origin: "https://wiki.example.com",
      kind: "read",
      spaceIds: [],
      spaces: SPACES
    })
    expect(enPrompt).toContain("- Space Scope: Selected spaces (0 total): none")
  })

  it("支持 Agent 与 Owner 身份声明（中文与英文）", () => {
    const zhPrompt = buildIntegrationPrompt({
      lang: "zh",
      origin: "https://wiki.example.com",
      kind: "read",
      spaceIds: null,
      spaces: SPACES,
      agentName: "deploy-bot",
      ownerName: "Alice"
    })
    expect(zhPrompt).toContain(
      "- 身份声明：以 Agent「deploy-bot」的身份工作，所属 Owner 为「Alice」。"
    )

    const enPrompt = buildIntegrationPrompt({
      lang: "en",
      origin: "https://wiki.example.com",
      kind: "read",
      spaceIds: null,
      spaces: SPACES,
      agentName: "deploy-bot",
      ownerName: "Alice"
    })
    expect(enPrompt).toContain(
      '- Identity: Working as Agent "deploy-bot", owned by "Alice".'
    )
  })
})
