# ciki 后端 API 契约与数据模型（冻结）

本文件由后端实现单在计划确认后冻结，是前端实现单的接口依据。实现期如需变更，先上报 Chief 裁决，**不得单方面改动**；改动必须同步更新本文件。

- 服务端入口：`worker/src/index.ts`（Hono），部署单元同时托管前端静态资源。
- 表名一律经 `worker/src/lib/tables.ts` 拼当前部署的 `TABLE_PREFIX`（默认 `ciki_`，可显式无前缀），本文只用逻辑表名。
- 响应字段一律 camelCase；数据库列名 snake_case，二者在路由层转换。

## 一、通用约定

- **鉴权**：全站登录后可见。除下列公开端点外，所有 `/api/*` 都必须带会话 Cookie；未登录一律 `401 {"error":"Unauthorized"}`，且响应头 `Cache-Control: no-store`。
  - 公开：`GET /api/health`、`GET /api/setup/state`、`POST /api/setup`、`GET /api/auth/config`、`POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`、`POST /api/auth/refresh`、`POST /api/auth/2fa/verify`、`POST /api/auth/2fa/passkey/authenticate/options`、`POST /api/auth/2fa/passkey/authenticate/verify`。
- **会话 Cookie**：名字 `ciki_session`，值为 32 字节随机不透明令牌（base64url）。属性：`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`（7 天，`refresh` 会滑动续期）。服务端只存令牌的 SHA-256，不存原值；登出、改密、管理员停用/拒绝都会删会话行，删行即吊销。
- **错误体**：`{"error": string, "code"?: string, "retryAfter"?: number}`。常用状态码：400 校验失败、401 未登录/凭证错、403 权限或审批、404 不存在、409 冲突、413 体积超限、429 限流/锁定、500 服务端错误（不回显堆栈）。
- **时间**：所有时间字段均为 ISO 8601 字符串（`2026-11-07T12:00:00.000Z`），会话过期等内部字段用 Unix 秒但不出现在 DTO 中。
- **分页**：页面树与用户列表不分页；搜索用 `limit`（默认 20，上限 50）。
- **内容上限**：标题 1–255 字符；`contentJson` ≤ 800,000 字节；`contentHtml` 以**服务端消毒后**的字节数计 ≤ 800,000 字节；`contentText` 规范化后 ≤ 300,000 字节；三件套合计 ≤ 1,900,000 字节（D1 单行上限 2 MB）。超限 `413 {"error":"Payload too large","code":"PAYLOAD_TOO_LARGE"}`。
- **纯文本字段**：`title` 与 `contentText` 保存时剥除 HTML 标签并折叠空白，入库与搜索片段都不含 HTML 语法。
- **脱敏**：任何 DTO 都不返回 `password_hash`、TOTP 密文、passkey `public_key`、会话令牌或挑战原值。

## 二、数据模型

一次性迁移 `schema_v1`（追加式、全部 `CREATE … IF NOT EXISTS`；账本表为 `{prefix}schema_migrations`，记录 `name`、`applied_at`）。回滚方式：人工删除本项目表与账本，生产库执行前必须经用户批准；UI 不提供删表/清库入口。

### users

| 列                                                       | 类型                             | 说明                                             |
| -------------------------------------------------------- | -------------------------------- | ------------------------------------------------ |
| id                                                       | TEXT PK                          | UUID                                             |
| email                                                    | TEXT UNIQUE NOT NULL             | 写入前 trim + 小写                               |
| password_hash                                            | TEXT NOT NULL                    | PBKDF2-SHA256（100k 次），格式 `saltHex:hashHex` |
| role                                                     | TEXT NOT NULL DEFAULT 'user'     | `admin` / `user`                                 |
| is_active                                                | INTEGER NOT NULL DEFAULT 1       | 0/1                                              |
| approval_status                                          | TEXT NOT NULL DEFAULT 'approved' | `pending` / `approved` / `rejected`              |
| email_verified, base_currency, timezone, language, theme | —                                | 照 eNotify 保留，ciki 不使用、不暴露             |
| created_at, updated_at                                   | TEXT NOT NULL                    | ISO 时间                                         |

### user_2fa（只存 TOTP）

