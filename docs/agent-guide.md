> 契约版本：{{CONTRACT_VERSION}} | 构建版本：{{BUILD_VERSION}}

# Ciki Agent 接入与操作指引

本指引面向使用 API 令牌与 Ciki 实例对接的自动化 Agent（如写文档、维护知识库的智能体）。只需获取目标 Ciki 实例的公网访问地址（下文以 `https://ciki.example.com` 示例）以及被授予相应权限的 API 令牌（Token），即可通过标准 HTTP API 完成空间读取、页面创作、文件上传与页尾评论。

---

## 一、接入与鉴权

### 1.1 携带令牌

所有令牌请求必须在 HTTP Header 中携带 Bearer 令牌：

```http
Authorization: Bearer <你的_API_TOKEN>
```

### 1.2 令牌类型与权限边界

Ciki 采用专表与职责分离设计，API 令牌分为两种类型（`kind`）：

- **只读令牌（`read`）**：仅可调用 `/api/read/*` 系列端点。
- **读写令牌（`write`）**：可调用 `/api/write/*` 系列端点，以及支持 Agent 操作的评论写端点（`/api/pages/:id/comments*`）。

> [!IMPORTANT]
> 令牌类型严格隔离：只读令牌无法调用写端点；导入令牌或交互式会话 Cookie 也无法访问 `/api/read/*` 或 `/api/write/*`。

### 1.3 权限校验链（一句话版）

每次请求的权限校验依次执行：**请求携带有效令牌 → 解析归属账号（必须有效且已启用） → 校验空间是否在令牌允许范围（`token_space_scopes`） → 校验归属账号在目标空间的角色**（读操作需成员角色 `read` 及以上；写操作需 `editor` 及以上）。任何一环不满足均直接响应 `404 Not Found`，不泄露空间或页面的存在性。

---

## 二、读接口（只读端点）

使用只读或读写令牌，通过 `/api/read/*` 查询文档内容与结构。

### 2.1 获取可见空间列表

- **请求**：`GET /api/read/spaces`
- **响应示例**：
```json
{
  "spaces": [
    { "id": 1, "name": "工程技术", "slug": "engineering" },
    { "id": 2, "name": "产品规划", "slug": "product" }
  ]
}
```

### 2.2 获取页面树

- **请求**：`GET /api/read/tree?space_id=1`（`space_id` 可选，缺省按令牌范围过滤）
- **响应示例**：返回未删除页面的扁平列表，调用方通过 `parent_id` 组装父子层级：
```json
[
  {
    "id": 101,
    "title": "架构总览",
    "parent_id": null,
    "space_id": 1,
    "sort_order": 0,
    "updated_at": "2026-11-26T08:00:00.000Z"
  },
  {
    "id": 102,
    "title": "服务清单",
    "parent_id": 101,
    "space_id": 1,
    "sort_order": 1,
    "updated_at": "2026-11-26T08:30:00.000Z"
  }
]
```

### 2.3 全文检索

- **请求**：`GET /api/read/search?q=架构设计&space_id=1`
- **响应示例**：返回匹配的页面及带高亮标记的匹配摘要（`snippet`）：
```json
[
  {
    "id": 101,
    "title": "架构总览",
    "snippet": "本文介绍系统的整体…",
    "updated_at": "2026-11-26T08:00:00.000Z"
  }
]
```

### 2.4 获取页面正文详情

- **请求**：`GET /api/read/pages/:id`
- **默认响应**：返回元数据与只读 Markdown（`markdown` 字段），适用于快速检阅正文：
```json
{
  "id": 101,
  "title": "架构总览",
  "parent_id": null,
  "space_id": 1,
  "sort_order": 0,
  "created_at": "2026-11-20T00:00:00.000Z",
  "updated_at": "2026-11-26T08:00:00.000Z",
  "markdown": "## 架构设计\n\n系统由以下核心模块组成…"
}
```

