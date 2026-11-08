# ciki 后端 API 契约与数据模型（冻结）

本文件由后端实现单在计划确认后冻结，是前端实现单的接口依据。实现期如需变更，先上报 Chief 裁决，**不得单方面改动**；改动必须同步更新本文件。

- 服务端入口：`worker/src/index.ts`（Hono），部署单元同时托管前端静态资源。
- 表名一律经 `worker/src/lib/tables.ts` 拼当前部署的 `TABLE_PREFIX`（默认 `ciki_`，可显式无前缀），本文只用逻辑表名。
- 响应字段一律 camelCase；数据库列名 snake_case，二者在路由层转换。

## 一、通用约定

- **鉴权**：全站登录后可见。除下列公开端点与 `/api/import/*` 外，所有 `/api/*` 都必须带会话 Cookie；未登录一律 `401 {"error":"Unauthorized"}`，且响应头 `Cache-Control: no-store`。`/api/import/*` 是插件专用入口，只认 `Authorization: Bearer <个人导入令牌>`，**不接受会话 Cookie**（见「导入（个人令牌）」）。
  - 公开：`GET /api/health`、`GET /api/setup/state`、`POST /api/setup`、`GET /api/auth/config`、`POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`、`POST /api/auth/refresh`、`POST /api/auth/2fa/verify`、`POST /api/auth/2fa/passkey/authenticate/options`、`POST /api/auth/2fa/passkey/authenticate/verify`。
  - 另有不在 `/api` 下的公开入口 `POST /_waker/execute`（waker 回调，靠 HMAC 签名自证，不认会话 Cookie，见「waker 回调」）。
- **会话 Cookie**：名字 `ciki_session`，值为 32 字节随机不透明令牌（base64url）。属性：`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`（7 天，`refresh` 会滑动续期）。服务端只存令牌的 SHA-256，不存原值；登出、改密、管理员停用/拒绝都会删会话行，删行即吊销。
- **空间可见性**：站点管理员可见全部空间；普通用户仅可见自己是成员的空间（`admin` / `editor` / `viewer`）。可见性过滤覆盖空间列表、页面树、页面直链、回收站与搜索；非成员访问空间/页面一律 404，不泄露存在性。页面写权限以空间角色为准：`editor` 及以上可写，`viewer` 只读。
- **错误体**：`{"error": string, "code"?: string, "retryAfter"?: number}`。常用状态码：400 校验失败、401 未登录/凭证错、403 权限或审批、404 不存在、409 冲突、413 体积超限、429 限流/锁定、500 服务端错误（不回显堆栈）。
- **时间**：所有时间字段均为 ISO 8601 字符串（`2026-11-07T12:00:00.000Z`），会话过期等内部字段用 Unix 秒但不出现在 DTO 中。
- **分页**：页面树与用户列表不分页；搜索用 `limit`（默认 20，上限 50）。
- **内容上限**：标题 1–255 字符；`contentJson` ≤ 800,000 字节；`contentHtml` 以**服务端消毒后**的字节数计 ≤ 800,000 字节；`contentText` 规范化后 ≤ 300,000 字节；三件套合计 ≤ 1,900,000 字节（D1 单行上限 2 MB）。超限 `413 {"error":"Payload too large","code":"PAYLOAD_TOO_LARGE"}`。
- **纯文本字段**：`title` 与 `contentText` 保存时剥除 HTML 标签并折叠空白，入库与搜索片段都不含 HTML 语法。
- **脱敏**：任何 DTO 都不返回 `password_hash`、TOTP 密文、passkey `public_key`、会话令牌或挑战原值。

## 二、数据模型

迁移五条，均为追加式、全部 `CREATE … IF NOT EXISTS`，账本表为 `{prefix}schema_migrations`（记录 `name`、`applied_at`，已执行的迁移只做幂等检查、显示为 `skipped`）：

- `schema_v1`：鉴权、设置、页面、版本与 FTS 的全部表。
- `schema_v2`：导入令牌表 `{prefix}import_tokens`（v1.1 增补）。
- `schema_v3`：users 的身份三列（`username` / `public_id` / `avatar_key`）与 `public_id` 的部分唯一索引。SQLite 没有 `ADD COLUMN IF NOT EXISTS`，所以加列与存量回填放在该迁移的 `prepare` 步骤（先于 sql 执行）：按 `PRAGMA table_info` 判断缺哪列再补，随后只把新列里**仍为空**的值填上（`username` 取邮箱前缀、`public_id` 用系统生成器并与全表已有值去重），更新都带 `WHERE … = ''`，因此不覆盖任何既有数据、可重复执行、失败后从断点续跑。
- `schema_v4`：空间与成员（`{prefix}spaces` / `{prefix}space_members`）、`pages.space_id` 与空间索引。`prepare` 幂等补列、建默认空间（id `space-default`、名称「默认空间」、`is_default=1`）、把所有 `space_id` 仍为空/缺失的页面回填到默认空间、把所有现有用户加入默认空间（站点管理员 `admin`、其余 `editor`）。只写空值、成员用 `INSERT OR IGNORE`，重复执行无副作用。
- `schema_v5`：R2 孤儿清理的运行日志 `{prefix}r2_cleanup_runs`（每轮一行）与 waker 回调的幂等账本 `{prefix}waker_executions`（列照 waker 客户端 SDK 的 `executionLedgerDdl()`）。纯新增表、无 `prepare`。

回滚方式：人工删除对应迁移新建的表/索引（`schema_v3` 为 `{prefix}users_public_id`；`schema_v4` 为 `{prefix}spaces`、`{prefix}space_members` 与 `pages` 的空间列/索引；`schema_v5` 为 `{prefix}r2_cleanup_runs`、`{prefix}waker_executions`），并从账本删掉该迁移行（`DELETE FROM {prefix}schema_migrations WHERE name = 'schema_v1'|'schema_v2'|'schema_v3'|'schema_v4'|'schema_v5'`）；生产库执行前必须经用户批准；UI 不提供删表/清库入口。

### users