| 列           | 类型                       | 说明                                                                      |
| ------------ | -------------------------- | ------------------------------------------------------------------------- |
| user_id      | TEXT PK                    |                                                                           |
| totp_secret  | TEXT NULL                  | AES-GCM 密文，格式 `v1.<ivB64url>.<ctB64url>`，AAD = `ciki:totp:<userId>` |
| totp_enabled | INTEGER NOT NULL DEFAULT 0 |                                                                           |
| updated_at   | TEXT NOT NULL              |                                                                           |

### passkey_credentials

| 列            | 类型                       | 说明           |
| ------------- | -------------------------- | -------------- |
| id            | TEXT PK                    | UUID           |
| user_id       | TEXT NOT NULL              | 索引           |
| credential_id | TEXT NOT NULL              | 唯一索引       |
| public_key    | TEXT NOT NULL              | base64         |
| counter       | INTEGER NOT NULL DEFAULT 0 | 每次认证后更新 |
| transports    | TEXT NOT NULL DEFAULT ''   | JSON 数组文本  |
| created_at    | TEXT NOT NULL              |                |
| last_used_at  | TEXT NULL                  |                |

passkey 是否可用由该用户是否有行推导，没有开关列。

### sessions

| 列                                   | 类型                       | 说明                                 |
| ------------------------------------ | -------------------------- | ------------------------------------ |
| id                                   | TEXT PK                    | 行 UUID（对外只作为会话列表的 `id`） |
| token_hash                           | TEXT NOT NULL UNIQUE       | Cookie 令牌的 SHA-256                |
| user_id                              | TEXT NOT NULL              | 索引                                 |
| needs_2fa_setup                      | INTEGER NOT NULL DEFAULT 0 | 1 = 受限会话（强制配置 2FA）         |
| created_at, last_seen_at, expires_at | INTEGER NOT NULL           | Unix 秒                              |
| ip, user_agent                       | TEXT NOT NULL DEFAULT ''   |                                      |

### auth_challenges（一次性挑战）

| 列                     | 类型                     | 说明                                                                           |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| key                    | TEXT PK                  | `SHA-256(令牌)` 或 `SHA-256("<purpose>:<uid>")`，不存原值                      |
| user_id                | TEXT NOT NULL            |                                                                                |
| purpose                | TEXT NOT NULL            | `2fa_login` / `totp_setup` / `passkey_register` / `passkey_auth` / `totp_used` |
| payload                | TEXT NOT NULL DEFAULT '' | 挑战原文 / 加密后的 TOTP 待确认密钥                                            |
| expires_at, created_at | INTEGER NOT NULL         | 均为 5 分钟过期（`totp_used` 90 秒）                                           |

消费语义：先读后 `DELETE`，`meta.changes=0` 视为已被消费；过期行在写入时顺带清理。

### auth_counters（权威限流/锁定）

| 列           | 类型                     | 说明                      |
| ------------ | ------------------------ | ------------------------- |
| key          | TEXT PK                  | `<action>:<account>:<ip>` |
| action       | TEXT NOT NULL            | 见下表                    |
| account      | TEXT NOT NULL DEFAULT '' | 邮箱/用户 id/空           |
| ip           | TEXT NOT NULL DEFAULT '' | 客户端 IP                 |
| count        | INTEGER NOT NULL         |                           |
| window_start | INTEGER NOT NULL         | Unix 秒                   |
| locked_until | INTEGER NULL             | Unix 秒                   |
| updated_at   | INTEGER NOT NULL         |                           |

单条 `INSERT … ON CONFLICT(key) DO UPDATE` 原子自增，窗口过期自动重置；登录成功按账号删除失败/锁定行。

| action          | account | 上限 / 窗口    | 说明                                               |
| --------------- | ------- | -------------- | -------------------------------------------------- |
| login           | 空      | 10 次 / 5 分钟 | 每 IP                                              |
| login_fail      | 邮箱    | 5 次 / 15 分钟 | 第 5 次起锁 15 分钟                                |
| register        | 空      | 5 次 / 5 分钟  | 每 IP                                              |
| 2fa_verify      | 空      | 5 次 / 5 分钟  | 每 IP；另按 tempToken 记失败，5 次作废令牌         |
| password_change | 用户 id | 5 次 / 5 分钟  |                                                    |
| reauth          | 用户 id | 5 次 / 5 分钟  | 2FA 敏感操作（关 TOTP、删/关 passkey）的密码重认证 |
| setup           | 空      | 3 次 / 10 分钟 | 每 IP，初始化前也生效                              |

