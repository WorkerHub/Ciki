import type { ApiTokenKind, TokenSpaceIds } from "@/lib/api"

export interface BuildIntegrationPromptOptions {
  lang?: string
  origin?: string
  kind: ApiTokenKind
  spaceIds: TokenSpaceIds
  spaces?: Array<{ id: number; name: string }>
}

/**
 * 生成 API Token 接入提示词。
 *
 * 严格遵循安全约束：
 * - 绝不出现 Token 明文，恒使用占位符 `{{CIKI_API_TOKEN}}`，并说明 Token 随后单独发送；
 * - 语言跟随界面语言（中文 / 英文）；
 * - 常用接口按 kind 裁剪，只读 Token 不得包含任何写端点；
 * - 范围为指定空间时解析出具体空间名。
 */
export function buildIntegrationPrompt({
  lang,
  origin,
  kind,
  spaceIds,
  spaces = []
}: BuildIntegrationPromptOptions): string {
  const isZh = (lang ?? "").toLowerCase().startsWith("zh")
  const resolvedOrigin =
    origin ?? (typeof window !== "undefined" ? window.location.origin : "")

  if (isZh) {
    const permission = kind === "write" ? "读写" : "只读"
    let scopeText = "全部空间"
    if (spaceIds !== null) {
      if (spaceIds.length === 0) {
        scopeText = "指定空间：无"
      } else {
        const spaceMap = new Map(spaces.map((s) => [s.id, s.name]))
        const names = spaceIds.map(
          (id) => spaceMap.get(id) || `未知空间(#${id})`
        )
        scopeText = `指定空间：${names.join("、")}`
      }
    }

    const endpoints =
      kind === "write"
        ? "列空间与页面树（GET /api/read/spaces、GET /api/read/tree）、按 ID 读页面正文（GET /api/read/pages/:id）、全文搜索（GET /api/read/search）；新建与更新页面（POST /api/write/pages、PUT /api/write/pages/:id）。"
        : "列空间与页面树（GET /api/read/spaces、GET /api/read/tree）、按 ID 读页面正文（GET /api/read/pages/:id）、全文搜索（GET /api/read/search）。"

    return [
      "请把这个 Ciki 知识库接入你的工具集，之后我让你查资料、记内容时用它。",
      `- 实例地址：${resolvedOrigin}`,
      "- API Token：`{{CIKI_API_TOKEN}}`（占位符，Token 我随后单独发给你；收到后替换占位符，所有请求带请求头 `Authorization: Bearer <Token>`）",
      `- 令牌权限：${permission}，范围：${scopeText}`,
      `常用接口：${endpoints}`,
      "先调一次列空间接口验证连通，再按我的指令读写。Token 不要写进任何公开文件、代码仓库或对外回复里。"
    ].join("\n")
  }

  const permission = kind === "write" ? "Read-write" : "Read-only"
  let scopeText = "All spaces"
  if (spaceIds !== null) {
    if (spaceIds.length === 0) {
      scopeText = "Selected spaces: none"
    } else {
      const spaceMap = new Map(spaces.map((s) => [s.id, s.name]))
      const names = spaceIds.map(
        (id) => spaceMap.get(id) || `Unknown space (#${id})`
      )
      scopeText = `Selected spaces: ${names.join(", ")}`
    }
  }

  const endpoints =
    kind === "write"
      ? "list spaces and page tree (GET /api/read/spaces, GET /api/read/tree), read page content by ID (GET /api/read/pages/:id), full-text search (GET /api/read/search); create and update pages (POST /api/write/pages, PUT /api/write/pages/:id)."
      : "list spaces and page tree (GET /api/read/spaces, GET /api/read/tree), read page content by ID (GET /api/read/pages/:id), full-text search (GET /api/read/search)."

  return [
    "Please integrate this Ciki knowledge base into your toolset to look up information and record content when requested.",
    `- Instance URL: ${resolvedOrigin}`,
    "- API Token: `{{CIKI_API_TOKEN}}` (placeholder; the token will be provided separately in a moment. Replace the placeholder once received and include the header `Authorization: Bearer <Token>` with all requests)",
    `- Token permissions: ${permission}, scope: ${scopeText}`,
    `Common endpoints: ${endpoints}`,
    "Call the list spaces endpoint first to verify connectivity, then proceed with reading or writing per my instructions. Do not write the token into any public files, code repositories, or external responses."
  ].join("\n")
}