- **获取 TipTap JSON 正文**：编辑或修改页面前，必须附带参数 `?format=json`：
  `GET /api/read/pages/:id?format=json`
  响应包含完整 `content_json` 对象（与编辑器结构完全一致）。

---

## 三、写接口（建页与改页）

使用读写令牌，通过 `/api/write/*` 执行创作与维护。请求体与响应字段统一为 `snake_case`。

### 3.1 创建页面

- **请求**：`POST /api/write/pages`
- **请求体**：
```json
{
  "space_id": 1,
  "parent_id": null,
  "title": "新特性设计方案",
  "content_json": {
    "type": "doc",
    "content": [
      {
        "type": "paragraph",
        "content": [{ "type": "text", "text": "本方案详细说明新特性设计。" }]
      }
    ]
  }
}
```
`space_id` 省略时将落入实例的默认空间；`parent_id` 省略时位于空间根级。成功返回 201 及元数据信息。

### 3.2 修改页面

- **请求**：`PUT /api/write/pages/:id`
- **请求体**：`{"content_json": ...}` 或 `{"title": "新标题", "content_json": ...}`。

> [!CAUTION]
> **写操作铁律**：
> 1. **只传 `content_json`，禁止走 Markdown 中转**：服务端正文存储为标准 TipTap JSON 结构，不提供 Markdown→JSON 转换链。若将 `markdown` 转为纯文本修改后再逆推，会彻底破坏画布（`excalidraw`）、嵌入块（`htmlEmbed`）、代码块折叠状态以及表格等复杂节点。
> 2. **更新标题**：仅当确实需要重命名时才传入 `title`；省略 `title` 时服务端自动沿用现存标题。
> 3. **安全操作步骤**：批量改动前，必须先备份原始 `content_json`，并先选取一页进行小规模试点验证无误后，再推进批量写入。

### 3.3 移动页面

- **请求**：`POST /api/write/pages/:id/move`
- **请求体**：`{"parent_id": 2, "index": 0, "space_id": 1}`
  跨空间移动要求源与目标空间均在令牌权限范围内；`index` 为目标父级下的从 0 起算的同级序号。

### 3.4 软删除页面

- **请求**：`DELETE /api/write/pages/:id`
  页面将被移入空间回收站，其子页面一并被软删除，可在站内回收站中恢复。

---

## 四、文件与 Embed 上传

所有上传接口均使用 `multipart/form-data`，表单字段名必须固定为 `file`。

### 4.1 三类上传入口与 Key 规则