### system_settings

`key` TEXT PK、`value` TEXT、`updated_at` TEXT。键与默认值：

| key                            | 值               | 默认           |
| ------------------------------ | ---------------- | -------------- |
| setup_page_enabled             | `0` / `1`        | 初始化后写 `0` |
| registration_enabled           | `true` / `false` | `true`         |
| registration_approval_required | `true` / `false` | `true`         |
| require_2fa                    | `true` / `false` | `false`        |

### pages

| 列                     | 类型                       | 说明                |
| ---------------------- | -------------------------- | ------------------- |
| id                     | TEXT PK                    | UUID                |
| parent_id              | TEXT NULL                  | 根页为 NULL         |
| title                  | TEXT NOT NULL              |                     |
| sort_order             | INTEGER NOT NULL DEFAULT 0 | 同级 0..n-1         |
| content_json           | TEXT NOT NULL DEFAULT ''   | TipTap JSON 文本    |
| content_html           | TEXT NOT NULL DEFAULT ''   | 服务端消毒后的 HTML |
| content_text           | TEXT NOT NULL DEFAULT ''   | 供搜索/摘要         |
| created_by, updated_by | TEXT NOT NULL              | 用户 id             |
| created_at, updated_at | TEXT NOT NULL              | ISO 时间            |
| deleted_at             | TEXT NULL                  | 软删时间            |

索引：`(parent_id, sort_order)`、`(deleted_at)`、`(updated_at)`。

### page_revisions

`id` TEXT PK、`page_id` TEXT NOT NULL、`title`、`content_json`、`content_html`、`content_text`、`editor_id` TEXT NOT NULL、`created_at` TEXT NOT NULL；索引 `(page_id, created_at DESC)`。每次新建/保存/回滚都追加一条。

### pages_fts（FTS5 虚拟表）

```sql
CREATE VIRTUAL TABLE {prefix}pages_fts USING fts5(page_id UNINDEXED, title, content_text)
```

**同步方式**（不做触发器）：新建/保存/回滚时在同一个 `db.batch()` 事务里写 pages → 插 revision → `DELETE FROM pages_fts WHERE page_id=?` → 插入新索引行；软删/彻底删同批删除索引行；恢复同批重建。索引与查询都做 CJK 逐字空格化（`团队` → `团 队`）：CJK 词按短语 `"团 队"`、拉丁词按前缀 `"ciki"*`，多词 AND；排序 `bm25(fts, 0, 10, 1)`。

## 三、API

### setup

#### GET /api/setup/state（公开，no-store）

```json
{ "initialized": false, "enabled": true }
```

`initialized` = `{prefix}system_settings` 表存在；`enabled` = 未初始化恒 `true`，否则 `setup_page_enabled !== "0"`。不含表前缀与任何密钥，客户端用 `enabled` 决定是否展示初始化入口。

#### POST /api/setup（公开）

- 请求头：`X-Setup-Secret: <SETUP_SECRET>`（**只认请求头**，URL 参数无效；`GET /api/setup` 及 `/api/setup/*` 的其它 GET 返回 405 JSON）。
- 请求体：无。
- 200：

```json
{
  "success": true,
  "tablePrefix": "ciki_",
  "migrations": [{ "name": "schema_v1", "status": "applied" }]
}
```

`status` 为 `applied` 或 `skipped`（已初始化后再调用只做幂等检查/迁移，全部 `skipped`）。

- 403 `{"error":"Invalid setup secret"}`；409：

```json
{
  "success": false,
  "code": "PREFIX_CONFLICT",
  "error": "…",
  "resolvedPrefix": "ciki_",
  "detectedPrefixes": ["other_"]
}
```

（检测到另一前缀下已初始化，或当前前缀被非 ciki 的 `users` 表占用时中止，绝不另建第二套表、也不静默复用别人的表）

- 409 的判定依据是 ciki 专属三件套 `users` + `pages` + `pages_fts`：另一前缀下三者齐备才算“已在本库初始化”；当前前缀已被一张非 ciki 结构的 `users` 表占用时同样 409（`code` 仍为 `PREFIX_CONFLICT`，`error` 说明冲突表），绝不静默复用别人的表。
- 429：每 IP 每 10 分钟 3 次。
- 初始化完成时显式写 `setup_page_enabled=0`（只门控页面，不门控密钥接口）。