| 列                                                       | 类型                             | 说明                                                                                                                    |
| -------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| id                                                       | TEXT PK                          | UUID（内部主键，不对外展示为「用户 ID」）                                                                               |
| email                                                    | TEXT UNIQUE NOT NULL             | 写入前 trim + 小写；库内 UNIQUE 是唯一性的最终防线                                                                      |
| username                                                 | TEXT NOT NULL DEFAULT ''         | 显示名，用户可改、**不要求唯一**；缺省取邮箱前缀                                                                        |
| public_id                                                | TEXT NOT NULL DEFAULT ''         | 8 位系统生成的对外用户 ID，唯一、生成后不可改                                                                           |
| avatar_key                                               | TEXT NOT NULL DEFAULT ''         | 头像在 R2 的 key：新上传为 `avatars/<uuid>.<ext>`，存量可为平铺 `<uuid>.<ext>`；读接口 `/api/files/:key`；空串 = 无头像 |
| password_hash                                            | TEXT NOT NULL                    | PBKDF2-SHA256（100k 次），格式 `saltHex:hashHex`                                                                        |
| role                                                     | TEXT NOT NULL DEFAULT 'user'     | `admin` / `user`                                                                                                        |
| is_active                                                | INTEGER NOT NULL DEFAULT 1       | 0/1                                                                                                                     |
| approval_status                                          | TEXT NOT NULL DEFAULT 'approved' | `pending` / `approved` / `rejected`                                                                                     |
| email_verified, base_currency, timezone, language, theme | —                                | 照 eNotify 保留，ciki 不使用、不暴露                                                                                    |
| created_at, updated_at                                   | TEXT NOT NULL                    | ISO 时间                                                                                                                |