| 资源类型            | 上传端点                       | 接受文件类型                             | 单文件上限 | 返回 Key 规范        |
| ------------------- | ------------------------------ | ---------------------------------------- | ---------- | -------------------- |
| **正文图片**        | `POST /api/write/files`        | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` | 默认 10MB，可在系统管理配置（1–100MB） | `pages/<uuid>.<ext>` |
| **画布场景 JSON**   | `POST /api/write/files`        | `.json`（Excalidraw 场景文件）           | 2 MB       | `pages/<uuid>.json`  |
| **Embed 嵌入 HTML** | `POST /api/write/files/embeds` | `.html`                                  | 1 MB       | `embeds/<uuid>.html` |

### 4.2 响应格式

上传成功返回 201 及以下四字段结构：

```json
{
  "key": "pages/550e8400-e29b-41d4-a716-446655440000.png",
  "url": "/api/files/pages/550e8400-e29b-41d4-a716-446655440000.png",
  "contentType": "image/png",
  "size": 18230
}
```

### 4.3 跨账号读取隔离

通过 `GET /api/read/files/:key` 读取文件（支持正文图片、画布场景 JSON 及 Embed 嵌入 HTML，key 须匹配 `pages/<uuid>.<ext>` 或 `embeds/<uuid>.html` 等合法形状）时，服务端会严格校验上传者身份。若文件非当前令牌所属账号上传或形状不合法，接口将返回 404，不泄露文件是否存在。

---

## 五、画布写入规范（两步法）

Agent 向页面插入 Excalidraw 画布时，采用标准**两步法写入**，无需在本地生成或上传预览图片：

1. **第一步**：调用 `POST /api/write/files` 上传 `.json` 场景文件，获取 `sceneKey`（例如 `pages/1b3e5a7d-890f-4e3b-b21c-4f8a9e0d1c2b.json`）。
2. **第二步**：在 `content_json` 中构造 `excalidraw` 节点，**直接省略 `previewKey`**（或置为 `null`）：
```json
{
  "type": "excalidraw",
  "attrs": {
    "sceneKey": "pages/1b3e5a7d-890f-4e3b-b21c-4f8a9e0d1c2b.json"
  }
}
```
阅读态下，Ciki 网页端会在浏览器端按标准尺寸（2x、带背景）自动现场渲染，并将生成的 `previewKey` 回填至服务端，无需外部 Agent 打包无头浏览器。

### 5.1 校验规则与兼容性

- **`sceneKey` 必填**：必须严格匹配正则 `^pages/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$`，缺失或格式非法回 400 `code:"INVALID_CONTENT_JSON"`。
- **`previewKey` 可选**：推荐直接省略（或置为 `null` / 空串）；若调用方已自行渲染并携带，必须匹配正则 `^pages/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$`，服务端继续完全兼容接收、直接落库；格式非法同样回 400 `code:"INVALID_CONTENT_JSON"`。

---

## 六、Embed 作者契约

通过 `POST /api/write/files/embeds` 上传并在正文中引用的 HTML 嵌入部件，需遵循以下平台契约：

### 6.1 单文件自包含与安全沙箱

- 嵌入页面运行于 `sandbox allow-scripts` 隔离沙箱中，无法读取宿主 Cookie 或发起同源 API 请求。
- 嵌入文件必须单文件自包含：脚本与样式内联，图片与字体采用 `data:` 或 `blob:` 格式内联。
- 高度自适应：Ciki 会在下发 HTML 时注入高度上报脚本，根据内容尺寸自动伸缩 iframe 高度，作者无需手写高度上报逻辑。

### 6.2 主题跟随协议

嵌入部件支持随 Ciki 主题（风格与明暗）实时切换：

1. **URL 参数（首帧直出）**：父页在加载 iframe 时会在 `src` 中追加参数 `?mode=<light|dark>&style=<nova|paper|natural|eink|notion|sketch>`。
2. **DOM 契约**：页面启动时应解析参数，并设置根元素：
   - 风格：`document.documentElement.setAttribute("data-theme", "nova" | "paper" | "natural" | "eink" | "notion" | "sketch")`
   - 明暗：暗色时添加 `.dark` 类（`document.documentElement.classList.add("dark")`），浅色时移除。
3. **实时消息监听**：监听宿主下发的 postMessage 消息更新主题：
```javascript
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return
  const data = event.data
  if (data?.type === "ciki-embed-theme") {
    // data.mode: "light" | "dark"
    // data.style: "nova" | "paper" | "natural" | "eink" | "notion" | "sketch"
    document.documentElement.setAttribute("data-theme", data.style)
    document.documentElement.classList.toggle("dark", data.mode === "dark")
  }
})
```
> [!WARNING]
> 旧版使用的 `data-theme-style`、`data-theme="light|dark"` 属性以及消息体中的 `theme` 字段已彻底废弃，请统一按照上述新契约对接。

---

## 七、主题配色真值表

为方便嵌入式内容（Embed iframe 组件、图表、SVG 画布等）单文件自包含实现与宿主设计语言无缝对齐，下表收录六套风格共十二组核心语义色彩令牌的实际色值（与 `web/src/index.css` 同源、逐字对照一致）。

| 语义色彩令牌           | Nova 浅版 (`:root`)         | Nova 暗版 (`.dark`)         | Paper 浅版 (`html[data-theme="paper"]`) | Paper 暗版 (`html[data-theme="paper"].dark`) | Natural 浅版 (`html[data-theme="natural"]`) | Natural 暗版 (`html[data-theme="natural"].dark`) | Eink 浅版 (`html[data-theme="eink"]`) | Eink 暗版 (`html[data-theme="eink"].dark`) | Notion 浅版 (`html[data-theme="notion"]`) | Notion 暗版 (`html[data-theme="notion"].dark`) | Sketch 浅版 (`html[data-theme="sketch"]`) | Sketch 暗版 (`html[data-theme="sketch"].dark`) |
| ---------------------- | --------------------------- | --------------------------- | --------------------------------------- | -------------------------------------------- | ------------------------------------------- | ------------------------------------------------ | ------------------------------------- | ------------------------------------------ | ----------------------------------------- | ---------------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| `theme-color (meta)`   | `#ffffff`                   | `#0a0a0a`                   | `#f7f4ee`                               | `#0b0c0e`                                    | `#faf6f1`                                   | `#191612`                                        | `#f5f3ea`                             | `#171814`                                  | `#ffffff`                                 | `#191919`                                      | `#f5f0e8`                                 | `#262420`                                      |
| `background`           | `oklch(1 0 0)`              | `oklch(0.145 0 0)`          | `#f7f4ee`                               | `#0b0c0e`                                    | `#faf6f1`                                   | `#191612`                                        | `#f5f3ea`                             | `#171814`                                  | `#ffffff`                                 | `#191919`                                      | `#f5f0e8`                                 | `#262420`                                      |
| `foreground`           | `oklch(0.145 0 0)`          | `oklch(0.985 0 0)`          | `#2a2b2f`                               | `#f2f0eb`                                    | `#292524`                                   | `#ece7dd`                                        | `#20211e`                             | `#eceade`                                  | `#37352f`                                 | `#e8e8e6`                                      | `#2c2c2c`                                 | `#ece5d8`                                      |
| `card`                 | `oklch(1 0 0)`              | `oklch(0.205 0 0)`          | `#f9f7f2`                               | `#1a1b1f`                                    | `#ffffff`                                   | `#221e18`                                        | `#faf8f1`                             | `#1f201c`                                  | `#ffffff`                                 | `#212121`                                      | `#faf5ed`                                 | `#2e2b26`                                      |
| `card-foreground`      | `oklch(0.145 0 0)`          | `oklch(0.985 0 0)`          | `#2a2b2f`                               | `#f2f0eb`                                    | `#292524`                                   | `#ece7dd`                                        | `#20211e`                             | `#eceade`                                  | `#37352f`                                 | `#e8e8e6`                                      | `#2c2c2c`                                 | `#ece5d8`                                      |
| `popover`              | `oklch(1 0 0)`              | `oklch(0.205 0 0)`          | `#f9f7f2`                               | `#1a1b1f`                                    | `#ffffff`                                   | `#221e18`                                        | `#faf8f1`                             | `#1f201c`                                  | `#ffffff`                                 | `#262626`                                      | `#faf5ed`                                 | `#2e2b26`                                      |
| `popover-foreground`   | `oklch(0.145 0 0)`          | `oklch(0.985 0 0)`          | `#2a2b2f`                               | `#f2f0eb`                                    | `#292524`                                   | `#ece7dd`                                        | `#20211e`                             | `#eceade`                                  | `#37352f`                                 | `#e8e8e6`                                      | `#2c2c2c`                                 | `#ece5d8`                                      |
| `primary`              | `oklch(0.205 0 0)`          | `oklch(0.922 0 0)`          | `var(--coral)` (`#e2705a`)              | `var(--coral)` (`#e8694e`)                   | `var(--sage-deep)` (`#5f7050`)              | `var(--sage)` (`#a3b18a`)                        | `#20211e`                             | `#eceade`                                  | `#1f76cb`                                 | `#5aa9d6`                                      | `#2c2c2c`                                 | `#ece5d8`                                      |
| `primary-foreground`   | `oklch(0.985 0 0)`          | `oklch(0.205 0 0)`          | `var(--coral-ink)` (`#ffffff`)          | `var(--coral-ink)` (`#ffffff`)               | `#ffffff`                                   | `#1c2317`                                        | `#f5f3ea`                             | `#171814`                                  | `#ffffff`                                 | `#10222b`                                      | `#f5f0e8`                                 | `#262420`                                      |
| `secondary`            | `oklch(0.97 0 0)`           | `oklch(0.269 0 0)`          | `#e9e3da`                               | `#24262b`                                    | `#e9e0d4`                                   | `#2e2a21`                                        | `#e6e4da`                             | `#262720`                                  | `#f7f6f3`                                 | `#262626`                                      | `#e8e2d8`                                 | `#3a372f`                                      |
| `secondary-foreground` | `oklch(0.205 0 0)`          | `oklch(0.985 0 0)`          | `#434247`                               | `#c8c5bf`                                    | `#44403c`                                   | `#d6d0c2`                                        | `#20211e`                             | `#eceade`                                  | `#37352f`                                 | `#e8e8e6`                                      | `#2c2c2c`                                 | `#ece5d8`                                      |
| `muted`                | `oklch(0.97 0 0)`           | `oklch(0.269 0 0)`          | `#e9e3da`                               | `#24262b`                                    | `#f1ebe1`                                   | `#2e2a21`                                        | `#e6e4da`                             | `#262720`                                  | `#f7f6f3`                                 | `#262626`                                      | `#e8e2d8`                                 | `#3a372f`                                      |
| `muted-foreground`     | `oklch(0.556 0 0)`          | `oklch(0.708 0 0)`          | `#77746f`                               | `#908d87`                                    | `#78716c`                                   | `#a39e93`                                        | `#555750`                             | `#a9a89d`                                  | `#6e6d68`                                 | `#9b9b97`                                      | `#6b6b6b`                                 | `#a89f8d`                                      |
| `accent`               | `oklch(0.97 0 0)`           | `oklch(0.269 0 0)`          | `#e9e3da`                               | `#24262b`                                    | `#e9e0d4`                                   | `#2e2a21`                                        | `#e6e4da`                             | `#262720`                                  | `#efedea`                                 | `#2f2f2f`                                      | `#e8e2d8`                                 | `#3a372f`                                      |
| `accent-foreground`    | `oklch(0.205 0 0)`          | `oklch(0.985 0 0)`          | `#2a2b2f`                               | `#f2f0eb`                                    | `#292524`                                   | `#ece7dd`                                        | `#20211e`                             | `#eceade`                                  | `#37352f`                                 | `#e8e8e6`                                      | `#2c2c2c`                                 | `#ece5d8`                                      |
| `destructive`          | `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` | `oklch(0.577 0.245 27.325)`             | `oklch(0.704 0.191 22.216)`                  | `oklch(0.577 0.245 27.325)`                 | `oklch(0.704 0.191 22.216)`                      | `oklch(0.577 0.245 27.325)`           | `oklch(0.704 0.191 22.216)`                | `oklch(0.577 0.245 27.325)`               | `oklch(0.704 0.191 22.216)`                    | `oklch(0.577 0.245 27.325)`               | `oklch(0.704 0.191 22.216)`                    |
| `border`               | `oklch(0.922 0 0)`          | `oklch(1 0 0 / 10%)`        | `#dfdbd2`                               | `#26282d`                                    | `#e6dfd2`                                   | `#332e25`                                        | `#bab9b0`                             | `#44453f`                                  | `#e9e9e7`                                 | `#2f2f2f`                                      | `#b8b0a0`                                 | `#575344`                                      |
| `input`                | `oklch(0.922 0 0)`          | `oklch(1 0 0 / 15%)`        | `#dfdbd2`                               | `#26282d`                                    | `#e6dfd2`                                   | `#332e25`                                        | `#bab9b0`                             | `#44453f`                                  | `#e9e9e7`                                 | `#2f2f2f`                                      | `#b8b0a0`                                 | `#575344`                                      |
| `ring`                 | `oklch(0.708 0 0)`          | `oklch(0.556 0 0)`          | `#f3bcae`                               | `#94402e`                                    | `var(--sage-300)` (`#c3cfb2`)               | `var(--sage-deep)` (`#8b9d77`)                   | `#20211e`                             | `#eceade`                                  | `#9fc6ee`                                 | `#5aa9d6`                                      | `#2c2c2c`                                 | `#ece5d8`                                      |
| `chart-1`              | `oklch(0.87 0 0)`           | `oklch(0.87 0 0)`           | `oklch(0.87 0 0)`                       | `oklch(0.87 0 0)`                            | `#8b9d77`                                   | `#a3b18a`                                        | `#555750`                             | `#eceade`                                  | `#2eaadc`                                 | `#2eaadc`                                      | `#2c2c2c`                                 | `#ece5d8`                                      |
| `chart-2`              | `oklch(0.556 0 0)`          | `oklch(0.556 0 0)`          | `oklch(0.556 0 0)`                      | `oklch(0.556 0 0)`                           | `#d4a373`                                   | `#d4a373`                                        | `#8a8b83`                             | `#bab9b0`                                  | `#eb5757`                                 | `#eb5757`                                      | `var(--pencil-red)` (`#c0392b`)           | `var(--pencil-red)` (`#e5735f`)                |
| `chart-3`              | `oklch(0.439 0 0)`          | `oklch(0.439 0 0)`          | `oklch(0.439 0 0)`                      | `oklch(0.439 0 0)`                           | `#75a191`                                   | `#75a191`                                        | `#20211e`                             | `#8a8b83`                                  | `#0f7b6c`                                 | `#4ec9a2`                                      | `var(--pencil-blue)` (`#2471a3`)          | `var(--pencil-blue)` (`#6fb3e0`)               |
| `chart-4`              | `oklch(0.371 0 0)`          | `oklch(0.371 0 0)`          | `oklch(0.371 0 0)`                      | `oklch(0.371 0 0)`                           | `#5f7050`                                   | `#8b9d77`                                        | `#bab9b0`                             | `#555750`                                  | `#e3a008`                                 | `#e3a008`                                      | `var(--pencil-green)` (`#1e8449`)         | `var(--pencil-green)` (`#58b368`)              |
| `chart-5`              | `oklch(0.269 0 0)`          | `oklch(0.269 0 0)`          | `oklch(0.269 0 0)`                      | `oklch(0.269 0 0)`                           | `#292524`                                   | `#e9e0d4`                                        | `#44453f`                             | `#44453f`                                  | `#7c5cd6`                                 | `#a083ff`                                      | `var(--pencil-orange)` (`#b9770e`)        | `var(--pencil-orange)` (`#f0b429`)             |