#### POST /api/admin/setup（管理员会话，免密钥）

与 `POST /api/setup` 同形状；非管理员 403。

### 鉴权

#### GET /api/auth/config（公开）

```json
{ "registrationEnabled": true, "registrationApprovalRequired": true }
```

#### POST /api/auth/register

```json
{ "email": "a@b.c", "password": "至少 8 位" }
```

- 201 `{"success":true,"approvalRequired":false}`。
- 用户表为空时：首个用户为 `admin`、直接批准并激活；否则按 `registration_approval_required` 落 `pending`（`approvalRequired: true`）或直接批准。
- 400 校验失败；403 `code:"REGISTRATION_DISABLED"`；409 `code:"EMAIL_TAKEN"`。

#### POST /api/auth/login

```json
{ "email": "a@b.c", "password": "…" }
```

响应之一：

```json
{ "success": true, "user": { "id": "…", "email": "…", "role": "admin" } }
```

```json
{
  "requires2fa": true,
  "tempToken": "…",
  "availableMethods": ["totp", "passkey"]
}
```

```json
{
  "success": true,
  "needs2faSetup": true,
  "user": { "id": "…", "email": "…", "role": "user" }
}
```

- 第一种与第三种同时下发 `ciki_session` Cookie；第三种是受限会话（`require_2fa` 打开且用户未配置任何方法），只能访问 `/api/me`、`/api/auth/logout`、`/api/auth/2fa/totp/*`、`/api/auth/2fa/passkey/*`。
- `tempToken` 是 5 分钟有效的一次性登录挑战，交给 2FA 验证步骤。
- 失败：401 `{"error":"Invalid credentials"}`；403 `{"error":"…","code":"ACCOUNT_PENDING_APPROVAL"|"ACCOUNT_REJECTED"}`；429 `{"error":"Too many requests","code":"RATE_LIMITED"}` 或 `{"error":"Account locked","code":"ACCOUNT_LOCKED","retryAfter":秒}`。

#### POST /api/auth/2fa/verify

```json
{ "tempToken": "…", "method": "totp", "code": "123456" }
```

成功：200 `{"success":true,"user":{…}}` + `ciki_session` Cookie。失败：401（挑战无效/过期/验证码错），同一 `tempToken` 失败 5 次后作废。

#### POST /api/auth/2fa/passkey/authenticate/options

```json
{ "tempToken": "…" }
```

返回 `@simplewebauthn` 的 PublicKeyCredentialRequestOptions（含 `challenge`）。

#### POST /api/auth/2fa/passkey/authenticate/verify

请求体 = 上一步 `tempToken` + WebAuthn assertion 字段（`id`、`rawId`、`response`、`type` 等）。成功：200 `{"success":true,"user":{…}}` + Cookie。

#### POST /api/auth/logout

删除当前会话行并清 Cookie：`{"success":true}`。

#### POST /api/auth/refresh

用当前 Cookie 轮换令牌（换新 `token_hash`、过期推到 7 天后，回写 Cookie）：200 `{"success":true}`；无/过期/已吊销 401。

### 我的

#### GET /api/me

```json
{
  "id": "…",
  "email": "…",
  "role": "admin",
  "approvalStatus": "approved",
  "createdAt": "2026-11-07T12:00:00.000Z",
  "twofa": { "totpEnabled": false, "passkeyEnabled": false, "passkeyCount": 0 }
}
```

受限会话也可访问（前端据此跳 2FA 设置）。

#### PUT /api/me/password

```json
{ "currentPassword": "…", "newPassword": "…" }
```

200 `{"success":true}`，删除该用户其它会话行（当前会话保留）。

#### GET /api/me/sessions

```json
[
  {
    "id": "会话行 id",
    "createdAt": "…",
    "lastSeenAt": "…",
    "ip": "…",
    "userAgent": "…",
    "current": true
  }
]
```

#### DELETE /api/me/sessions/:id

删行即吊销：200 `{"success":true}`；当前会话 400。

### 2FA 管理（均需会话）

