import type { ApiTokenKind, TokenSpaceIds } from "@/lib/api"

export interface BuildIntegrationPromptOptions {
  lang?: string
  origin?: string
  kind: ApiTokenKind
  spaceIds: TokenSpaceIds
  spaces?: Array<{ id: number; name: string }>
  agentName?: string
  ownerName?: string
}

/**
 * 生成 API Token 接入提示词。
 *
 * 严格遵循安全约束与定版规格：
 * - 绝不出现 Token 明文，恒使用占位符 `{{CIKI_API_TOKEN}}`，并说明 Token 随后单独发送；
 * - 语言跟随界面语言（中文 / 英文）；
 * - 常用接口按 kind 裁剪，只读 Token 不得包含任何写端点；读写 Token 列全读、写、文件上传三族；
 * - 范围为指定空间时解析出具体空间名并附带总数。
 */
export function buildIntegrationPrompt({
  lang,
  origin,
  kind,
  spaceIds,
  spaces = [],
  agentName,
  ownerName
}: BuildIntegrationPromptOptions): string {
  const isZh = (lang ?? "").toLowerCase().startsWith("zh")
  const resolvedOrigin =
    origin ?? (typeof window !== "undefined" ? window.location.origin : "")

  if (isZh) {
    const permission = kind === "write" ? "读写" : "只读"
    let scopeText = "全部空间"
    if (spaceIds !== null) {
      if (spaceIds.length === 0) {
        scopeText = "指定空间（共 0 个）：无"
      } else {
        const spaceMap = new Map(spaces.map((s) => [s.id, s.name]))
        const names = spaceIds.map(
          (id) => spaceMap.get(id) || `未知空间(#${id})`
        )
        scopeText = `指定空间（共 ${spaceIds.length} 个）：${names.join("、")}`
      }
    }

    const identityLine = agentName
      ? ownerName
        ? `\n- 身份声明：以 Agent「${agentName}」的身份工作，所属 Owner 为「${ownerName}」。`
        : `\n- 身份声明：以 Agent「${agentName}」的身份工作。`
      : ""

    const writeSections =
      kind === "write"
        ? `\n#### 写入接口：
- 创建页面：\`POST ${resolvedOrigin}/api/write/pages\`
- 更新页面：\`PUT ${resolvedOrigin}/api/write/pages/:id\`
- 移动页面：\`POST ${resolvedOrigin}/api/write/pages/:id/move\`
- 删除页面（移入回收站）：\`DELETE ${resolvedOrigin}/api/write/pages/:id\`

#### 文件上传：
- 上传图片：\`POST ${resolvedOrigin}/api/write/files\`（multipart/form-data，表单字段 \`file\`）
`
        : ""

    return `你正在接入 Ciki 知识库服务。请遵循以下配置和规范进行接口调用：

### 1. 实例信息与认证
- 实例地址：${resolvedOrigin}${identityLine}
- 认证方式：HTTP Header \`Authorization: Bearer {{CIKI_API_TOKEN}}\`
- 说明：Token 我随后单独发给你。收到后请替换占位符 \`{{CIKI_API_TOKEN}}\`，切勿将 Token 硬编码进公开文件、代码仓库或对外回复中。

### 2. 当前 Token 权限与范围
- 权限类型：${permission}
- 空间范围：${scopeText}

### 3. 可用接口
所有接口请求均需携带上述 Bearer 认证头。

#### 读取接口：
- 列出有效可见空间：\`GET ${resolvedOrigin}/api/read/spaces\`
- 获取空间页面树（扁平列表）：\`GET ${resolvedOrigin}/api/read/tree\`
- 全文搜索：\`GET ${resolvedOrigin}/api/read/search?q={关键词}\`
- 获取页面详情/Markdown：\`GET ${resolvedOrigin}/api/read/pages/:id\`
- 获取页面富文本结构：\`GET ${resolvedOrigin}/api/read/pages/:id?format=json\`
${writeSections}
### 4. 接入与验证步骤
1. 第一步：先调用 \`GET ${resolvedOrigin}/api/read/spaces\` 验证网络连通性与 Token 有效性，并确认你有权访问的空间列表。
2. 验证成功后再按需调用其余接口。
3. 安全警告：API Token 属于敏感凭据，严禁将其写入任何公开文件、提交到版本仓库，或在任何对外回复中泄露。`
  }

  const permission = kind === "write" ? "Read-write" : "Read-only"
  let scopeText = "All spaces"
  if (spaceIds !== null) {
    if (spaceIds.length === 0) {
      scopeText = "Selected spaces (0 total): none"
    } else {
      const spaceMap = new Map(spaces.map((s) => [s.id, s.name]))
      const names = spaceIds.map(
        (id) => spaceMap.get(id) || `Unknown space (#${id})`
      )
      scopeText = `Selected spaces (${spaceIds.length} total): ${names.join(", ")}`
    }
  }

  const enIdentityLine = agentName
    ? ownerName
      ? `\n- Identity: Working as Agent "${agentName}", owned by "${ownerName}".`
      : `\n- Identity: Working as Agent "${agentName}".`
    : ""

  const writeSections =
    kind === "write"
      ? `\n#### Write APIs:
- Create page: \`POST ${resolvedOrigin}/api/write/pages\`
- Update page: \`PUT ${resolvedOrigin}/api/write/pages/:id\`
- Move page: \`POST ${resolvedOrigin}/api/write/pages/:id/move\`
- Delete page (move to trash): \`DELETE ${resolvedOrigin}/api/write/pages/:id\`

#### File Upload:
- Upload image: \`POST ${resolvedOrigin}/api/write/files\` (multipart/form-data, form field \`file\`)
`
      : ""

  return `You are integrating with the Ciki knowledge base service. Please follow the configuration and specifications below:

### 1. Instance & Authentication
- Instance URL: ${resolvedOrigin}${enIdentityLine}
- Authentication: HTTP Header \`Authorization: Bearer {{CIKI_API_TOKEN}}\`
- Note: The Token will be provided separately in a moment. Replace the placeholder \`{{CIKI_API_TOKEN}}\` once received. Never hardcode the token in public files, code repositories, or external responses.

### 2. Current Token Permissions & Scope
- Permission: ${permission}
- Space Scope: ${scopeText}

### 3. Available Endpoints
All requests must include the Bearer authentication header above.

#### Read APIs:
- List accessible spaces: \`GET ${resolvedOrigin}/api/read/spaces\`
- Get page tree (flat list): \`GET ${resolvedOrigin}/api/read/tree\`
- Full-text search: \`GET ${resolvedOrigin}/api/read/search?q={keyword}\`
- Get page details / Markdown: \`GET ${resolvedOrigin}/api/read/pages/:id\`
- Get page rich text structure: \`GET ${resolvedOrigin}/api/read/pages/:id?format=json\`
${writeSections}
### 4. Integration & Verification Steps
1. First step: Call \`GET ${resolvedOrigin}/api/read/spaces\` to verify network connectivity and token validity, and to confirm accessible spaces.
2. Proceed with other endpoints as needed after verification succeeds.
3. Security warning: The API Token is a sensitive credential. Never write it into public files, commit it to version control, or expose it in external responses.`
}