> [!NOTE]
> 1. **风格真源与私有色阶对照**：
>    - **Paper**：`web/src/index.css` 中 Paper 主题的 `primary` 声明为 `var(--coral)`、`primary-foreground` 声明为 `var(--coral-ink)`；其实测常量珊瑚色在浅版为 `--coral: #e2705a`、暗版为 `--coral: #e8694e`，墨色均为 `--coral-ink: #ffffff`；`chart-1`–`chart-5` 未在 Paper 作用域覆盖，继承自全局 `:root` / `.dark`。
>    - **Natural**：`primary` 声明为 `var(--sage-deep)`（浅版 `#5f7050`）/ `var(--sage)`（暗版 `#a3b18a`）；`ring` 声明为 `var(--sage-300)`（浅版 `#c3cfb2`）/ `var(--sage-deep)`（暗版 `#8b9d77`）。
>    - **Eink**：采用纯灰阶有限墨阶设计，无彩色令牌；层级主要靠 1px 边框与墨阶表达。
>    - **Sketch**：图表令牌声明为 `var(--pencil-*)` 私有铅笔色系；浅版为 `--pencil-red: #c0392b`、`--pencil-blue: #2471a3`、`--pencil-green: #1e8449`、`--pencil-orange: #b9770e`；暗版为 `--pencil-red: #e5735f`、`--pencil-blue: #6fb3e0`、`--pencil-green: #58b368`、`--pencil-orange: #f0b429`。
>    - **Notion**：各语义令牌直接落地为固定 HEX 常量。
> 2. **嵌入部件使用方式**：iframe 运行于沙箱隔离环境中，无法直接继承宿主的 CSS 变量。作者可通过第 6 节的 `ciki-embed-theme` 消息或 URL 查询参数（`?mode=&style=`）获知当前激活的主题，在组件内联样式表中选用上述真值，实现首帧无感跟随。