| 端点                                          | 请求体                         | 响应                                                                                    |
| --------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| `POST /api/auth/2fa/totp/setup`               | 无                             | `{"secret":"BASE32","uri":"otpauth://…"}`（明文只回这一次，待确认密钥以密文存挑战行）   |
| `POST /api/auth/2fa/totp/enable`              | `{"code":"123456"}`            | `{"success":true}`；消费挑战行、解密校验后把密文落 `user_2fa`，并把当前受限会话标记清零 |
| `POST /api/auth/2fa/totp/disable`             | `{"password":"…"}`             | `{"success":true}`，清空密文与开关                                                      |
| `POST /api/auth/2fa/passkey/register/options` | 无                             | WebAuthn 注册 options（写 `passkey_register` 挑战行）                                   |
| `POST /api/auth/2fa/passkey/register/verify`  | WebAuthn registration response | `{"success":true}`；消费挑战行、插 `passkey_credentials`，并把受限会话标记清零          |
| `DELETE /api/auth/2fa/passkey/:credentialId`  | `{"password":"…"}`             | `{"success":true}`；删除该凭证行                                                        |
| `POST /api/auth/2fa/passkey/disable`          | `{"password":"…"}`             | `{"success":true}`；删除该用户全部凭证                                                  |

所有 2FA 变更在密码错误时返回 403 `{"error":"Password is incorrect"}`。

### 管理（全部需管理员，非管理员 403）

#### GET /api/admin/users?status=all|pending

```json
[
  {
    "id": "…",
    "email": "…",
    "role": "user",
    "isActive": false,
    "approvalStatus": "pending",
    "createdAt": "…"
  }
]
```

#### POST /api/admin/users

```json
{ "email": "…", "password": "…", "role": "user" }
```

201，直接批准并激活。

#### PUT /api/admin/users/:id

```json
{ "role": "admin", "isActive": true, "email": "…", "password": "…" }
```

字段均可选。不能改自己的角色、不能停用自己。改角色/停用/改密码后吊销该用户全部会话。

#### DELETE /api/admin/users/:id

不能删自己；删除用户及其 2FA/passkey/会话行。

#### POST /api/admin/users/:id/approve

把用户置为 `approved` + `isActive: true`。

#### POST /api/admin/users/:id/reject

把用户置为 `rejected` + `isActive: false`，吊销其全部会话。

#### GET /api/admin/settings

```json
{
  "setupPageEnabled": false,
  "registrationEnabled": true,
  "registrationApprovalRequired": true,
  "require2fa": false
}
```

#### PUT /api/admin/settings

同一对象的任意子集，值为布尔：200 `{"success":true}`。

### 页面

#### GET /api/pages

页面树（不含正文，不含回收站）：

```json
[
  {
    "id": "…",
    "parentId": null,
    "title": "首页",
    "sortOrder": 0,
    "updatedAt": "…",
    "children": []
  }
]
```

#### GET /api/pages/trash

只列回收站根（父页仍可见或已在更早批次删除的不重复列出）：

```json
[
  {
    "id": "…",
    "parentId": null,
    "title": "…",
    "deletedAt": "…",
    "updatedAt": "…"
  }
]
```

#### GET /api/pages/:id

```json
{
  "id": "…",
  "parentId": null,
  "title": "…",
  "sortOrder": 0,
  "contentJson": "{\"type\":\"doc\",…}",
  "contentHtml": "<p>…</p>",
  "contentText": "…",
  "createdBy": "用户 id",
  "updatedBy": "用户 id",
  "createdAt": "…",
  "updatedAt": "…"
}
```

已软删返回 404。

#### POST /api/pages

```json
{
  "title": "新页面",
  "parentId": null,
  "contentJson": "…",
  "contentHtml": "<p>…</p>",
  "contentText": "…"
}
```

201 返回完整详情；新页追加到同级末尾；首次创建同时生成一条 revision。`contentHtml` 由服务端二次消毒后入库。

#### PUT /api/pages/:id

```json
{ "title": "…", "contentJson": "…", "contentHtml": "…", "contentText": "…" }
```

200 完整详情。登录用户可编辑任何页面（wiki 语义）；每次保存生成一条 revision 并同步 FTS。

#### POST /api/pages/:id/move

```json
{ "parentId": "目标父页或 null", "sortOrder": 0 }
```

`sortOrder` 可省略（追加到末尾）。只改层级/排序，不生成 revision。移入自身子树 409 `code:"PAGE_MOVE_CYCLE"`；父页已删 409 `code:"PARENT_DELETED"`。