索引：`{prefix}users_public_id` 是 `public_id` 上的部分唯一索引（`WHERE public_id <> ''`）：未回填的空串不参与唯一性，回填完成后由数据库兜底并发建号的撞键。`public_id` 的字符表为 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`（去掉易混的 0/O/1/I/L），长度固定 8。

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

| action          | account | 上限 / 窗口    | 说明                                                       |
| --------------- | ------- | -------------- | ---------------------------------------------------------- |
| login           | 空      | 10 次 / 5 分钟 | 每 IP                                                      |
| login_fail      | 邮箱    | 5 次 / 15 分钟 | 第 5 次起锁 15 分钟                                        |
| register        | 空      | 5 次 / 5 分钟  | 每 IP                                                      |
| 2fa_verify      | 空      | 5 次 / 5 分钟  | 每 IP；另按 tempToken 记失败，5 次作废令牌                 |
| password_change | 用户 id | 5 次 / 5 分钟  |                                                            |
| reauth          | 用户 id | 5 次 / 5 分钟  | 2FA 敏感操作（新增/启用/关闭因子、删 passkey）的密码重认证 |
| setup           | 空      | 3 次 / 10 分钟 | 每 IP，初始化前也生效                                      |

### system_settings

`key` TEXT PK、`value` TEXT、`updated_at` TEXT。键与默认值：

| key                            | 值               | 默认           |
| ------------------------------ | ---------------- | -------------- |
| site_name                      | 站点名称         | `Ciki`         |
| setup_page_enabled             | `0` / `1`        | 初始化后写 `0` |
| registration_enabled           | `true` / `false` | `true`         |
| registration_approval_required | `true` / `false` | `true`         |
| require_2fa                    | `true` / `false` | `false`        |

`site_name` 是站点作用域的单值（浏览器页签标题、品牌区文字、登录页标题），仅管理员可改，长度 1–32 字符、不含控制字符；未播种时读端回退 `Ciki`。

### import_tokens（个人导入令牌）

| 列           | 类型          | 说明                                         |
| ------------ | ------------- | -------------------------------------------- |
| user_id      | TEXT PK       | 每用户一行；生成/重置即覆盖，不新增行        |
| token_hash   | TEXT NOT NULL | 令牌的 SHA-256 hex（与会话同口径），唯一索引 |
| created_at   | TEXT NOT NULL | ISO 时间；重置时刷新                         |
| last_used_at | TEXT NULL     | 每次通过该令牌调用导入接口时更新             |
| revoked_at   | TEXT NULL     | 非空即吊销                                   |

- 明文只存于生成/重置响应一次，库内只有哈希；不设过期列。
- 失效条件：吊销、重置、用户被停用或未批准。校验每次回表并连 `users` 查激活/审批状态，所以停用立即生效。
- 令牌只用于 `/api/import/*`，权限等同本人；令牌管理本身仍要会话 Cookie。

### spaces（schema_v4）

| 列                     | 类型                       | 说明                                              |
| ---------------------- | -------------------------- | ------------------------------------------------- |
| id                     | TEXT PK                    | 空间 id；默认空间固定为 `space-default`           |
| name                   | TEXT NOT NULL              | 名称，1–64 码点、不含控制字符                     |
| description            | TEXT NOT NULL DEFAULT ''   | 描述，≤500 码点（允许换行）                       |
| is_default             | INTEGER NOT NULL DEFAULT 0 | 1 = 默认空间；部分唯一索引保证全库只有一条        |
| created_by             | TEXT NOT NULL DEFAULT ''   | 创建者用户 id；默认空间取最早一名站点管理员或空串 |
| created_at, updated_at | TEXT NOT NULL              | ISO 时间                                          |

默认空间不可删除；其它空间只有在没有任何页面行（含回收站）时才可删除。

### space_members（schema_v4）

| 列         | 类型          | 说明                                   |
| ---------- | ------------- | -------------------------------------- |
| space_id   | TEXT NOT NULL | 空间 id                                |
| user_id    | TEXT NOT NULL | 用户 id                                |
| role       | TEXT NOT NULL | `admin` / `editor` / `viewer`（CHECK） |
| created_at | TEXT NOT NULL | ISO 时间                               |

主键 `(space_id, user_id)`；索引 `(user_id)`。空间至少保留一名 `admin`（改角色/移除最后一名 admin → 409 `LAST_SPACE_ADMIN`）。

### pages

| 列                     | 类型                       | 说明                              |
| ---------------------- | -------------------------- | --------------------------------- |
| id                     | TEXT PK                    | UUID                              |
| space_id               | TEXT NOT NULL DEFAULT ''   | 所属空间；schema_v4 回填默认空间  |
| parent_id              | TEXT NULL                  | 根页为 NULL；父子关系只在同空间内 |
| title                  | TEXT NOT NULL              |                                   |
| sort_order             | INTEGER NOT NULL DEFAULT 0 | 同级 0..n-1                       |
| content_json           | TEXT NOT NULL DEFAULT ''   | TipTap JSON 文本                  |
| content_html           | TEXT NOT NULL DEFAULT ''   | 服务端消毒后的 HTML               |
| content_text           | TEXT NOT NULL DEFAULT ''   | 供搜索/摘要                       |
| created_by, updated_by | TEXT NOT NULL              | 用户 id                           |
| created_at, updated_at | TEXT NOT NULL              | ISO 时间                          |
| deleted_at             | TEXT NULL                  | 软删时间                          |

索引：`(space_id, parent_id, sort_order)`、`(space_id, deleted_at)`、`(parent_id, sort_order)`、`(deleted_at)`、`(updated_at)`。

### page_revisions

`id` TEXT PK、`page_id` TEXT NOT NULL、`title`、`content_json`、`content_html`、`content_text`、`editor_id` TEXT NOT NULL、`created_at` TEXT NOT NULL；索引 `(page_id, created_at DESC)`。每次新建/保存/回滚都追加一条。

### pages_fts（FTS5 虚拟表）

```sql
CREATE VIRTUAL TABLE {prefix}pages_fts USING fts5(page_id UNINDEXED, title, content_text)
```

**同步方式**（不做触发器）：新建/保存/回滚时在同一个 `db.batch()` 事务里写 pages → 插 revision → `DELETE FROM pages_fts WHERE page_id=?` → 插入新索引行；软删/彻底删同批删除索引行；恢复同批重建。索引与查询都做 CJK 逐字空格化（`团队` → `团 队`）：CJK 词按短语 `"团 队"`、拉丁词按前缀 `"ciki"*`，多词 AND；排序 `bm25(fts, 0, 10, 1)`。

### r2_cleanup_runs（schema_v5）

| 列                                                                  | 类型          | 说明                                                                  |
| ------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------- |
| id                                                                  | TEXT PK       | UUID                                                                  |
| started_at / finished_at                                            | TEXT NOT NULL | ISO 时间                                                              |
| trigger                                                             | TEXT NOT NULL | `cron` / `waker` / `manual`                                           |
| status                                                              | TEXT NOT NULL | `ok`（跑完）/ `skipped`（20 天幂等兜底命中）/ `failed`（扫描期异常）  |
| dry_run                                                             | INTEGER       | 1 = 只算不删；dry_run 行不计入 20 天兜底、也不进「最近一轮」          |
| scanned / referenced / deleted / young_skipped / failed / truncated | INTEGER       | 扫描数 / 引用数 / 删除数 / 未满 30 天跳过数 / 失败数 / 是否因上限截断 |

索引 `(started_at)`。每轮一行，不含任何对象内容；清理自身不写其它表。

### waker_executions（schema_v5）

waker 客户端 SDK 的 `executionId` 幂等账本：`execution_id` TEXT PK、`job_id`、`job_name`、`scheduled_for` INTEGER、`status`（`claimed` / `succeeded`）、`response_json`、`claimed_at`、`completed_at`。平台重试同一次执行时带同一个 `executionId`，由 SDK 原子认领去重；ciki 只负责建表，不改实现。

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

#### POST /api/admin/r2-cleanup（管理员会话）

手动触发一轮 R2 孤儿清理——§3 的验收通道，页面不提供按钮（curl 用）。

请求体可选：`{"dryRun": true}` 只算不删；缺省或 `false` 为真实删除。

- 真实运行与两个自动入口同口径：距上次真实成功运行不足 20 天即跳过，回 `status:"skipped"`（计数全 0），仍记一行日志；`dryRun` 永不受该限制。
- 200 返回本轮摘要（字段见下）；扫描期异常时失败行已落库，接口回 `500 {"error":"Cleanup failed"}`。

```json
{
  "startedAt": "2026-11-08T17:00:00.000Z",
  "finishedAt": "2026-11-08T17:00:01.500Z",
  "trigger": "manual",
  "status": "ok",
  "dryRun": true,
  "scanned": 42,
  "referenced": 30,
  "deleted": 5,
  "youngSkipped": 7,
  "failed": 0,
  "truncated": false
}
```

字段口径：`scanned` = R2 对象总数（分页列全桶）；`referenced` = 引用集去重后的 key 数（`users.avatar_key` ∪ 全部页面与历史版本正文里的 `/api/files/<key>`，回收站页面同样计入）；`deleted` = 本轮删除数（`dryRun` 时为「将删数」）；`youngSkipped` = 未被引用但 uploaded 距今不足 30 天而跳过的对象数；`failed` = 单个对象删除失败数（不中断整轮）；`truncated` = 是否因单轮删除上限（200）而停止删除。

#### GET /api/admin/r2-cleanup（管理员会话）

```json
{
  "lastRun": {
    "startedAt": "…",
    "finishedAt": "…",
    "trigger": "cron",
    "status": "ok",
    "dryRun": false,
    "scanned": 42,
    "referenced": 30,
    "deleted": 5,
    "youngSkipped": 7,
    "failed": 0,
    "truncated": false
  }
}
```

`lastRun` 是最近一轮**真实**运行（`dry_run=0` 且 `status<>"skipped"`），从未跑过为 `null`。这是「系统管理 → 数据库维护」页那一行摘要的唯一数据源（页面只显示这一行，不加说明文字）。

### waker 回调（`POST /_waker/execute`，不走会话）

月度清理的第二个触发入口：只看 `WAKER_SIGNING_KEY` 配没配，不设 `WAKER_MODE`。

- 已配置：waker 平台回调本入口，验签通过后执行一轮；Worker 内置 Cron 的 `scheduled()` 检测到 key 存在直接跳过（`wrangler.toml` 的 `[triggers] crons` 保留，靠 key 有无让路）。
- 未配置：本入口 fail closed，回 `500 {"ok":false,"error":{"code":"signing_key_missing"}}`，不碰数据库、不进业务；清理走内置 Cron。

协议按 waker 客户端 SDK 的冻结契约（ciki 不另发明）：头 `X-Waker-Timestamp`（epoch 秒）、`X-Waker-Execution-Id`、`X-Waker-Job-Id`、`X-Waker-Signature`（`v2=<hex>`）；HMAC-SHA256 覆盖 `<timestamp>\n<executionId>\n<jobId>\n<rawBody>`；时间窗 300s；`executionId` 由 `{prefix}waker_executions` 去重，重复投递回 200 `duplicate` 且不再跑业务。

| 状态码 | `error.code`          | 含义                                      |
| ------ | --------------------- | ----------------------------------------- |
| 400    | `invalid_request`     | 缺签名头 / 请求体非法 / id 与头不一致     |
| 401    | `invalid_signature`   | 签名校验失败                              |
| 401    | `stale_timestamp`     | 时间戳超出 300s 窗口（防重放）            |
| 404    | `unknown_job`         | 任务名不是 `monthly-r2-orphan-cleanup`    |
| 500    | `job_failed`          | 业务抛错（平台按同一 executionId 重试）   |
| 500    | `signing_key_missing` | 未配置 `WAKER_SIGNING_KEY`（fail closed） |

**管理面一次性静态注册**（舰队侧动作，ciki 不代填、不调注册 API）：

| 项       | 值                                                 |
| -------- | -------------------------------------------------- |
| 回调 URL | `https://<站点域名>/_waker/execute`                |
| 任务名   | `monthly-r2-orphan-cleanup`                        |
| cron     | `0 1 1 * *`                                        |
| 时区     | `Asia/Shanghai`（= 北京时间每月 1 日 01:00，低峰） |

### 鉴权

#### GET /api/auth/config（公开）

```json
{
  "siteName": "Ciki",
  "registrationEnabled": true,
  "registrationApprovalRequired": true
}
```

`siteName` 未登录也可读（登录页标题要用），不含敏感信息。

#### POST /api/auth/register

```json
{ "email": "a@b.c", "password": "至少 8 位" }
```

- 201 `{"success":true,"approvalRequired":false}`。
- 用户表为空时：首个用户为 `admin`、直接批准并激活；否则按 `registration_approval_required` 落 `pending`（`approvalRequired: true`）或直接批准。
- 服务端自动生成 `public_id`（8 位、唯一）并把 `username` 初始化为邮箱前缀（按码点截断 40），客户端不能指定这两个值。
- 400 校验失败；403 `code:"REGISTRATION_DISABLED"`；409 `code:"EMAIL_TAKEN"`（唯一约束冲突一律映射成这个 409，含并发撞键）。

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
  "publicId": "7FJ2K9QM",
  "username": "alice",
  "email": "…",
  "role": "admin",
  "avatarUrl": "/api/files/avatars/<uuid>.png",
  "approvalStatus": "approved",
  "createdAt": "2026-11-07T12:00:00.000Z",
  "twofa": { "totpEnabled": false, "passkeyEnabled": false, "passkeyCount": 0 }
}
```

`publicId` 是对外展示的「用户 ID」（8 位、不可改），`id` 仍是内部 UUID。`avatarUrl` 未设置头像时为 `null`；图片本身要会话才能读。受限会话也可访问（前端据此跳 2FA 设置）。

#### PUT /api/me/profile

```json
{ "username": "观察者", "avatarKey": "<uuid>.png" }
```

- 字段均可选，但至少给一个，否则 400 `{"error":"Nothing to update"}`；200 返回与 `GET /api/me` 完全相同的对象。
- `username`：trim 后 1–40 个码点、不含控制字符，否则 400 `code:"INVALID_USERNAME"`；不要求唯一。
- `avatarKey`：**兼容保留，前端不再使用**（改头像走下面的 `POST /api/me/avatar`）。取值必须是本人上传过、且 R2 中仍存在的 key——平铺 `<uuid>.<ext>` 或带已知前缀（`avatars/` / `pages/` / `imports/`）都收；`null` 表示清除头像；其它 400 `code:"INVALID_AVATAR"`。换成新头像后旧对象被删除。
- `id` / `email` / `publicId` 只读：传了也不生效（只认上面两个字段）。

#### POST /api/me/avatar（需会话）

头像专用上传口。`multipart/form-data`，字段名 `file`，单文件；校验口径与 `POST /api/files` 完全一致（仅 png/jpg/jpeg/gif/webp、按魔数校验、拒 svg 与伪装文件、单张 ≤10MB），落 `avatars/<uuid>.<ext>`，R2 `customMetadata` 记 `uploaderId` 与 `category:"avatars"`。

同一请求内完成「写入本人 `avatar_key` → 删除旧头像对象」（旧图删不掉只留孤儿对象，不影响响应）。200 返回与 `GET /api/me` 完全相同的对象，前端一次拿到新的 `avatarUrl`：

```json
{
  "id": "…",
  "publicId": "7FJ2K9QM",
  "username": "alice",
  "email": "…",
  "role": "admin",
  "avatarUrl": "/api/files/avatars/<uuid>.png",
  "approvalStatus": "approved",
  "createdAt": "…",
  "twofa": { "totpEnabled": false, "passkeyEnabled": false, "passkeyCount": 0 }
}
```

400 缺少 `file` / 非图片；413 `code:"FILE_TOO_LARGE"`；401 未登录。

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

| 端点                                          | 请求体                          | 响应                                                                                    |
| --------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| `POST /api/auth/2fa/totp/setup`               | `password?`（见下）             | `{"secret":"BASE32","uri":"otpauth://…"}`（明文只回这一次，待确认密钥以密文存挑战行）   |
| `POST /api/auth/2fa/totp/enable`              | `{"code":"123456","password"?}` | `{"success":true}`；消费挑战行、解密校验后把密文落 `user_2fa`，并把当前受限会话标记清零 |
| `POST /api/auth/2fa/totp/disable`             | `{"password":"…"}`              | `{"success":true}`，清空密文与开关                                                      |
| `POST /api/auth/2fa/passkey/register/options` | `password?`（见下）             | WebAuthn 注册 options（写 `passkey_register` 挑战行）                                   |
| `POST /api/auth/2fa/passkey/register/verify`  | WebAuthn response + `password?` | `{"success":true}`；消费挑战行、插 `passkey_credentials`，并把受限会话标记清零          |
| `DELETE /api/auth/2fa/passkey/:credentialId`  | `{"password":"…"}`              | `{"success":true}`；删除该凭证行                                                        |
| `POST /api/auth/2fa/passkey/disable`          | `{"password":"…"}`              | `{"success":true}`；删除该用户全部凭证                                                  |

**密码重认证规则（新增/启用因子）**：账号**已有任何因子**（`totp_enabled` 为真，或存在 `passkey_credentials` 行）时，上表四个「新增/启用」端点（`totp/setup`、`totp/enable`、`passkey/register/options`、`passkey/register/verify`）必须带 `password`；缺密码 400 `{"error":"Password required"}`、密码错 403 `{"error":"Password is incorrect"}`、失败 5 次/5 分钟 429 `{"error":"Too many requests","code":"RATE_LIMITED"}`，成功清零。**没有任何因子时免密码**（首次设置、刚用密码登录过的账号直接走会话）。前端可用 `GET /api/me` 的 `twofa.totpEnabled` / `twofa.passkeyCount` 判断是否需要弹密码框。关闭 TOTP、删除/关闭 passkey 始终要求 `password`。

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

201，直接批准并激活；`username` 默认取邮箱前缀、`public_id` 由服务端生成。邮箱已存在 → 409 `code:"EMAIL_TAKEN"`。

#### PUT /api/admin/users/:id

```json
{ "role": "admin", "isActive": true, "email": "…", "password": "…" }
```

字段均可选。不能改自己的角色、不能停用自己。改角色/停用/改密码后吊销该用户全部会话。邮箱撞已有账号 → 409 `code:"EMAIL_TAKEN"`（并发下也不回 500）。`username` / `public_id` / 头像不在此接口里改。

#### DELETE /api/admin/users/:id

不能删自己；删除用户及其 2FA/passkey/会话行。

#### POST /api/admin/users/:id/approve

把用户置为 `approved` + `isActive: true`。

#### POST /api/admin/users/:id/reject

把用户置为 `rejected` + `isActive: false`，吊销其全部会话。

#### GET /api/admin/spaces

站点管理员的空间总览：

```json
[
  {
    "id": "space-default",
    "name": "默认空间",
    "description": "",
    "isDefault": true,
    "createdBy": "…",
    "createdAt": "…",
    "updatedAt": "…",
    "memberCount": 3,
    "pageCount": 12,
    "trashedPageCount": 1
  }
]
```

`pageCount` 只数未删页面、`trashedPageCount` 数回收站页面（两者只要有一项 >0，该空间不可删除）。

#### GET /api/admin/settings

```json
{
  "siteName": "Ciki",
  "setupPageEnabled": false,
  "registrationEnabled": true,
  "registrationApprovalRequired": true,
  "require2fa": false
}
```

#### PUT /api/admin/settings

同一对象的任意子集：布尔项照旧，`siteName` 为字符串（trim 后 1–32 字符、不含控制字符，否则 400 `siteName must be 1-32 characters`）。200 `{"success":true}`。

### 空间与成员

权限：站点管理员可见/可管理全部空间；普通用户只看得见自己是成员的空间。列表/详情/树/直链/回收站/搜索对非成员一律 404。空间信息与成员管理仅空间 `admin` 或站点管理员可调用（`editor` / `viewer` → 403）。任何登录用户都能建空间，创建者自动成为该空间 `admin`。

```text
Space        = { id, name, description, myRole: "admin"|"editor"|"viewer",
                 isDefault, createdAt, updatedAt }
SpaceMember  = { userId, username, publicId, email, role, createdAt }
SpaceCandidate = { userId, username, publicId, email }
```

站点管理员对每个空间的有效 `myRole` 都是 `admin`（不要求是成员）。

#### GET /api/spaces

当前用户可见的空间，默认空间在前：

```json
[
  {
    "id": "space-default",
    "name": "默认空间",
    "description": "",
    "myRole": "editor",
    "isDefault": true,
    "createdAt": "…",
    "updatedAt": "…"
  }
]
```

#### POST /api/spaces

```json
{ "name": "研发空间", "description": "可选，≤500 字符" }
```

201 返回 `Space`（`myRole: "admin"`）。名称 trim 后 1–64 码点、不含控制字符（400 `code:"INVALID_SPACE_NAME"`），描述 ≤500 码点、只允许换行（400 `code:"INVALID_SPACE_DESCRIPTION"`）。空间名不要求唯一。

#### GET /api/spaces/:id

返回 `Space`；空间不存在或非成员 404 `code:"SPACE_NOT_FOUND"`。

#### PUT /api/spaces/:id

```json
{ "name": "新名称", "description": "新描述" }
```

字段均可选但至少给一个（否则 400 `Nothing to update`）。仅空间 `admin` / 站点管理员；返回更新后的 `Space`。

#### DELETE /api/spaces/:id

仅空间 `admin` / 站点管理员。默认空间 409 `code:"SPACE_DEFAULT_PROTECTED"`；空间内还有任何页面（含回收站）409 `code:"SPACE_NOT_EMPTY"`；成功后删除空间与全部成员行，返回 `{"success":true}`。

#### GET /api/spaces/:id/members

仅空间 `admin` / 站点管理员，返回 `SpaceMember[]`（按 admin → editor → viewer、再按显示名排序）。成员非管理员 403，非成员 404。

#### POST /api/spaces/:id/members

```json
{ "userId": "…", "role": "viewer" }
```

201 返回 `SpaceMember`。只能添加已激活且已批准的现有注册用户。错误：400 `code:"INVALID_ROLE"`；404 `code:"USER_NOT_FOUND"`；409 `code:"USER_NOT_ELIGIBLE"` / `code:"ALREADY_MEMBER"`。

#### PUT /api/spaces/:id/members/:userId

```json
{ "role": "editor" }
```

200 返回更新后的 `SpaceMember`。成员不存在 404 `code:"MEMBER_NOT_FOUND"`；把最后一名 `admin` 降级 409 `code:"LAST_SPACE_ADMIN"`。

#### DELETE /api/spaces/:id/members/:userId

`{"success":true}`。移除最后一名 `admin` 409 `code:"LAST_SPACE_ADMIN"`；成员不存在 404 `code:"MEMBER_NOT_FOUND"`。

#### GET /api/spaces/:id/member-candidates?q=

仅空间 `admin` / 站点管理员。候选用户（已激活、已批准、尚未加入该空间），按显示名/邮箱/publicId 模糊匹配，最多 20 条：

```json
[{ "userId": "…", "username": "张三", "publicId": "7FJ2K9QM", "email": "…" }]
```

### 页面

页面读写权限以页面所属空间为准：`editor` 及以上可写，`viewer` 只读；非成员对页面/版本一律 404。站点管理员不受成员表限制。页面父子关系只在同一空间内。

#### GET /api/pages

页面树（不含正文，不含回收站）。`spaceId` 可选，空串/缺省表示默认空间；不是成员或空间不存在 404：

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

#### GET /api/pages/trash?spaceId=

只列该空间（`spaceId` 缺省 = 默认空间）的回收站根（父页仍可见或已在更早批次删除的不重复列出）；非成员 404：

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
  "spaceId": "…",
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

已软删、非成员或所属空间不可见均返回 404。

#### POST /api/pages

```json
{
  "title": "新页面",
  "spaceId": "…",
  "parentId": null,
  "contentJson": "…",
  "contentHtml": "<p>…</p>",
  "contentText": "…"
}
```

201 返回完整详情（含 `spaceId`）；新页追加到同级末尾；首次创建同时生成一条 revision。`contentHtml` 由服务端二次消毒后入库。

`spaceId` 可选：不带 `parentId` 时缺省落默认空间；带 `parentId` 时空间以父页为准，显式 `spaceId` 与父页空间不一致 409 `code:"SPACE_MISMATCH"`。目标空间不可见 404、`viewer` 403。`parentId` 缺省、`null` 或空串都表示根页（不会把空串写进 `parent_id`）。

#### PUT /api/pages/:id

```json
{ "title": "…", "contentJson": "…", "contentHtml": "…", "contentText": "…" }
```

200 完整详情。空间 `editor` 及以上可编辑；`viewer` 403、非成员 404。每次保存生成一条 revision 并同步 FTS。

#### POST /api/pages/:id/move

```json
{
  "spaceId": "目标空间（缺省 = 当前空间）",
  "parentId": "目标父页或 null",
  "sortOrder": 0
}
```

`sortOrder` 可省略（追加到末尾）。只改层级/排序，不生成 revision。跨空间移动时改 `space_id`（整棵后代子树一起改，保持父子同空间）：未给 `parentId` 就重挂到目标空间根；给了父页则父页必须属于目标空间（否则 409 `code:"SPACE_MISMATCH"`）。源空间与目标空间都要 `editor` 及以上（目标不可见 404、`viewer` 403）。移入自身子树 409 `code:"PAGE_MOVE_CYCLE"`；父页已删 409 `code:"PARENT_DELETED"`。

#### DELETE /api/pages/:id

软删整棵子树（同一个 `deletedAt`）：`{"success":true}`。需所属空间 `editor` 及以上；`viewer` 403、非成员 404。

#### POST /api/pages/:id/restore

恢复同一批被删的子树：`{"success":true}`。需所属空间 `editor` 及以上。父页仍在回收站时 409 `code:"PARENT_DELETED"`。

#### DELETE /api/pages/:id/permanent

仅对已软删页面生效；删页面、其全部 revision 与 FTS 行：`{"success":true}`；未软删 409 `code:"PAGE_NOT_DELETED"`。需所属空间 `editor` 及以上。

#### GET /api/pages/:id/revisions

```json
[{ "id": "…", "title": "…", "editorId": "用户 id", "createdAt": "…" }]
```

新 → 旧。`viewer` 可读；非成员 404。

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

以该快照写回页面并生成新 revision，返回 200 完整页面详情。需所属空间 `editor` 及以上；`viewer` 403、非成员 404。

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
      "updatedAt": "…",
      "spaceId": "…",
      "spaceName": "默认空间"
    }
  ]
}
```

搜索范围是当前用户可见的全部空间（站点管理员为全部空间）：非成员空间的标题与片段在 SQL 层就被过滤，不会出现在响应里。`snippet` 是纯文本（不含 HTML），前端自行高亮查询词。空词或只有标点返回 `{"query":"…","results":[]}`。软删页面不出现；`limit` 上限 50。

### 文件

上传的 key 形如 `<类别>/<UUID>.<ext>`，类别按来源分三类：`avatars/`（用户头像，只经 `POST /api/me/avatar` 产生）、`pages/`（编辑器上传、粘贴带入、编辑页手动上传替换）、`imports/`（剪贴板插件经 `POST /api/import/files` 上传）。**存量平铺 key（`<uuid>.<ext>`）及其一切引用不迁移、不改写**，读接口两种形状都认。

#### POST /api/files

`multipart/form-data`，字段名 `file`。仅 png/jpg/jpeg/gif/webp（按魔数校验，拒 svg 与伪装文件），单张上限 10 MB。落 `pages/<uuid>.<ext>`。

201：

```json
{
  "key": "pages/d025c64d-ffd7-4a13-b6d8-527f88643536.png",
  "url": "/api/files/pages/d025c64d-ffd7-4a13-b6d8-527f88643536.png",
  "contentType": "image/png",
  "size": 12345
}
```

400 非图片/类型不符；413 `code:"FILE_TOO_LARGE"`。

#### GET /api/files/:key

需会话；返回图片字节，`Content-Type` 为上传时类型，带 `ETag` 与 `Cache-Control: private, max-age=3600`。

`key` 可含一个类别前缀（`avatars/` / `pages/` / `imports/`），也可以是存量的平铺 key；未知前缀、多级前缀、大写 hex、`svg` 或其它形状一律 404。不存在 404；未登录 401 + no-store。

### 导入（个人令牌）

Confluence 插件用的入口：插件在设置页拿到个人导入令牌后，用 `Authorization: Bearer <token>` 调用，不共享登录 Cookie。

#### GET /api/me/import-token（需会话）

```json
{
  "active": true,
  "createdAt": "2026-11-07T12:00:00.000Z",
  "lastUsedAt": null,
  "revokedAt": null
}
```

从未生成过时三个时间字段均为 `null`、`active` 为 `false`。永不返回哈希或明文。

#### POST /api/me/import-token（需会话）

生成或重置当前用户的令牌（覆盖既有令牌，旧令牌立即失效），200：

```json
{ "token": "…", "createdAt": "2026-11-07T12:00:00.000Z" }
```

**明文只在此响应出现一次**。限流 10 次 / 5 分钟（按用户），超出 429 `code:"RATE_LIMITED"`。

#### DELETE /api/me/import-token（需会话）

吊销当前用户的令牌：200 `{"success":true}`。从未生成过 404；已吊销再调用仍 200（幂等）。

#### 导入接口通用约定

- 鉴权：只认 `Authorization: Bearer <token>`。缺令牌、令牌无效、已吊销、用户被停用或未批准 → 401 `{"error":"Unauthorized"}`，响应 `Cache-Control: no-store`。会话 Cookie 与查询参数都不认（职责分离，避免把 Cookie 写操作的 CSRF 面带进插件）。
- **空间权限**：`space_id` 缺省落默认空间；令牌所属用户必须对目标空间有 `editor` 及以上角色。无权空间明确回 403 `{"error":"Space forbidden","code":"SPACE_FORBIDDEN"}`（插件需要提示用户，这是导入入口与页面直链 404 口径的唯一差别）；空间不存在/父页跨空间见各端点说明。
- 限流沿用 `auth_counters`：失败按 IP（`import_auth_fail` 20 次 / 5 分钟，先拒后验），调用按用户（`import` 3000 次 / 5 分钟）。超出 429 `{"error":"Too many requests","code":"RATE_LIMITED","retryAfter":秒}`，`retryAfter` 是**当前计数窗口的剩余秒数**（不做整窗预留）。成功鉴权一次即清零该 IP 的失败计数。
- 每次成功调用都刷新令牌的 `lastUsedAt`。
- **不做服务端外抓**：接口只收插件上传的字节，不接受 URL 让服务端去下载，SSRF 面为零。

#### GET /api/import/spaces

令牌所属用户具备 `editor` 及以上角色的空间（站点管理员为全部空间），默认空间在前：

```json
[{ "id": "…", "name": "默认空间" }]
```

#### GET /api/import/parents?space_id=

该空间（`space_id` 缺省 = 默认空间）未删页面的扁平摘要（不含正文），供插件选父页：

```json
[{ "id": "…", "title": "首页", "parentId": null }]
```

#### POST /api/import/check

```json
{ "title": "页面标题", "parentId": null, "space_id": "可选，缺省 = 默认空间" }
```

同空间同父级下是否已有同名未删页面：

```json
{ "exists": true, "pageId": "…" }
```

不存在时 `{"exists":false}`。标题按纯文本规范化后比较，且必须 1–255 字符（否则 400，与保存口径一致）；同名多页时取排序最前的一条。父页不存在或已删也返回 `exists:false`（不报错）。

`parentId` 的取值口径见下节：缺省、`null` 与空串都表示根页。

#### POST /api/import/files

`multipart/form-data`，字段名 `file`，单文件。校验、R2 落盘与响应形状与 `POST /api/files` 完全一致（仅 png/jpg/jpeg/gif/webp、按魔数校验、拒 svg 与伪装文件、单张 ≤10MB），落 `imports/<uuid>.<ext>`，201：

```json
{
  "key": "imports/d025c64d-ffd7-4a13-b6d8-527f88643536.png",
  "url": "/api/files/imports/d025c64d-ffd7-4a13-b6d8-527f88643536.png",
  "contentType": "image/png",
  "size": 12345
}
```

插件用 `url` 填进正文图片的 `src`。400 非图片/类型不符；413 `code:"FILE_TOO_LARGE"`。

#### POST /api/import/pages

```json
{
  "title": "页面标题",
  "space_id": "可选，缺省 = 默认空间",
  "parentId": null,
  "contentJson": "{\"type\":\"doc\",…}",
  "conflict": "update"
}
```

- `space_id`：目标空间。缺省/空串落默认空间；用户对该空间无 `editor` 及以上角色 → 403 `code:"SPACE_FORBIDDEN"`。
- `parentId`：目标父页 id，必须属于目标空间（否则 409 `code:"SPACE_MISMATCH"`）。缺省、`null` 与空串（含纯空白）都表示根页——根页在库里是 `parent_id IS NULL`，服务端不会写入空串，避免造出游离页；其它类型 400。
- `contentJson`：TipTap JSON，**字符串或对象均可**（对象由服务端序列化后入库）；只存 JSON，`contentHtml` / `contentText` 一律服务端生成。
- `conflict` 必填：`"update"` = 同空间同父级同名未删页则覆盖内容并追加一条 revision（与编辑器保存同一条写路径：页面 + revision + FTS 同一 `db.batch()` 事务），不存在则新建；`"create_copy"` = 总是新建，不改写标题。
- 新建 201、更新 200，响应一致：

```json
{ "pageId": "…", "url": "/p/<pageId>" }
```

- 渲染与消毒：`contentHtml = sanitizePageHtml(renderTiptapHtml(contentJson))`——用 `@tiptap/html` 的 `generateHTML` 原生渲染（zeed-dom，无 DOM 依赖）再过 §4 同一支白名单消毒；`contentText` 由消毒后的 HTML 生成。插件侧的 HTML/纯文本不被信任，**消毒结果为准**。服务端渲染把表格列宽写成 `col[width]`，读态列宽比例保留；任务项勾选态为 `data-checked="true"|"false"`；颜色写成 data 载具（见下一条）。
- 颜色（插件侧需要产出的 JSON 形态）：文字颜色 `marks: [{ "type": "textStyle", "attrs": { "color": "#rrggbb" } }]`，高亮 `marks: [{ "type": "highlight", "attrs": { "color": "#rrggbb" } }]`，单元格底色 `tableCell` / `tableHeader` 的 `attrs.backgroundColor: "#rrggbb"`（与 `colspan` / `rowspan` / `colwidth` 并列，表头同样适用）。值只认 `#rrggbb`；其它写法（命名色、`rgb()`、`var()`、带透明度）不会报错，但颜色会被丢弃。
- 错误：400 参数非法（标题、`parentId` / `space_id` 类型、`conflict` 取值）；400 `code:"INVALID_CONTENT_JSON"`（JSON 解析失败、未知节点/mark、未声明属性、结构不合 schema）；403 `code:"SPACE_FORBIDDEN"`；404 `code:"SPACE_NOT_FOUND"`；409 `code:"DEFAULT_SPACE_MISSING"` / `code:"PARENT_DELETED"`（父页不存在或已软删）/ `code:"SPACE_MISMATCH"`；413 `code:"PAYLOAD_TOO_LARGE"`（`contentJson` ≤800,000 B、消毒后 HTML ≤800,000 B、纯文本 ≤300,000 B、三件套合计 ≤1,900,000 B）；401；429。

### 服务端消毒规则（content_html）

保存/回滚时执行：保留结构性标签与下列属性，其余一律剥除。

- 表格：`colspan` / `rowspan`（td/th）、`col` 的 `width` 或受限 `style`（仅 `width`/`min-width` 的 px/% 数值）、`table` 的受限 `style`（仅 `min-width: Npx`）、`colgroup`。
- 颜色：`span[data-text-color]`（文字颜色）、`mark[data-color]`（高亮）、`td[data-cell-bg]` / `th[data-cell-bg]`（单元格底色），值仅 `#rrggbb`（大小写都收，入库统一小写）。颜色**不走内联 `style`**：编辑器/粘贴/插件导入三条入口都落成同一套 data 载具，读态由编辑器扩展还原成内联样式；所以 `content_html` 里不会出现颜色相关的 CSS，非法色值只丢颜色、不动文字。
- 代码：`code[class="language-*"]`。
- 任务列表：`ul[data-type]`、`li[data-type][data-checked]`、`label`、只读 `input[type=checkbox][checked]`。
- 链接：`a[href]` 仅 http/https/mailto/相对路径。
- 图片：`img[src]` 仅本站 `/api/files/<uuid>.<ext>`（存量平铺）或 `/api/files/(pages|imports)/<uuid>.<ext>`（新前缀；`avatars/` 只服务资料页，不进正文），或 `data:image/(png|jpeg|gif|webp);base64,…`；其它 `src` 移入 `data-original-src` 并加 `data-confluence-img="true"`（「未转存」标记，读态由前端渲染占位并提供上传替换入口）。
- 一律剥除 `script`/`style`/`iframe`/`object`/`embed`/`form` 及所有 `on*` 事件属性、未列出的 class/attr。

## 四、前端对接要点

- **升级顺序**：代码部署后、管理员在「系统管理 → 数据库维护」点一次「检查并升级数据库」（`POST /api/admin/setup`）之前，`schema_v3` 的三列、`schema_v4` 的空间表/`pages.space_id` 与 `schema_v5` 的两张表还不存在——此时注册/建号/页面接口会失败，`/api/me` 的 `username` 为空串、`avatarUrl` 为 `null`。先升级再使用身份、资料与空间相关功能。
- 所有请求带 `credentials: "include"`；收到 401 时先 `POST /api/auth/refresh` 重试一次，仍 401 再跳登录。
- 401 有两个含义，客户端必须分开：会话中间件的 `Unauthorized` 才是会话过期（上面的刷新流程）；登录与两步验证端点的 401 表达「这次验证没通过」——`Invalid credentials`（账号密码错）、`Invalid verification code`（TOTP 输错）、`Invalid or expired 2FA session`（挑战过期/作废）、`Verification failed`（Passkey 验证未过）。后者不得提示「登录状态已失效」，否则用户会被引去重走整个登录。
- 登录两步：`requires2fa` 时用 `tempToken` 调 TOTP 或 passkey 验证端点；两步表单必须换 DOM 节点（前端单要求）。
- 受限会话（`needs2faSetup`）：只能进 2FA 设置，配置成功后受限标记自动清零，无需重新登录。
- 页面读态渲染 `contentHtml`；编辑态使用 `contentJson`。外链图片以 `data-original-src` + `data-confluence-img` 呈现「未转存」。文字颜色/高亮/单元格底色在 `contentHtml` 里是 data 载具（见「服务端消毒规则」），由读态扩展还原成内联样式，前端不要另外拼颜色样式。
- 上传：正文图（编辑器、粘贴、补抓）走 `POST /api/files`（落 `pages/`）；插件导入走 `POST /api/import/files`（落 `imports/`）；Profile 页头像走 `POST /api/me/avatar`，响应即最新 `Me`，不再「先上传拿 key、再 PUT /api/me/profile」。图片地址白名单（前后端同义）需同时接受平铺与 `pages|imports/` 前缀，否则新图会被判成「未转存」。
- 「数据库维护」页的最近一轮清理摘要取 `GET /api/admin/r2-cleanup` 的 `lastRun`，只渲染一行（运行时间 + 五个计数），不加说明文字；触发清理没有按钮。
- 主题等纯前端偏好不进本契约（客户端持久化）。
- 本契约不含：公开分享、多人实时协同、评论、宏、Jira、通用附件、Markdown 存储、邮件相关端点。