---

## 八、页尾评论操作

持 `write` 令牌的 Agent 可代表自身账号发表与维护页面评论（展示为 Agent 身份并标注所属 owner）：

### 8.1 预览评论 Markdown 渲染

- **请求**：`POST /api/pages/:id/comments/preview`
- **请求体**：`{"bodyMd": "## 分析结论\n数据已核对完成。"}`
- **响应**：`{"html": "<h2>分析结论</h2><p>数据已核对完成。</p>"}`

### 8.2 发表评论

- **请求**：`POST /api/pages/:id/comments`
- **请求体**：`{"bodyMd": "## 分析结论", "parentId": null}`（回复某评论时传其 `id`；Ciki 仅支持一级串结构，回复子评论会自动归一到顶层评论下）。

### 8.3 编辑评论

- **请求**：`PUT /api/pages/:id/comments/:commentId`
- **请求体**：`{"bodyMd": "## 修改后的正文"}`（仅作者本人有权修改）。

### 8.4 删除评论

- **请求**：`DELETE /api/pages/:id/comments/:commentId`
  软删除评论。如果该评论存在存活的回复，评论将转为占位保留；无回复时彻底移除。

---

## 九、常见错误与排查

| 状态码                       | 常见原因                     | 排查方向                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **401 Unauthorized**         | 令牌未带、令牌失效或路由混淆 | 1. 检查请求头是否携带 `Authorization: Bearer <token>`；<br>2. **核对端点路径**：外部 Agent 必须调用 `/api/read/*` 与 `/api/write/*`，严禁使用真人前端的会话端点（如 `/api/pages` 等会话端点不接受 API 令牌）；<br>3. 检查令牌是否已在管理后台被吊销，或所属 Agent 账号是否停用。                       |
| **404 Not Found**            | 资源不存在或无权访问         | 1. 页面确实不存在或已放入回收站；<br>2. 令牌归属账号在目标空间中无对应成员角色（读需成员，写需 editor）；<br>3. 该空间未被包含在令牌授权的空间范围列表中；<br>4. 读文件时，该文件并非由当前令牌归属账号上传。                                                                                          |
| **400 INVALID_CONTENT_JSON** | TipTap JSON 格式不合规       | 1. `content_json` 必须包含合法的 `type: "doc"` 顶层对象；<br>2. `excalidraw` 节点的 `sceneKey` 必须必填且匹配 `^pages/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$`；若提供 `previewKey` 则须匹配 `^pages/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$`。 |
| **413 PAYLOAD_TOO_LARGE**    | 内容或文件超限               | 1. 正文 JSON 体积超限（单页上限 5 MB）；<br>2. 上传文件超过相应类型大小限制（图片默认 10MB，可在系统管理配置（1–100MB）、场景 2 MB、Embed 1 MB）。                                                                                                                                                                                     |
| **429 RATE_LIMITED**         | 触发频控限流                 | 单用户写接口频控为 600 次 / 5 分钟，认证失败为 20 次 / 5 分钟。请遵循响应中的 `retryAfter` 秒数进行退避重试。                                                                                                                                                                                          |

---

## 十、自述端点

- **OpenAPI 3.1 规范**：`GET /api/openapi.json`（公开免鉴权，返回同源完整 API 规范元数据）。
- **Agent 指引页**：`GET /api/public/agent-guide`（公开免鉴权，返回本指引 Markdown 原文）。
- **发现入口**：`GET /api/public`（返回实例版本与上述端点发现字段）。