#### DELETE /api/pages/:id

软删整棵子树（同一个 `deletedAt`）：`{"success":true}`。限页面 `createdBy` 或管理员。

#### POST /api/pages/:id/restore

恢复同一批被删的子树：`{"success":true}`。父页仍在回收站时 409 `code:"PARENT_DELETED"`。

#### DELETE /api/pages/:id/permanent

仅对已软删页面生效；删页面、其全部 revision 与 FTS 行：`{"success":true}`；未软删 409 `code:"PAGE_NOT_DELETED"`。

#### GET /api/pages/:id/revisions

```json
[{ "id": "…", "title": "…", "editorId": "用户 id", "createdAt": "…" }]
```

新 → 旧。

#### GET /api/pages/:id/revisions/:revisionId

```json
{
  "id": "…",
  "pageId": "…",
  "title": "…",
  "contentJson": "…",
  "contentHtml": "…",
  "contentText": "…",
  "editorId": "…",
  "createdAt": "…"
}
```

#### POST /api/pages/:id/revisions/:revisionId/restore

以该快照写回页面并生成新 revision，返回 200 完整页面详情。限页面 `createdBy` 或管理员。

### 搜索

#### GET /api/search?q=团队&limit=20

```json
{
  "query": "团队",
  "results": [
    {
      "pageId": "…",
      "title": "团队知识库",
      "snippet": "…命中附近的纯文本片段…",
      "updatedAt": "…"
    }
  ]
}
```

`snippet` 是纯文本（不含 HTML），前端自行高亮查询词。空词或只有标点返回 `{"query":"…","results":[]}`。软删页面不出现；`limit` 上限 50。

### 文件

#### POST /api/files

`multipart/form-data`，字段名 `file`。仅 png/jpg/jpeg/gif/webp（按魔数校验，拒 svg 与伪装文件），单张上限 10 MB。

201：

```json
{
  "key": "d025c64d-ffd7-4a13-b6d8-527f88643536.png",
  "url": "/api/files/d025c64d-ffd7-4a13-b6d8-527f88643536.png",
  "contentType": "image/png",
  "size": 12345
}
```

400 非图片/类型不符；413 `code:"FILE_TOO_LARGE"`。

#### GET /api/files/:key

需会话；返回图片字节，`Content-Type` 为上传时类型，带 `ETag` 与 `Cache-Control: private, max-age=3600`。不存在 404；未登录 401 + no-store。

### 服务端消毒规则（content_html）

保存/回滚时执行：保留结构性标签与下列属性，其余一律剥除。

- 表格：`colspan` / `rowspan`（td/th）、`col` 的 `width` 或受限 `style`（仅 `width`/`min-width` 的 px/% 数值）、`table` 的受限 `style`（仅 `min-width: Npx`）、`colgroup`。
- 代码：`code[class="language-*"]`。
- 任务列表：`ul[data-type]`、`li[data-type][data-checked]`、`label`、只读 `input[type=checkbox][checked]`。
- 链接：`a[href]` 仅 http/https/mailto/相对路径。
- 图片：`img[src]` 仅本站 `/api/files/<uuid>.<ext>` 或 `data:image/(png|jpeg|gif|webp);base64,…`；其它 `src` 移入 `data-original-src` 并加 `data-confluence-img="true"`（「未转存」标记，读态由前端渲染占位并提供上传替换入口）。
- 一律剥除 `script`/`style`/`iframe`/`object`/`embed`/`form` 及所有 `on*` 事件属性、未列出的 class/attr。

## 四、前端对接要点

- 所有请求带 `credentials: "include"`；收到 401 时先 `POST /api/auth/refresh` 重试一次，仍 401 再跳登录。
- 登录两步：`requires2fa` 时用 `tempToken` 调 TOTP 或 passkey 验证端点；两步表单必须换 DOM 节点（前端单要求）。
- 受限会话（`needs2faSetup`）：只能进 2FA 设置，配置成功后受限标记自动清零，无需重新登录。
- 页面读态渲染 `contentHtml`；编辑态使用 `contentJson`。外链图片以 `data-original-src` + `data-confluence-img` 呈现「未转存」。
- 主题等纯前端偏好不进本契约（客户端持久化）。
- 本契约不含：公开分享、多人实时协同、评论、宏、Jira、通用附件、Markdown 存储、邮件相关端点。
