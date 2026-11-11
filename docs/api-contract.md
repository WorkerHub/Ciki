# ciki 后端 API 契约与数据模型（冻结）

本文件由后端实现单在计划确认后冻结，是前端实现单的接口依据。实现期如需变更，先上报 Chief 裁决，**不得单方面改动**；改动必须同步更新本文件。

- 服务端入口：`worker/src/index.ts`（Hono），部署单元同时托管前端静态资源。
- 表名一律经 `worker/src/lib/tables.ts` 拼当前部署的 `TABLE_PREFIX`（默认 `ciki_`，可显式无前缀），本文只用逻辑表名。
- 响应字段一律 camelCase；数据库列名 snake_case，二者在路由层转换。**唯一例外**：`/api/read/*` 三个只读接口按用户冻结的接入契约逐字使用 snake_case（`parent_id` / `updated_at` / `created_at` / `content_json`），见「只读接口（只读令牌）」。

## 一、通用约定

- **鉴权**：全站登录后可见。除下列公开端点与 `/api/import/*` 外，所有 `/api/*` 都必须带会话 Cookie；未登录一律 `401 {"error":"Unauthorized"}`，且响应头 `Cache-Control: no-store`。`/api/import/*` 是插件专用入口，只认 `Authorization: Bearer <个人导入令牌>`，**不接受会话 Cookie**（见「导入（个人令牌）」）；`/api/read/*` 是外部连接器入口，只认 `Authorization: Bearer <只读令牌>`，同样不接受会话 Cookie，且与导入令牌互不通用（见「只读接口（只读令牌）」）。
  - 公开：`GET /api/health`、`GET /api/setup/state`、`POST /api/setup`、`GET /api/auth/config`、`POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`、`POST /api/auth/refresh`、`POST /api/auth/password/forgot`、`POST /api/auth/password/verify`、`POST /api/auth/password/reset`、`POST /api/auth/2fa/verify`、`POST /api/auth/2fa/passkey/authenticate/options`、`POST /api/auth/2fa/passkey/authenticate/verify`、`POST /api/auth/2fa/email-otp/send-login`。
  - 另有不在 `/api` 下的公开入口 `POST /_waker/execute`（waker 回调，靠 HMAC 签名自证，不认会话 Cookie，见「waker 回调」）。
- **会话 Cookie**：名字 `ciki_session`，值为 32 字节随机不透明令牌（base64url）。属性：`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`（7 天，`refresh` 会滑动续期）。服务端只存令牌的 SHA-256，不存原值；登出、改密、管理员停用/拒绝都会删会话行，删行即吊销。
- **空间可见性**：站点管理员可见全部空间；普通用户仅可见自己是成员的空间（`admin` / `editor` / `viewer`）。可见性过滤覆盖空间列表、页面树、页面直链、回收站与搜索；非成员访问空间/页面一律 404，不泄露存在性。页面写权限以空间角色为准：`editor` 及以上可写，`viewer` 只读。
- **错误体**：`{"error": string, "code"?: string, "retryAfter"?: number}`。常用状态码：400 校验失败、401 未登录/凭证错、403 权限或审批、404 不存在、409 冲突、413 体积超限、422 无法处理的存量内容（如版本 JSON 渲染不了）、429 限流/锁定、500 服务端错误（不回显堆栈）。
- **时间**：所有时间字段均为 ISO 8601 字符串（`2026-11-07T12:00:00.000Z`），会话过期等内部字段用 Unix 秒但不出现在 DTO 中。
- **分页**：页面树与用户列表不分页；搜索用 `limit`（默认 20，上限 50）。
- **内容上限**：标题 1–255 字符；`contentJson` ≤ 800,000 字节；`contentHtml` 以**服务端消毒后**的字节数计 ≤ 800,000 字节；`contentText` 规范化后 ≤ 300,000 字节；四件套（JSON + HTML + 纯文本 + 派生 MD）合计 ≤ 1,900,000 字节（D1 单行上限 2 MB）。超限 `413 {"error":"Payload too large","code":"PAYLOAD_TOO_LARGE"}`。
- **纯文本字段**：`title` 与 `contentText` 保存时剥除 HTML 标签并折叠空白，入库与搜索片段都不含 HTML 语法。
- **脱敏**：任何 DTO 都不返回 `password_hash`、TOTP 密文、passkey `public_key`、会话令牌或挑战原值。

## 二、数据模型

迁移清单见下，账本表为 `_{prefix}schema_migrations`（记录 `name`、`applied_at`，已执行的迁移只做幂等检查、显示为 `skipped`）：

- `schema_v1`：全新库的全部表——鉴权（`users` 含 `username` / `public_id` / `avatar_key` 三列、`user_2fa`、`passkey_credentials`、`sessions`、`auth_challenges`、`auth_counters`）、`system_settings`、页面（`pages` 含 `space_id`、`page_revisions`、`pages_fts`）、导入令牌（`import_tokens`）、空间（`spaces` / `space_members`）、清理日志与回调账本（`r2_cleanup_runs` / `waker_executions`），以及全部索引（含 `users_public_id`、`spaces_is_default` 两个部分唯一索引）。同一迁移末尾播种默认空间（id `space-default`、名称「默认空间」、`is_default=1`、`created_by` 取最早一名站点管理员或空串），并把 `space_id` 仍为空/缺失的页面回填到默认空间、把已有用户加入默认空间（站点管理员 `admin`、其余 `editor`）。播种都是 `INSERT OR IGNORE` / 只写空值的语句，重复执行无副作用；没有 `prepare` 步骤。

- `schema_v2`：`page_revisions` 增加 `content_gzip BLOB`，并把存量版本行逐行压成新格式（详见下文「page_revisions」）。写成 prepare-only 迁移（`sql` 为空，全部动作在幂等 `prepare` 里）：①`PRAGMA table_info` 探不到该列才 `ALTER TABLE … ADD COLUMN`；②按 `id` keyset 分批（25 行/批）转换存量——`gzip(content_json)` → **解压回读逐字节比对** → 一致才 `UPDATE … SET content_gzip=?, content_json='', content_html='', content_text='' WHERE id=? AND content_gzip IS NULL`。因此可重复执行（已转换行被 `content_gzip IS NULL` 排除、写回也再拦一道）、可中断续跑（中途失败该迁移不记账，下次 setup 从剩下的行继续），且只在回读校验通过后才清空被完整替代的冗余列。

- `schema_v3`（邮箱验证码，2026-11-09）：新建 `email_codes` 专表与 `email_codes_expires_at` 索引；`user_2fa` 的 `email_otp_enabled` 列由 `schema_v3.prepare` 用 `PRAGMA table_info` 判断后 `ALTER TABLE … ADD COLUMN` 补上（SQLite 没有 `ADD COLUMN IF NOT EXISTS`），重复执行不会重复加列。回滚：删 `email_codes` 表与索引，并从账本删掉 `schema_v3` 行；`email_otp_enabled` 列可留（旧代码忽略）或用 `ALTER TABLE … DROP COLUMN` 一并回退。

- `schema_v4`（MD 派生存储 + 只读接口令牌，一期）：①新建 `read_tokens` 表与 `read_tokens_token_hash` 唯一索引（纯 DDL，在 `sql` 里）；②`pages` 增加 `content_md TEXT` 列，并把存量页逐页派生回填（在 `prepare` 里：`PRAGMA table_info` 探不到该列才 `ALTER TABLE … ADD COLUMN`，再按 25 行/批 `SELECT … WHERE content_md IS NULL ORDER BY id LIMIT 25` → `UPDATE … SET content_md=? WHERE id=? AND content_md IS NULL`）。可重复执行（已回填行被 `content_md IS NULL` 排除、写回再拦一道）、可中断续跑（`prepare` 抛错则该迁移不记账，下次 setup 从剩下的行继续），并且一批行仍待办却一行没写进去时抛错中止（不死循环）。回填只写 `content_md`，不碰正文三列与 `updated_at` / `updated_by`；软删页一并回填（回收站页面恢复后立刻可读）。回滚：代码回退即可，`content_md` 列与 `read_tokens` 表可留（旧代码忽略）；确要清干净再 `ALTER TABLE … DROP COLUMN content_md`、`DROP TABLE read_tokens` 并删账本 `schema_v4` 行。

- `schema_v5`（页尾评论）：新建 `comments` 表与 `comments_page_created` / `comments_parent` / `comments_author` 三个索引（纯 DDL、无 `prepare`，全部 `IF NOT EXISTS`，重复执行无副作用）。回滚：`DROP TABLE comments`（索引随之消失）并删账本 `schema_v5` 行。**部署后需管理员在「系统管理 → 数据库维护」点一次升级才生效**，点之前评论接口会因表不存在而失败。

Ciki 没有要保留的存量库，因此不提供 `schema_v1`~`schema_v5` 那样的逐版本升级路径：今后结构变化只在末尾追加 `schema_v2`、`schema_v3`…，不改动已有迁移。只跑过旧版部分迁移、或 `pages` 缺 `space_id` 的库不在支持范围——`CREATE TABLE IF NOT EXISTS` 不会补列，迁移会失败并报 `Migration "schema_v1" failed`，处置方式是重建库。

存量页一律可读：

- 部署后、管理员点「检查并升级数据库」之前，`pages.content_md` 列还不存在，`read_tokens` 表也一样；写路径用 `PRAGMA table_info` 探列，列不在就按旧形态写（只是不存 MD，保存不失败）；
- 读路径（`GET /api/pages/:id` 的 `contentMd`、`GET /api/read/pages/:id` 的 `markdown`）遇到 `content_md` 为空/缺失时**按需从 `content_json` 现生成**，不报错、不回空文档；升级由 `schema_v4` 一次性回填补齐。

回滚方式：删掉该前缀下的全部业务表与索引，并从账本删掉对应行（`DELETE FROM _{prefix}schema_migrations`），即回到未初始化状态（等同整库重建）；生产库执行前必须经用户批准；UI 不提供删表/清库入口。

账本表名带前导下划线、排在业务表之前（如默认前缀下为 `_ciki_schema_migrations`，无前缀时为 `_schema_migrations`）。旧版部署用的账本名是 `{prefix}schema_migrations`（无前导下划线）：setup 在跑迁移之前先探旧账本，旧在/新不在则 `ALTER TABLE … RENAME TO …` 改名承接（已应用记录原样保留，迁移全显示 `skipped`，重复执行不会重复改名）；新旧都不在则按现行 DDL 新建。新旧账本同时存在（或旧账本表结构不符、不是 ciki 的账本）属异常，setup 以 409 `LEDGER_CONFLICT` 中止并回报，不自行合并或删除任何一边。

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

### user_2fa（TOTP + 邮箱验证码开关）

| 列                | 类型                       | 说明                                                                      |
| ----------------- | -------------------------- | ------------------------------------------------------------------------- |
| user_id           | TEXT PK                    |                                                                           |
| totp_secret       | TEXT NULL                  | AES-GCM 密文，格式 `v1.<ivB64url>.<ctB64url>`，AAD = `ciki:totp:<userId>` |
| totp_enabled      | INTEGER NOT NULL DEFAULT 0 |                                                                           |
| email_otp_enabled | INTEGER NOT NULL DEFAULT 0 | `schema_v3` 补列；邮箱验证码作为第二因子的开关（端点见「2FA 管理」）      |
| updated_at        | TEXT NOT NULL              |                                                                           |

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

| 列                     | 类型                     | 说明                                                                                              |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| key                    | TEXT PK                  | `SHA-256(令牌)` 或 `SHA-256("<purpose>:<uid>")`，不存原值                                         |
| user_id                | TEXT NOT NULL            |                                                                                                   |
| purpose                | TEXT NOT NULL            | `2fa_login` / `totp_setup` / `passkey_register` / `passkey_auth` / `totp_used` / `password_reset` |
| payload                | TEXT NOT NULL DEFAULT '' | 挑战原文 / 加密后的 TOTP 待确认密钥 / `password_reset` 的 userId                                  |
| expires_at, created_at | INTEGER NOT NULL         | 均为 5 分钟过期（`totp_used` 90 秒、`password_reset` 600 秒）                                     |

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

| action                | account                            | 上限 / 窗口     | 说明                                                                    |
| --------------------- | ---------------------------------- | --------------- | ----------------------------------------------------------------------- |
| login                 | 空                                 | 10 次 / 5 分钟  | 每 IP                                                                   |
| login_fail            | 邮箱                               | 5 次 / 15 分钟  | 第 5 次起锁 15 分钟                                                     |
| register              | 空                                 | 5 次 / 5 分钟   | 每 IP                                                                   |
| 2fa_verify            | 空                                 | 5 次 / 5 分钟   | 每 IP；另按 tempToken 记失败，5 次作废令牌                              |
| password_change       | 用户 id                            | 5 次 / 5 分钟   |                                                                         |
| reauth                | 用户 id                            | 5 次 / 5 分钟   | 2FA 敏感操作（新增/启用/关闭因子、删 passkey）的密码重认证              |
| setup                 | 空                                 | 3 次 / 10 分钟  | 每 IP，初始化前也生效                                                   |
| email_code_cd         | `${purpose}:${account}`            | 1 次 / 60 秒    | 发码冷却；第 2 次在窗口内即拒绝，`retryAfter` 秒级                      |
| email_code_send       | `${purpose}:${account}`            | 5 次 / 1 小时   | 账号+用途的小时配额；找回密码的 account 是小写 trim 邮箱，2FA 是 userId |
| email_code_send_ip    | 空                                 | 20 次 / 1 小时  | 每 IP 发码总量，防遍历账号                                              |
| email_code_verify     | `${purpose}:${account}`            | 5 次 / 10 分钟  | 校验请求计数；成功后清零该账号+用途，第 5 次错误会删除该码              |
| email_code_verify_ip  | 空                                 | 20 次 / 10 分钟 | 每 IP 校验总量，防单 IP 爆破                                            |
| password_reset_submit | 有效 token 的 userId（无效时为空） | 5 次 / 5 分钟   | 设新密码接口（找回密码第三步）                                          |
| smtp_config           | 管理员 userId                      | 10 次 / 5 分钟  | `PUT /api/admin/system/smtp`                                            |
| smtp_test             | 管理员 userId                      | 5 次 / 5 分钟   | `POST /api/admin/system/smtp/test`                                      |

### email_codes（邮箱验证码，schema_v3）

| 列         | 类型                       | 说明                                                          |
| ---------- | -------------------------- | ------------------------------------------------------------- |
| user_id    | TEXT NOT NULL              | 复合主键之一                                                  |
| purpose    | TEXT NOT NULL              | `password_reset` / `2fa_login` / `2fa_enable`（CHECK 约束）   |
| binding    | TEXT NOT NULL DEFAULT ''   | `2fa_login` 为 `SHA-256(tempToken)`；其余用途为空串           |
| code_hash  | TEXT NOT NULL              | `SHA-256("<purpose>:<userId>:<code>")`，64 位 hex；不存明文码 |
| attempts   | INTEGER NOT NULL DEFAULT 0 | 错误次数；第 5 次错误删除该行                                 |
| created_at | INTEGER NOT NULL           | Unix 秒                                                       |
| expires_at | INTEGER NOT NULL           | Unix 秒；TTL 600 秒                                           |

主键 `(user_id, purpose, binding)`：同一账号同一用途（同一 tempToken）只保留最新一枚码，重发 UPSERT 覆盖旧码。验证码为 6 位数字（`crypto.getRandomValues`，100000–999999），单次消费；成功校验用 `DELETE … WHERE … AND code_hash=? AND expires_at>? AND attempts<5` 原子消费，`meta.changes=1` 才算成功；每次发码顺带 `DELETE … WHERE expires_at < now`。

### system_settings

`key` TEXT PK、`value` TEXT、`updated_at` TEXT。键与默认值：

| key                            | 值                                                                                  | 默认                           |
| ------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------ |
| site_name                      | 站点名称                                                                            | `Ciki`                         |
| setup_page_enabled             | `0` / `1`                                                                           | 初始化后写 `0`                 |
| registration_enabled           | `true` / `false`                                                                    | `true`                         |
| registration_approval_required | `true` / `false`                                                                    | `true`                         |
| require_2fa                    | `true` / `false`                                                                    | `false`                        |
| smtp_config                    | SMTP 配置 JSON                                                                      | 未设置                         |
| r2_cleanup_lock                | 清理互斥锁 JSON（`{"token","startedAt","trigger","dryRun"}`），运行期存在、跑完即删 | 无（只有一轮清理在跑时才存在） |

`site_name` 是站点作用域的单值（浏览器页签标题、品牌区文字、登录页标题），仅管理员可改，长度 1–32 字符、不含控制字符；未播种时读端回退 `Ciki`。

`smtp_config` 形状（#48 契约）：

```json
{
  "host": "smtp.example.com",
  "port": 587,
  "encryption": "starttls",
  "username": "mailer@example.com",
  "password": "v1.<iv>.<ct>",
  "from": "noreply@example.com",
  "fromName": "Ciki"
}
```

只有 `password` 是密文（AES-GCM，格式 `v1.<ivB64url>.<ctB64url>`，AAD = `ciki:smtp:password`），其余字段明文；未设置或 JSON 损坏视为未配置。`encryption` ∈ `tls`（465 隐式 TLS）/ `starttls`（STARTTLS，失败即报错不回退明文）/ `none`（明文）。`emailConfigured` 只看非密字段（host/port/encryption/from 合法），不解密、不探测网络、永不抛错；读写与测试端点见「管理」。

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

### read_tokens（只读接口令牌，schema_v4）

与 `import_tokens` **形状相同、表独立**，两套令牌互不通用：

| 列           | 类型          | 说明                                  |
| ------------ | ------------- | ------------------------------------- |
| user_id      | TEXT PK       | 每用户一行；生成/重置即覆盖，不新增行 |
| token_hash   | TEXT NOT NULL | 令牌的 SHA-256 hex，唯一索引          |
| created_at   | TEXT NOT NULL | ISO 时间；重置时刷新                  |
| last_used_at | TEXT NULL     | 每次通过该令牌调用读接口时更新        |
| revoked_at   | TEXT NULL     | 非空即吊销                            |

- 明文只存于生成/重置响应一次，库内只有哈希；不设过期列。
- 失效条件：吊销、重置、用户被停用或未批准（校验每次回表并连 `users`）。
- 令牌只用于 `/api/read/*`；令牌管理本身要会话 Cookie。
- **双向隔离**在服务端落地：读接口的中间件只查本表，导入接口的中间件只查 `import_tokens`；所以导入令牌调读接口、只读令牌调导入接口与会话写接口都是 401，不靠前端约定。

### spaces

| 列                     | 类型                       | 说明                                              |
| ---------------------- | -------------------------- | ------------------------------------------------- |
| id                     | TEXT PK                    | 空间 id；默认空间固定为 `space-default`           |
| name                   | TEXT NOT NULL              | 名称，1–64 码点、不含控制字符                     |
| description            | TEXT NOT NULL DEFAULT ''   | 描述，≤500 码点（允许换行）                       |
| is_default             | INTEGER NOT NULL DEFAULT 0 | 1 = 默认空间；部分唯一索引保证全库只有一条        |
| created_by             | TEXT NOT NULL DEFAULT ''   | 创建者用户 id；默认空间取最早一名站点管理员或空串 |
| created_at, updated_at | TEXT NOT NULL              | ISO 时间                                          |

默认空间不可删除；其它空间只有在没有任何页面行（含回收站）时才可删除。

### space_members

| 列         | 类型          | 说明                                   |
| ---------- | ------------- | -------------------------------------- |
| space_id   | TEXT NOT NULL | 空间 id                                |
| user_id    | TEXT NOT NULL | 用户 id                                |
| role       | TEXT NOT NULL | `admin` / `editor` / `viewer`（CHECK） |
| created_at | TEXT NOT NULL | ISO 时间                               |

主键 `(space_id, user_id)`；索引 `(user_id)`。空间至少保留一名 `admin`（改角色/移除最后一名 admin → 409 `LAST_SPACE_ADMIN`）。

### pages

| 列                     | 类型                       | 说明                                                                                 |
| ---------------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| id                     | TEXT PK                    | UUID                                                                                 |
| space_id               | TEXT NOT NULL DEFAULT ''   | 所属空间；初始化迁移回填默认空间                                                     |
| parent_id              | TEXT NULL                  | 根页为 NULL；父子关系只在同空间内                                                    |
| title                  | TEXT NOT NULL              |                                                                                      |
| sort_order             | INTEGER NOT NULL DEFAULT 0 | 同级 0..n-1                                                                          |
| content_json           | TEXT NOT NULL DEFAULT ''   | TipTap JSON 文本（真源）                                                             |
| content_html           | TEXT NOT NULL DEFAULT ''   | 服务端消毒后的 HTML                                                                  |
| content_text           | TEXT NOT NULL DEFAULT ''   | 供搜索/摘要                                                                          |
| content_md             | TEXT NULL                  | `schema_v4` 补列；从 `content_json` 派生的 Markdown（导出/机读用，**永不反写正文**） |
| created_by, updated_by | TEXT NOT NULL              | 用户 id                                                                              |
| created_at, updated_at | TEXT NOT NULL              | ISO 时间                                                                             |
| deleted_at             | TEXT NULL                  | 软删时间                                                                             |

索引：`(space_id, parent_id, sort_order)`、`(space_id, deleted_at)`、`(parent_id, sort_order)`、`(deleted_at)`、`(updated_at)`。

`content_md` 是 `content_json` 的派生件（派生规则见「Markdown 派生规则」）：写路径与 HTML/纯文本在同一处生成、同一次 `db.batch()` 落库，正常保存/导入覆盖/回滚三条入口共用；它**不参与无改动保存的判等**（判等仍是标题 + JSON + HTML + 纯文本四项），也没有历史版本副本（`page_revisions` 仍只存 JSON）。代价是将来如果调整了派生规则，旧页会继续返回旧 MD——需要重刷时把对应行的 `content_md` 置 NULL 并重跑升级通道（`content_md IS NULL` 的行会被重新回填）。

### page_revisions

`id` TEXT PK、`page_id` TEXT NOT NULL、`title`、`content_json`、`content_html`、`content_text`、`content_gzip` BLOB NULL（`schema_v2` 起）、`editor_id` TEXT NOT NULL、`created_at` TEXT NOT NULL；索引 `(page_id, created_at DESC)`。每次新建/有实际改动的保存/回滚都追加一条；四列（`title` / `content_json` / `content_html` / `content_text`）归一化后与现存行全等的保存是无改动，不追加。

**正文只存一份 gzip 的 `content_json`（`content_gzip`），不存 base64。** 两种行形态共存：

| 形态                | `content_gzip`    | `content_json` / `content_html` / `content_text` | 读法                                 |
| ------------------- | ----------------- | ------------------------------------------------ | ------------------------------------ |
| 新（迁移后）        | gzip 字节（BLOB） | 空串（列仍 NOT NULL）                            | 解压出 JSON → 服务端生成 HTML/纯文本 |
| 旧（升级前/未转换） | NULL              | 三列正文                                         | 原样读三列（与改前逐字一致）         |

- HTML 与纯文本由 `worker/src/lib/tiptap-html.ts` 一链按需生成（`renderTiptapHtml` → `sanitizePageHtml` → `toPlainText`），与导入接口同一条路径；`pages` 表当前内容的存储不变（仍存三列）。
- 版本的 JSON 无法按当前编辑器 schema 渲染、或压缩字节本身损坏（脏数据）时，查看与回滚都回 `422 {"error":"Revision content cannot be rendered: …","code":"REVISION_UNRENDERABLE"}`，不写回页面、也不会漏成 500。
- 「新 → 旧」的唯一排序口径是 `created_at DESC, id DESC`（列表、修剪、最新一条判定、删除护栏共用）。次键用主键 `id` 而不是隐式 `rowid`：`rowid` 在 VACUUM / 导出再导入等重建环境不保证稳定。为了让「写入次序 = 排序结果」不依赖毫秒精度，写路径给版本 `created_at` 加了单调时钟（同一 isolate 内严格递增，必要时比请求时间多 1ms），并另有硬保证：写入路径的修剪语句把**刚插入的那条 id** 排除在外。
- 保留数（每页保留多少条）的读写与两处修剪见「GET /api/admin/settings」「PUT /api/admin/settings」「GET /api/admin/revisions/retention」「POST /api/admin/revisions/prune」，以及下方页面版本接口：写入时按设置在同事务里删除该页超出上限的最旧版本。

### pages_fts（FTS5 虚拟表）

```sql
CREATE VIRTUAL TABLE {prefix}pages_fts USING fts5(page_id UNINDEXED, title, content_text)
```

**同步方式**（不做触发器）：新建/有实际改动的保存/回滚时在同一个 `db.batch()` 事务里写 pages → 插 revision → `DELETE FROM pages_fts WHERE page_id=?` → 插入新索引行；无改动的保存不写 pages、不插 revision，也不重建索引；软删/彻底删同批删除索引行；恢复同批重建。索引与查询都做 CJK 逐字空格化（`团队` → `团 队`）：CJK 词按短语 `"团 队"`、拉丁词按前缀 `"ciki"*`，多词 AND；排序 `bm25(fts, 0, 10, 1)`。

### comments（页尾评论，schema_v5）

| 列         | 类型          | 说明                                                           |
| ---------- | ------------- | -------------------------------------------------------------- |
| id         | TEXT PK       | UUID                                                           |
| page_id    | TEXT NOT NULL | 所属页面；评论挂页面不挂版本                                   |
| parent_id  | TEXT NULL     | NULL = 顶层；回复恒指向其顶层评论 id（只一级，不产生二级嵌套） |
| author_id  | TEXT NOT NULL | 用户 id（用户被彻底删除后评论保留，展示名回落「已注销用户」）  |
| body_md    | TEXT NOT NULL | Markdown 原文（唯一真源；HTML 不落库，读时现算）               |
| created_at | TEXT NOT NULL | ISO 时间                                                       |
| edited_at  | TEXT NULL     | 首次编辑的时刻；未编辑为 NULL                                  |
| deleted_at | TEXT NULL     | 软删时刻；非空即「已删除」                                     |

索引：`(page_id, created_at)`、`(parent_id)`、`(author_id)`。

- 回复的目标若本身是回复，写库前归一到它所属的顶层评论：`parent_id` 永远是顶层 id。
- **硬删随父页**：页面彻底删除（回收站清空）时其评论一并删除；页面软删（回收站）不动评论——评论接口随页面 404，恢复后原样回来。
- 评论不进 FTS、不进只读接口（一期范围外，不留口子）。

### r2_cleanup_runs

| 列                                                                  | 类型          | 说明                                                                                   |
| ------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------- |
| id                                                                  | TEXT PK       | UUID                                                                                   |
| started_at / finished_at                                            | TEXT NOT NULL | ISO 时间                                                                               |
| trigger                                                             | TEXT NOT NULL | `cron` / `waker` / `manual`                                                            |
| status                                                              | TEXT NOT NULL | `ok`（跑完）/ `skipped`（20 天幂等兜底命中，只有自动入口会有）/ `failed`（扫描期异常） |
| dry_run                                                             | INTEGER       | 1 = 只算不删；dry_run 行不计入 20 天兜底、也不进「最近一轮」                           |
| scanned / referenced / deleted / young_skipped / failed / truncated | INTEGER       | 扫描数 / 引用数 / 删除数 / 未满 30 天跳过数 / 失败数 / 是否因上限截断                  |

索引 `(started_at)`。每轮一行，不含任何对象内容；清理自身除本表外只写 `system_settings` 的清理锁行（见「system_settings」与「POST /api/admin/r2-cleanup」），不动任何业务表。

### waker_executions

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
- 409 账本冲突：新旧迁移账本同时存在（或旧账本表结构不符、不是 ciki 的账本）时以 409 中止，两张表一个都不动，等人工确认只保留一套后重试：

```json
{
  "success": false,
  "code": "LEDGER_CONFLICT",
  "error": "…",
  "resolvedPrefix": "ciki_",
  "ledgers": ["_ciki_schema_migrations", "ciki_schema_migrations"]
}
```

- 429：每 IP 每 10 分钟 3 次。
- 初始化完成时显式写 `setup_page_enabled=0`（只门控页面，不门控密钥接口）。

#### POST /api/admin/setup（管理员会话，免密钥）

与 `POST /api/setup` 同形状；非管理员 403。

#### POST /api/admin/r2-cleanup（管理员会话）

手动触发一轮 R2 孤儿清理：跳板是「系统管理 → 数据库维护」页的两步 UI（第一步 dry run 预览、第二步实跑再确认；按钮与文案见前端单）。

请求体可选：`{"dryRun": true}` 只算不删；缺省或 `false` 为真实删除。

- **手动实跑不受 20 天幂等闸约束**（定版第 4 条：该闸只约束 Cron / waker 两个自动入口），30 天龄规则照旧——因此手动接口不会再回 `status:"skipped"`。
- **并发互斥**：同一时刻只许一轮清理在跑（自动或手动、真实或 dry run 都算）。已有在跑的一轮时回 `409 {"error":"Cleanup already running","code":"CLEANUP_IN_PROGRESS","retryAfter":<秒>}`，不扫、不删、不写日志行；`retryAfter` 是当前清理锁的剩余秒数（整数 ≥1），到点后以同样请求重试即可。
- **单轮真删上限沿用 200**：触顶即停止删除、`deleted` 停在 200、`truncated: true`（扫描照常跑完，计数完整）。
- 200 返回本轮摘要；扫描期异常时失败行已落库，接口回 `500 {"error":"Cleanup failed"}`。

`{"dryRun": true}` 的 200：

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
  "truncated": false,
  "prunable": 5,
  "prunableBytes": 7340032
}
```

`{"dryRun": false}` 的 200 与上面逐字段相同，只是**不含** `prunable` / `prunableBytes`。

字段口径：`scanned` = R2 对象总数（分页列全桶）；`referenced` = 引用集去重后的 key 数（`users.avatar_key` ∪ 全部页面与历史版本正文里的 `/api/files/<key>`，回收站页面同样计入；历史版本只有 gzip 的 JSON，扫描前先解压，尚未转换的旧行按原三列扫，口径与结果不因存储形态改变）；`deleted` = 本轮删除数（`dryRun` 时为「按 200 上限的将删数」，触顶同样置 `truncated`）；`youngSkipped` = 未被引用但 uploaded 距今不足 30 天而跳过的对象数；`failed` = 单个对象删除失败数（不中断整轮）；`truncated` = 是否因单轮删除上限（200）而停止删除；`prunable` = 满足「未被引用且 uploaded 距今 >30 天」的对象总数，**不受 200 上限截断**；`prunableBytes` = 上述对象的 R2 对象大小之和（字节）。

`prunable` / `prunableBytes` 只出现在 dry run 响应里，不入日志表——实跑命中 200 上限时 `deleted` 会小于第一步看到的 `prunable`，这是「再点一次接着删」的正常状态（不是失败）：前端第二步据 `truncated: true` 提示「本轮已删 200 个，仍有剩余，可再跑一轮」。

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
  },
  "running": {
    "startedAt": "2026-11-08T17:00:00.000Z",
    "trigger": "manual",
    "dryRun": true,
    "retryAfter": 900
  }
}
```

`lastRun` 是最近一轮**真实**运行（`dry_run=0` 且 `status<>"skipped"`），从未跑过为 `null`。这是「系统管理 → 数据库维护」页那一行摘要的唯一数据源。

`running` 是此刻的运行态，读 `system_settings` 的清理锁行、按 30 分钟 TTL 判它是否仍有效：

| 字段                 | 类型                              | 口径                                                                 |
| -------------------- | --------------------------------- | -------------------------------------------------------------------- |
| `running`            | object \| null                    | `null` = 没人持有有效清理锁（无锁行，或锁已过期）                    |
| `running.startedAt`  | string（ISO 8601）                | 持锁那一轮的起始时刻                                                 |
| `running.trigger`    | `"cron"` / `"waker"` / `"manual"` | 持锁入口                                                             |
| `running.dryRun`     | boolean                           | 持锁那一轮是否只算不删                                               |
| `running.retryAfter` | number（整数 ≥1，秒）             | 锁剩余有效期；与 POST 的 409 `retryAfter` 同一算法，同一时刻取值相同 |

`running` 与 `lastRun` 互不影响：前者只读锁行、后者只读日志表，有人正在跑也不会改变摘要行。前端在页面加载时按 `running` 禁用触发按钮并显示「清理进行中」，`null` 才可点。

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

| 项       | 值                                         |
| -------- | ------------------------------------------ |
| 回调 URL | `https://<站点域名>/_waker/execute`        |
| 任务名   | `monthly-r2-orphan-cleanup`                |
| cron     | `0 1 1 * *`                                |
| 时区     | `Asia/Shanghai`（= 每月 1 日 01:00，低峰） |

### 鉴权

#### GET /api/auth/config（公开）

```json
{
  "siteName": "Ciki",
  "registrationEnabled": true,
  "registrationApprovalRequired": true,
  "emailConfigured": false
}
```

`siteName` 未登录也可读（登录页标题要用），不含敏感信息。`emailConfigured` 是站点级公开事实（只说明 SMTP 非密字段是否配置好），用于登录页/找回密码入口判断是否展示邮件入口，不针对任何账号。

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
  "availableMethods": ["totp", "passkey", "email_otp"]
}
```

```json
{
  "success": true,
  "needs2faSetup": true,
  "user": { "id": "…", "email": "…", "role": "user" }
}
```

- 第一种与第三种同时下发 `ciki_session` Cookie；第三种是受限会话（`require_2fa` 打开且用户未配置任何方法），只能访问 `/api/me`、`/api/auth/logout`、`/api/auth/2fa/totp/*`、`/api/auth/2fa/passkey/*`、`/api/auth/2fa/email-otp/*`。
- `availableMethods` 顺序固定 `totp` → `passkey` → `email_otp`，只列真实可用的方式：`email_otp` 仅在用户 `email_otp_enabled=1` **且**站点 `emailConfigured` 时出现。若用户已启用的方式被过滤后一个不剩（只剩邮箱验证码、但站点发信不可用），登录以 403 `{"error":"Two-factor method unavailable","code":"2FA_METHOD_UNAVAILABLE"}` 失败关闭，**不静默降级为只验密码**、也不下发 Cookie。
- `tempToken` 是 5 分钟有效的一次性登录挑战，交给 2FA 验证步骤。
- 失败：401 `{"error":"Invalid credentials"}`；403 `{"error":"…","code":"ACCOUNT_PENDING_APPROVAL"|"ACCOUNT_REJECTED"}`；429 `{"error":"Too many requests","code":"RATE_LIMITED"}` 或 `{"error":"Account locked","code":"ACCOUNT_LOCKED","retryAfter":秒}`。

#### POST /api/auth/2fa/verify

```json
{ "tempToken": "…", "method": "totp", "code": "123456" }
```

`method` 认 `totp` 与 `email_otp`（`passkey` 走下面两个 passkey 端点，传其它值 400）。

- `totp`：校验 TOTP 动态码，并用 `totp_used` 挑战行防同一枚码重放。
- `email_otp`：先确认该账号 `email_otp_enabled=1`（否则 400 `{"error":"Email code is not enabled for this account","code":"METHOD_NOT_ENABLED"}`）、站点仍 `emailConfigured`（两步之间被关掉发信则 503 `EMAIL_NOT_CONFIGURED`，纵深防御），再按用途 `2fa_login`、`binding = SHA-256(tempToken)` 原子消费验证码；错码/已消费的码一律 401 `{"error":"Invalid verification code"}`，用于登录第二步的验证码第 5 次错误删除。

成功：200 `{"success":true,"user":{…}}` + `ciki_session` Cookie。失败：401（挑战无效/过期/验证码错），同一 `tempToken` 失败 5 次后作废；每 IP `2fa_verify` 5 次/5 分钟，超过 429 带 `retryAfter`。

#### POST /api/auth/2fa/email-otp/send-login（公开）

登录第二步选了邮箱验证码时发码：

```json
{ "tempToken": "…" }
```

- 只认有效的 `2fa_login` 挑战；缺失 `tempToken` 400，无效/过期 401 `{"error":"Invalid or expired 2FA session"}`。
- 账号未启用邮箱验证码 400 `{"error":"Email code is not enabled for this account","code":"METHOD_NOT_ENABLED"}`；站点未配置发信 503 `EMAIL_NOT_CONFIGURED`；账号被停用/未批准 403 `{"error":"Account is disabled"}`。
- 通过后生成 6 位码（10 分钟有效、单次消费，`binding = SHA-256(tempToken)`），发到**账号邮箱**（v1 不支持另设收码邮箱）；重发覆盖旧码。
- 限频复用 `email_code_cd` / `email_code_send` / `email_code_send_ip`（用途 `2fa_login`、账号为 userId）：60 秒冷却、每小时 5 封、每 IP 每小时 20 封，超限 429 带 `retryAfter`。
- 成功 200 `{"success":true,"cooldownSeconds":60,"expiresInSeconds":600}`；发送失败 502 `{"error":"SMTP send failed: …","code":"SMTP_SEND_FAILED"}`（原因已脱敏、不含密码）。

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

#### 找回密码（三步，均公开）

`发送验证码 → 校验验证码换一次性 resetToken → 用 resetToken 设新密码`。验证码与 resetToken 都一次性，任何一步超时都从发码重来。三条端点不需要会话：只认邮箱 + 验证码 / 令牌。

**(1) POST /api/auth/password/forgot**（发码）

```json
{ "email": "a@b.c" }
```

- 顺序固定：邮箱格式（缺失/非法 400 `{"error":"Invalid email format","code":"INVALID_EMAIL"}`）→ 站点发信（未配置 503 `{"error":"Email delivery is not configured","code":"EMAIL_NOT_CONFIGURED"}`，不写任何计数）→ 限频 → 查账号。
- 限频复用 `email_code_cd` / `email_code_send` / `email_code_send_ip`（用途 `password_reset`、账号是小写 trim 后的邮箱，未知邮箱也计数）：60 秒内重复请求返回 200 但不重发；每小时第 6 封或每 IP 每小时第 21 封 429 `{"error":"Too many requests","code":"RATE_LIMITED","retryAfter":秒}`。
- 账号存在、`is_active=1` 且 `approval_status='approved'` 才生成并投递 `password_reset` 验证码（6 位、10 分钟、单次消费）；发码与 SMTP 投递都在 `waitUntil` 里后台执行，响应不等发信。未知 / 已停用 / 未批准 / 发送失败一律静默成功，不发信、不写码。
- 成功（含冷却期内的静默不发）：200 `{"success":true,"cooldownSeconds":60}`。对外只有三种状态：400 格式错、503 站点未配置、200 成功（配额用尽时 429），防枚举。

**(2) POST /api/auth/password/verify**（验码换 resetToken）

```json
{ "email": "a@b.c", "code": "123456" }
```

- 限频 `email_code_verify` / `email_code_verify_ip`（用途 `password_reset`、账号为邮箱；5 次 / 10 分钟、每 IP 20 次 / 10 分钟），超限 429。
- 账号不存在、已停用、未批准、验证码不存在、过期、哈希不匹配——全部 400 `{"error":"Invalid or expired code","code":"INVALID_CODE"}`；未知账号也按固定假 userId 做一次同成本的 SHA-256。错码让 `email_codes.attempts+1`，第 5 次错误删除该码；成功清零该邮箱的验码失败计数并原子消费该码。
- 成功时在 `auth_challenges` 写一次性 resetToken：明文 32 字节 base64url（43 字符）只在响应里出现一次，库内只存 `SHA-256(令牌)`，`purpose='password_reset'`、`payload=userId`、TTL 600 秒。
- 成功 200 `{"success":true,"resetToken":"…","expiresIn":600}`。

**(3) POST /api/auth/password/reset**（只认 resetToken，不传邮箱）

```json
{ "resetToken": "…", "newPassword": "至少 8 位" }
```

- 令牌不存在/已过期/已用 400 `{"error":"Invalid or expired reset token","code":"INVALID_RESET_TOKEN"}`。
- 提交限流 `password_reset_submit`（能解析出用户时按 userId+IP，否则空账号+IP；5 次 / 5 分钟），超限 429。
- 强度校验沿用注册/改密口径（字符串且 ≥8 位），不满足 400 `{"error":"Password must be at least 8 characters","code":"WEAK_PASSWORD"}` 且**不消费令牌**。
- 用户已不存在 / 已停用 / 未批准按令牌无效处理（400 `INVALID_RESET_TOKEN`）。
- 成功在一个 `db.batch()` 事务里原子完成：消费令牌（`changes=1` 才算成功；写密码的 UPDATE 带令牌存在守卫，并发重放不会把失败那次的密码写进去）→ 更新 `password_hash` → 删除该用户**全部会话** → 删除其全部 `auth_challenges` 与 `email_codes`。
- 成功 200 `{"success":true}`，**不自动登录、不下发 Cookie**；旧密码与该账号全部既有会话立即失效（包括发起重置前已登录的会话），前端提示重新登录。2FA 配置（`user_2fa`）不受影响。
- 并发/重放：同一令牌第二次提交 400 `INVALID_RESET_TOKEN`。

改密联动：`PUT /api/me/password`（主动改密）与 `PUT /api/admin/users/:id` 带 `password`（管理员改密）的会话口径不变，但都会清掉该用户未使用的 `password_reset` 验证码与 resetToken。

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
  "twofa": {
    "totpEnabled": false,
    "passkeyEnabled": false,
    "passkeyCount": 0,
    "emailOtpEnabled": false
  }
}
```

`publicId` 是对外展示的「用户 ID」（8 位、不可改），`id` 仍是内部 UUID。`avatarUrl` 未设置头像时为 `null`；图片本身要会话才能读。受限会话也可访问（前端据此跳 2FA 设置）。`twofa` 的四个字段并列：`totpEnabled` / `passkeyEnabled` / `passkeyCount` / `emailOtpEnabled`（邮箱验证码开关，前端设置页靠这个字段名显示「已开启」并判断重认证）。

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
  "twofa": {
    "totpEnabled": false,
    "passkeyEnabled": false,
    "passkeyCount": 0,
    "emailOtpEnabled": false
  }
}
```

400 缺少 `file` / 非图片；413 `code:"FILE_TOO_LARGE"`；401 未登录。

#### PUT /api/me/password

```json
{ "currentPassword": "…", "newPassword": "…" }
```

200 `{"success":true}`，删除该用户其它会话行（当前会话保留），并清掉该用户未使用的 `password_reset` 验证码与 resetToken（会话口径不变）。

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

| 端点                                          | 请求体                          | 响应                                                                                             |
| --------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST /api/auth/2fa/totp/setup`               | `password?`（见下）             | `{"secret":"BASE32","uri":"otpauth://…"}`（明文只回这一次，待确认密钥以密文存挑战行）            |
| `POST /api/auth/2fa/totp/enable`              | `{"code":"123456","password"?}` | `{"success":true}`；消费挑战行、解密校验后把密文落 `user_2fa`，并把当前受限会话标记清零          |
| `POST /api/auth/2fa/totp/disable`             | `{"password":"…"}`              | `{"success":true}`，清空密文与开关                                                               |
| `POST /api/auth/2fa/passkey/register/options` | `password?`（见下）             | WebAuthn 注册 options（写 `passkey_register` 挑战行）                                            |
| `POST /api/auth/2fa/passkey/register/verify`  | WebAuthn response + `password?` | `{"success":true}`；消费挑战行、插 `passkey_credentials`，并把受限会话标记清零                   |
| `DELETE /api/auth/2fa/passkey/:credentialId`  | `{"password":"…"}`              | `{"success":true}`；删除该凭证行                                                                 |
| `POST /api/auth/2fa/passkey/disable`          | `{"password":"…"}`              | `{"success":true}`；删除该用户全部凭证                                                           |
| `POST /api/auth/2fa/email-otp/send-verify`    | `password?`（见下）             | `{"success":true,"cooldownSeconds":60,"expiresInSeconds":600}`；向账号邮箱发 `2fa_enable` 验证码 |
| `POST /api/auth/2fa/email-otp/enable`         | `{"code":"123456","password"?}` | `{"success":true}`；消费 `2fa_enable` 验证码后置 `email_otp_enabled=1`，并清受限会话标记         |
| `POST /api/auth/2fa/email-otp/disable`        | `{"password":"…"}`              | `{"success":true}`；置 `email_otp_enabled=0` 并删除未用的 `2fa_enable` 验证码                    |

**密码重认证规则（新增/启用因子）**：账号**已有任何因子**（`totp_enabled` 为真、存在 `passkey_credentials` 行，或 `email_otp_enabled=1`）时，上表六个「新增/启用」端点（`totp/setup`、`totp/enable`、`passkey/register/options`、`passkey/register/verify`、`email-otp/send-verify`、`email-otp/enable`）必须带 `password`；缺密码 400 `{"error":"Password required"}`、密码错 403 `{"error":"Password is incorrect"}`、失败 5 次/5 分钟 429 `{"error":"Too many requests","code":"RATE_LIMITED"}`，成功清零。**没有任何因子时免密码**（首次设置、刚用密码登录过的账号直接走会话）。前端可用 `GET /api/me` 的 `twofa.totpEnabled` / `twofa.passkeyCount` / `twofa.emailOtpEnabled` 判断是否需要弹密码框。关闭 TOTP、删除/关闭 passkey、关闭邮箱验证码始终要求 `password`。

**邮箱验证码（`email-otp/*`）细则**：

- 收码邮箱就是**账号邮箱**（v1 不支持另设）；启用一律走「发码 → 输码」一次真实往返，验过才开，启用/停用即时生效。
- 三个会话端点在**受限会话**（`needs_2fa_setup=1`）下同样放行（白名单 `/api/auth/2fa/email-otp/*`）。
- `send-verify`：先看站点 `emailConfigured`（未配置 503 `EMAIL_NOT_CONFIGURED`，不写任何计数）→ 密码重认证（规则同上）→ `email_code_cd` / `email_code_send` / `email_code_send_ip` 限频（用途 `2fa_enable`、账号为 userId；60 秒冷却、每小时 5 封、每 IP 每小时 20 封，超限 429 带 `retryAfter`）→ 发信（失败 502 `SMTP_SEND_FAILED`）。
- `enable`：同样先检查 `emailConfigured`（503 且**不消费验证码**），再密码重认证，再 `email_code_verify` 限频（5 次/10 分钟，超限 429），最后校验 `2fa_enable` 用途、`binding=''` 的验证码；错码/无码/过期一律 400 `{"error":"Invalid code","code":"INVALID_CODE"}`，第 5 次错误删除该码。成功只写 `email_otp_enabled` 一列（TOTP 字段原样保留），并清除当前受限会话的 `needs_2fa_setup`。
- `disable`：**不看 SMTP 是否可用**（发信坏掉时用户仍必须能关掉，否则被锁死），不改 TOTP/Passkey、不吊销会话。

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

字段均可选。不能改自己的角色、不能停用自己。改角色/停用/改密码后吊销该用户全部会话；改密码时同样清掉该用户未使用的 `password_reset` 凭据（验证码与 resetToken）。邮箱撞已有账号 → 409 `code:"EMAIL_TAKEN"`（并发下也不回 500）。改邮箱时一并删除该用户全部 `email_codes`（旧邮箱收到的码立即作废）。`username` / `public_id` / 头像不在此接口里改。

#### DELETE /api/admin/users/:id

不能删自己；删除用户及其 2FA/passkey/会话/邮箱验证码行。

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
  "require2fa": false,
  "revisionRetentionLimit": 3,
  "emailConfigured": false
}
```

`revisionRetentionLimit`：每页保留的历史版本数，`number | null`，**`null` = 不限**（缺行与空串同义，这是唯一内部口径；下限 1）。

`emailConfigured` 与 `GET /api/auth/config` 同口径（只看 SMTP 非密字段），供系统管理页展示发信可用状态。

#### PUT /api/admin/settings

同一对象的任意子集：布尔项照旧，`siteName` 为字符串（trim 后 1–32 字符、不含控制字符，否则 400 `siteName must be 1-32 characters`）；`emailConfigured` 只读，不在写入字段里。200 `{"success":true}`。

`revisionRetentionLimit`：整数 ≥1 直接保存；`null` / `0` / 空串按「不限」落库（读出来一律是 `null`）；负数、非整数、非数字 → 400 `{"error":"revisionRetentionLimit must be a positive integer or null"}`。改设置不触碰任何存量版本，修剪只发生在「后续保存」与「手动全站修剪」两处。

#### GET /api/admin/system/smtp

```json
{
  "emailConfigured": true,
  "config": {
    "host": "smtp.example.com",
    "port": 587,
    "encryption": "starttls",
    "username": "mailer@example.com",
    "passwordSet": true,
    "from": "noreply@example.com",
    "fromName": "Ciki"
  }
}
```

- **永不返回密码**，只给 `passwordSet`；密文本身也不出现在任何 DTO 里。
- 未配置或 `smtp_config` JSON 损坏时 `config: null`、`emailConfigured: false`；JSON 合法但非密字段非法时仍回显 `config`（便于管理员修正），但 `emailConfigured: false`。

#### PUT /api/admin/system/smtp

请求体是全量替换的非密字段 + 密码语义：

```json
{
  "host": "smtp.example.com",
  "port": 587,
  "encryption": "starttls",
  "username": "mailer@example.com",
  "password": "新密码，或省略",
  "from": "noreply@example.com",
  "fromName": "Ciki"
}
```

- `password`：缺省 / 空串 / 纯 `•` 掩码 = 保留原密文（前端回传掩码不会变成新密码）；`null` = 清空；其它非空字符串 = 重新加密（每次新 IV）。
- 字段规则：`host` 非空 ≤253、不含空白/CR/LF/`:`/`@`；`port` 整数 1–65535；`encryption` ∈ `tls|starttls|none`；`username` ≤320 且与「生效的 password 是否有值」同时有或同时空；`from` 合法邮箱；`fromName` ≤64 且剥除 CR/LF。
- 成功 200 `{"success":true,"emailConfigured":true}`；校验失败 400 `{"error":"Invalid SMTP config: …","code":"INVALID_SMTP_CONFIG"}`；限流 429（`smtp_config`，见 auth_counters 表）。
- 密码只以 AES-GCM 密文落 `system_settings.smtp_config`，AAD 固定 `ciki:smtp:password`；日志与错误不回显明文密码或其 base64。

#### POST /api/admin/system/smtp/test

请求体被忽略（即使传 `to` 也不生效），**只发给当前管理员自己的邮箱**：200 `{"success":true}`。

- 未配置：503 `{"error":"Email delivery is not configured","code":"EMAIL_NOT_CONFIGURED"}`。
- 发送失败：502 `{"error":"SMTP send failed: …","code":"SMTP_SEND_FAILED"}`，原因为已脱敏的 SMTP 错误（不含密码；`ENCRYPTION_KEY` 轮换后旧密文解不开时也会返回可操作原因）。
- 限流：`smtp_test` 5 次 / 5 分钟，429 带 `retryAfter`。

#### GET /api/admin/revisions/retention（管理员会话）

全站修剪的只读预告，供二次确认文案使用：

```json
{ "limit": 3, "totalRevisions": 128, "prunableRevisions": 42 }
```

`prunableRevisions` 是「按当前设置点一次修剪会删掉的条数」，与执行时实际删除数同口径（每页 `COUNT(*) - limit` 之和，只算超出的页）；不限时为 `0`。

#### POST /api/admin/revisions/prune（管理员会话）

按当前设置修剪全部页面（含回收站页面的版本行），200 `{"limit":3,"deleted":42}`，`deleted` 即实际删除数（单条 set-based DELETE，原子）。只删 `page_revisions` 行：`pages` 当前内容、FTS、R2 对象都不动。不限时 409 `{"error":"Revision retention is unlimited","code":"RETENTION_UNLIMITED"}`，一条也不删。重复调用幂等（没有超出上限的版本时 `deleted: 0`）。

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
  "contentMd": "## 小节\n\n正文",
  "createdBy": "用户 id",
  "updatedBy": "用户 id",
  "createdAt": "…",
  "updatedAt": "…"
}
```

`contentMd` 是从 `contentJson` 派生的 Markdown（**只读、不含标题行**）：库里有 `content_md` 就给库里的值，没有（升级回填完成前）就按需现生成；空正文页是空串，绝不会是 `null`。阅读页「下载 .md」由服务端下载端点取同一份 MD（见下条 `GET /api/pages/:id/download`），本接口照旧下发该字段，两者都不经过只读令牌接口。

已软删、非成员或所属空间不可见均返回 404。

#### GET /api/pages/:id/download

阅读页「下载 .md」的服务端入口：按页面 MD 里有没有**站内图**自动分流，含站内图的页面下 zip 包（入口与按钮文案不变）。权限与 `GET /api/pages/:id` 同一口径：非成员、页面不存在、已软删一律 404；走 `/api/pages` 的会话中间件，只读令牌与导入令牌都进不来。

- **站内图**（分流依据）= MD 里形如 `![alt](https://ciki.oneboy.app/api/files/<key>)` 的图片引用，且 `<key>` 满足 `/api/files` 的 key 形状（`pages|imports|avatars/<uuid>.<ext>` 或存量平铺 `<uuid>.<ext>`）。站外图、形状不合规的本站地址（`svg`、非 UUID 等）都不算。
- **产物口径**：文件名主名沿用一期 `markdownFilename` 的规则（丢控制字符 → `[\\/:*?"<>|]` 换 `-` → 连续 `-` 折成一个 → 去首尾 `-` / `.` / 空白 → 空则「未命名页面」），中文原样由 `filename*` 承载；`filename` 给 ASCII 兜底（非 ASCII 字符换 `-` 后折叠，折叠后为空用 `page`）。
- 正文取值与只读接口一致：库里有 `content_md` 就用，没有就按需现生成。

**无站内图 → 200 `.md`**：`Content-Type: text/markdown; charset=utf-8`，`Content-Disposition: attachment; filename="<ASCII兜底>.md"; filename*=UTF-8''<百分号编码>`。正文与一期前端产物逐字节一致：`# <title.trim()>\n\n<contentMd.trimEnd()>\n`，正文为空时只有 `# <title.trim()>\n`。

**有站内图 → 200 zip**：`Content-Type: application/zip`，主名同 `.md`、扩展名换 `.zip`。包结构：

```text
<标题>.md           # 与 .md 产物同款：标题行 + 空行 + 正文
images/<basename>   # 每张被引用站内图一份；同图被多次引用只入一份
```

- `images/` 下的文件名取 key 的 basename（`pages/<uuid>.png` → `<uuid>.png`）；真撞名（如 `pages/<uuid>.png` 与 `imports/<uuid>.png`）按 key 全路径下划线化兜底。
- 包内条目按 Unix 语义写：中央目录的 `version made by` = 3（Unix）、外部属性含 `0644` 权限位，非 ASCII 条目名带 UTF-8 标志位（bit 11）。因此 macOS 的系统 `/usr/bin/unzip`、Finder 与其它标准实现都能正确解出中文标题的 `.md`（不置 Unix 语义时 Info-ZIP 会按 DOS 代码页解码中文名而失败）。
- 包内 MD 只改站内图链接为 `images/<basename>`：alt 原样、站外图地址原样，其余内容与 `.md` 产物逐字一致。
- 引用的图在 R2 已不存在（如已被孤儿清理）：该图不入包，链接保留原绝对地址，不因个别缺图让整包失败。分流只看引用，所以全部缺图时仍是 zip（包内只有 MD）。
- 只动下载产物：库里 `content_md` 仍是绝对地址版（`GET /api/pages/:id` 的 `contentMd` 口径不变），相对化只发生在组装 zip 时。
- 组装是流式的：图从 R2 按 key 直读（与 `/api/files` 同源）、逐块写入 zip 响应，不把整包或整图先读进内存；zip 由 fflate 生成。

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

200 完整详情。空间 `editor` 及以上可编辑；`viewer` 403、非成员 404。四列（`title` / `contentJson` 归一化后 / `contentHtml` 消毒后 / `contentText` 规范化后）与库里现存值全等 → 判定为无改动：不写页面行（`updatedAt`、`updatedBy` 不动）、不追加 revision、不重建 FTS，响应与正常保存同形（返回现存页面详情）；任一项不同即正常保存，追加一条 revision 并同步 FTS。

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

形状与改前一致：`contentJson` 是解压出来的原文，`contentHtml` / `contentText` 由服务端按需生成（详见「page_revisions」）。`viewer` 可读；非成员 404。该版本的 JSON 无法按当前编辑器 schema 渲染时 422 `code:"REVISION_UNRENDERABLE"`。

#### DELETE /api/pages/:id/revisions/:revisionId

删一条历史版本，200 `{"success":true}`。权限与回滚同档（所属空间 `editor` 及以上）：非成员 404、`viewer` 403、页面在回收站 404、版本不存在/不属于该页 404 `{"error":"Revision not found"}`。

每页最新一条是当前内容的快照，**不许删**：409 `{"error":"Cannot delete the latest revision","code":"REVISION_IS_LATEST"}`。删中间版本不影响其余版本的查看与回滚；只删版本行本身——页面当前内容、FTS、R2 文件都不动（孤儿图归月度清理判定）。

#### POST /api/pages/:id/revisions/prune

按页批量删版本：只留最新一条，其余全删，200 `{"deleted":3}`。权限与 404 口径同上。重复调用幂等（已是 1 条时 `deleted: 0`）。

#### POST /api/pages/:id/revisions/:revisionId/restore

以该快照写回页面并生成新 revision，返回 200 完整页面详情。快照内容由该版本的 JSON 重渲染（HTML/纯文本与「查看单个版本」同一路径）再写回；与当前页面全等（即回滚到当前版本）→ 无改动：不写行、不新增 revision，响应仍是 200 完整页面详情。需所属空间 `editor` 及以上；`viewer` 403、非成员 404。渲染失败 422 `code:"REVISION_UNRENDERABLE"`，页面内容保持原样。

### 评论

评论挂在页面维度下（`/api/pages/:id/comments…`），与页面同一条会话中间件：未登录 401；读与发表用与 `GET /api/pages/:id` **同一把权限尺子**（登录 + 对该页有读权限，空间成员任一角色，`viewer` 也能评）；非成员与页面不存在/已软删一律 404（不泄露存在性）。编辑仅作者本人；删除为作者本人、该页所属空间 `admin`、站点管理员。

正文只存 Markdown 原文，HTML 由服务端现算：`marked`（GFM，`breaks: true`）→ 站内消毒器（与正文同一份白名单，只放开 `img[src]` 的判定，见「服务端消毒规则」）。列表、预览、发表/编辑的响应共用同一条链，**前端不做二次渲染、不引前端 MD 库**。

#### GET /api/pages/:id/comments

整页一次返回（不分页）：

```json
{
  "total": 3,
  "threads": [
    {
      "id": "…",
      "parentId": null,
      "authorId": "…",
      "authorName": "张三",
      "authorAvatarUrl": "/api/files/avatars/….png",
      "bodyMd": "## Markdown 原文",
      "html": "<h2>Markdown 原文</h2>",
      "createdAt": "…",
      "editedAt": null,
      "deletedAt": null,
      "canEdit": true,
      "canDelete": true,
      "replies": [
        { "id": "…", "parentId": "顶层评论 id", "bodyMd": "…", "html": "…" }
      ]
    }
  ]
}
```

- `replies` 里每条字段与顶层同形（不含 `replies`），`parentId` 恒为所属顶层评论 id（回复只一级，按 `createdAt` 正序平铺）。顶层按 `createdAt` 正序。
- `total` = 未删除的顶层 + 未删除的回复条数（评论区标题的条数就用它；为 0 时前端只显示标题）。
- 软删呈现：无存活回复的评论（顶层或回复）整条不返回；**有存活回复的顶层评论保留占位**——`deletedAt` 非空、`bodyMd` / `html` 为空串、`canEdit` / `canDelete` 为 `false`，其回复照常返回，串结构不断。
- `authorName` / `authorAvatarUrl` 与 `GET /api/me` 同口径（`username`、`avatar_key` → `/api/files/<key>`，无头像为 `null`）；作者已被彻底删除时 `authorName` 回落「已注销用户」。
- `canEdit` = 当前用户是作者且未删除；`canDelete` = 未删除且（作者本人、该页所属空间 `admin`、站点管理员）。前端直接用这两位移操作入口，不自行重算。

#### POST /api/pages/:id/comments

```json
{ "bodyMd": "## 正文", "parentId": "顶层评论 id 或 null" }
```

201 返回新评论 DTO（同列表里的单条形状，不含 `replies`）。`parentId` 缺省 / `null` / 空串 = 顶层评论。

- 回复的目标若本身是回复，先归一到其顶层评论再落库（响应里的 `parentId` 是顶层 id）。
- **`parentId` 指向已软删的评论仍接受**，不报错：对着「该评论已删除」占位点回复时，前端提交的正是这个已删的顶层 id；新回复照旧挂在该串下，串结构因此保留（占位因多了一条存活回复而继续保留）。这一点对已软删的回复 id 同样成立（归一到它的顶层）。
- 只有「不存在 / 不属于本页」是 404 `code:"COMMENT_NOT_FOUND"`；空正文（trim 后为空）400 `code:"COMMENT_EMPTY"`；正文超限 413 `code:"PAYLOAD_TOO_LARGE"`。

#### POST /api/pages/:id/comments/preview

`{ "bodyMd": "…" }` → 200 `{ "html": "…" }`，与列表同一条渲染净化链，不写库。空正文回 `{"html":""}`（不报错）；权限同 GET。预览必须走这个端点——前端不得自己渲染出第二套结果。

#### PUT /api/pages/:id/comments/:commentId

`{ "bodyMd": "…" }` → 200 更新后的 DTO。**仅作者本人**（空间 `admin` / 站点管理员也不行）：非作者 403，评论不存在 404，已删除 409 `code:"COMMENT_DELETED"`。只改正文与 `editedAt`（首次编辑起非空，前端据此显示「已编辑」）、`createdAt` 不动。

#### DELETE /api/pages/:id/comments/:commentId

软删，200 `{"success":true}`；重复删除幂等（仍 200，不覆盖首次的 `deletedAt`）。权限：作者本人、该页所属空间 `admin`、站点管理员；其余成员 403、非成员 404。

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
- `conflict` 必填：`"update"` = 同空间同父级同名未删页则覆盖内容并追加一条 revision（与编辑器保存同一条写路径：页面 + revision + FTS 同一 `db.batch()` 事务）；内容与现存行四列全等时是同一路径上的空操作——不写行、不新增 revision，响应仍为 200 `{pageId,url}`。不存在则新建；`"create_copy"` = 总是新建，不改写标题。
- 新建 201、更新 200，响应一致：

```json
{ "pageId": "…", "url": "/p/<pageId>" }
```

- 渲染与消毒：`contentHtml = sanitizePageHtml(renderTiptapHtml(contentJson))`——服务端按编辑器扩展集建 schema，用 ProseMirror 的 `DOMSerializer` 在 happy-dom（Worker 内的 `GlobalWindow`，不依赖 Worker 外的 DOM）上原生渲染，再过 §4 同一支白名单消毒；`contentText` 由消毒后的 HTML 生成。插件侧的 HTML/纯文本不被信任，**消毒结果为准**。服务端渲染把表格列宽写成 `col[width]`，读态列宽比例保留——列数=1 的表格是例外：唯一列占满正文宽，列宽一律不落（单元格 `colwidth` 与 `col[width]` 都不写，服务端渲染不再生成带宽度提示的 `colgroup`），读态按全宽渲染、不会把源端那个窄宽度拣回来；任务项勾选态为 `data-checked="true"|"false"`；颜色写成 data 载具（见下一条）；代码块折叠态写成 `pre[data-collapsed]`（见下下条）。
- 颜色（插件侧需要产出的 JSON 形态）：文字颜色 `marks: [{ "type": "textStyle", "attrs": { "color": "#rrggbb" } }]`，高亮 `marks: [{ "type": "highlight", "attrs": { "color": "#rrggbb" } }]`，单元格底色 `tableCell` / `tableHeader` 的 `attrs.backgroundColor: "#rrggbb"`（与 `colspan` / `rowspan` / `colwidth` 并列，表头同样适用）。值只认 `#rrggbb`；其它写法（命名色、`rgb()`、`var()`、带透明度）不会报错，但颜色会被丢弃。
- 代码块折叠（插件侧需要产出的 JSON 形态）：`codeBlock` 的 `attrs.collapsed`，三态——`true` = 作者/来源明确设为折叠；`false` = 明确设为展开（永不自动折）；不写该属性（或写 `null`）= 未表态，阅读页按代码行数自动决定（>20 行初始折叠，≤20 行展开）。服务端把它渲染成挂在 `pre` 上的 `data-collapsed`，`code` 仍只带 `language-*`；未表态**不输出**该属性，三态因此都能区分。值只认布尔（`null` 等同未表态）；`"true"` 这类字符串、数字、对象一律 400 `code:"INVALID_CONTENT_JSON"`，不静默丢属性。折叠是显示状态：不改正文、不进 `contentText`、不影响搜索与版本内容比对；但属性本身属于节点属性，变化照常算一次编辑存版（无改动的判等口径不变）。三态样例（`attrs` → `content_html`）：

| 状态   | `codeBlock.attrs`                           | 渲染出的 `content_html`                                                |
| ------ | ------------------------------------------- | ---------------------------------------------------------------------- |
| 折叠   | `{"language":"js","collapsed":true}`        | `<pre data-collapsed="true"><code class="language-js">…</code></pre>`  |
| 展开   | `{"language":"js","collapsed":false}`       | `<pre data-collapsed="false"><code class="language-js">…</code></pre>` |
| 未表态 | `{"language":"js"}`（或 `collapsed: null`） | `<pre><code class="language-js">…</code></pre>`                        |

- 错误：400 参数非法（标题、`parentId` / `space_id` 类型、`conflict` 取值）；400 `code:"INVALID_CONTENT_JSON"`（JSON 解析失败、未知节点/mark、未声明属性、结构不合 schema）；403 `code:"SPACE_FORBIDDEN"`；404 `code:"SPACE_NOT_FOUND"`；409 `code:"DEFAULT_SPACE_MISSING"` / `code:"PARENT_DELETED"`（父页不存在或已软删）/ `code:"SPACE_MISMATCH"`；413 `code:"PAYLOAD_TOO_LARGE"`（`contentJson` ≤800,000 B、消毒后 HTML ≤800,000 B、纯文本 ≤300,000 B、四件套含派生 MD 合计 ≤1,900,000 B）；401；429。

### 只读接口（只读令牌）

一期供外部连接器（Muse）接入的一组**只读**接口：只有读，没有任何写接口；不接受会话 Cookie，导入令牌与只读令牌两边互不通用（见「read_tokens」）。

#### 令牌管理（均需会话 Cookie）

##### GET /api/me/read-token

```json
{
  "active": true,
  "createdAt": "2026-11-10T12:00:00.000Z",
  "lastUsedAt": null,
  "revokedAt": null
}
```

从未生成过时三个时间字段均为 `null`、`active` 为 `false`。永不返回哈希或明文。

##### POST /api/me/read-token

生成或重置当前用户的只读令牌（覆盖既有令牌，旧令牌立即失效），200：

```json
{ "token": "…", "createdAt": "2026-11-10T12:00:00.000Z" }
```

**明文只在此响应出现一次**。限流 10 次 / 5 分钟（按用户），超出 429 `code:"RATE_LIMITED"`。

##### DELETE /api/me/read-token

吊销当前用户的只读令牌：200 `{"success":true}`。从未生成过 404；已吊销再调用仍 200（幂等）。

#### 读接口通用约定

- 鉴权：只认 `Authorization: Bearer <只读令牌>`。缺令牌、令牌无效、已吊销、用户被停用或未批准 → 401 `{"error":"Unauthorized"}`，响应 `Cache-Control: no-store`。**会话 Cookie 与查询参数都不认**。
- 权限 = 令牌所属用户本人的读权限：站点管理员可见全部空间，其余人只见自己是成员的空间；非成员空间的内容在 SQL 层就被过滤（与站内页面树/搜索同一口径）。
- 限流沿用 `auth_counters`：失败按 IP（`read_auth_fail` 20 次 / 5 分钟，先拒后验），调用按用户（`read` 3000 次 / 5 分钟）。超出 429 `{"error":"Too many requests","code":"RATE_LIMITED","retryAfter":秒}`。
- **软删页面**（`deleted_at` 非空）在三处一律排除。
- 响应统一 JSON、UTF-8；**不加分页、不做版本协商**。字段是 snake_case（本文件 camelCase 通则的唯一例外，接入方按此对接）。
- 每次成功调用都刷新令牌的 `lastUsedAt`。

#### GET /api/read/tree

全部未删页面的扁平表（不分页、不建树；`parent_id` 给调用方自己拼层级），按「空间 → 同级顺序 → 创建时间」排序：

```json
[{ "id": "…", "title": "首页", "parent_id": null, "updated_at": "…" }]
```

#### GET /api/read/search?q=<词>

全文搜索，与站内搜索（`GET /api/search`）同一支 FTS5 查询与 `bm25` 排序，上限固定 20 条：

```json
[
  {
    "id": "…",
    "title": "团队知识库",
    "snippet": "…命中附近的纯文本片段…",
    "updated_at": "…"
  }
]
```

`snippet` 是纯文本（不含 HTML）。空词或只有标点返回 `[]`。

#### GET /api/read/pages/:id

```json
{
  "id": "…",
  "title": "…",
  "parent_id": null,
  "created_at": "…",
  "updated_at": "…",
  "markdown": "## 小节\n\n正文"
}
```

- `markdown` 即 `pages.content_md`（不含标题行）；列为空或尚未回填时按需现生成，不报错也不回空文档。
- 带 `?format=json` 时改回真源：`{…, "content_json": "{\"type\":\"doc\",…}"}`（不再返回 `markdown`）。
- 页面不存在或已软删 → 404 `{"error":"Page not found"}`；所属空间非令牌用户可见也同样 404（不泄露存在性）。

#### Markdown 派生规则（`content_md` / `markdown` / `contentMd` 三者同一口径）

派生方向只有一个：`content_json` → Markdown。**任何路径不得以 MD 反写正文**；MD 有损，只作导出/机读视图。

- 标题→`#` 级别对应；段落、粗/斜/删除线、行内代码、链接按 GFM 常规；有序列表保留起始序号，嵌套列表每层缩进 2 空格；任务列表→`- [ ]` / `- [x]`。
- 代码块→带语言标注的围栏（内容里有反引号时自动加长围栏）；引用块→`>`（信息面板在粘贴/导入时已降级为引用块）；分割线→`---`；硬换行→行尾两空格。
- 表格→GFM 管道表：合并单元格降级——内容只留锚点格、被覆盖格留空，行列按网格展开并补空；表头取原表头行，原表无表头则第一行升为表头位；单元格里的 `|` 转义为 `\|`。
- 图片→`![alt](绝对地址)`：本站路径（`/api/files/...`）补全为 `https://ciki.oneboy.app` + 路径；已是绝对地址或 `data:` 原样保留；只有 `data-original-src` 的未转存占位图用它。
- 颜色/高亮→丢弃只留文字；下划线→降为纯文字；未知节点降级为它的文字内容。
- 派生**永不报错**：JSON 无法解析或不合当前 schema 时退回已消毒的纯文本（`content_text`）。
- `content_md` 不参与无改动保存的判等（判等仍是标题 + `content_json` + `content_html` + `content_text` 四项）；历史版本不存 MD。

### 服务端消毒规则（content_html）

保存/回滚时执行：保留结构性标签与下列属性，其余一律剥除。

- 表格：`colspan` / `rowspan`（td/th）、`col` 的 `width` 或受限 `style`（仅 `width`/`min-width` 的 px/% 数值）、`table` 的受限 `style`（仅 `min-width: Npx`）、`colgroup`。
- 颜色：`span[data-text-color]`（文字颜色）、`mark[data-color]`（高亮）、`td[data-cell-bg]` / `th[data-cell-bg]`（单元格底色），值仅 `#rrggbb`（大小写都收，入库统一小写）。颜色**不走内联 `style`**：编辑器/粘贴/插件导入三条入口都落成同一套 data 载具，读态由编辑器扩展还原成内联样式；所以 `content_html` 里不会出现颜色相关的 CSS，非法色值只丢颜色、不动文字。
- 代码：`pre[data-collapsed="true"|"false"]`（代码块折叠三态，见「POST /api/import/pages」；值不是这两个就只删该属性、代码正文照常保留）、`code[class="language-*"]`。
- 任务列表：`ul[data-type]`、`li[data-type][data-checked]`、`label`、只读 `input[type=checkbox][checked]`。
- 链接：`a[href]` 仅 http/https/mailto/相对路径。
- 图片：`img[src]` 仅本站 `/api/files/<uuid>.<ext>`（存量平铺）或 `/api/files/(pages|imports)/<uuid>.<ext>`（新前缀；`avatars/` 只服务资料页，不进正文），或 `data:image/(png|jpeg|gif|webp);base64,…`；其它 `src` 移入 `data-original-src` 并加 `data-confluence-img="true"`（「未转存」标记，读态由前端渲染占位并提供上传替换入口）。
- 一律剥除 `script`/`style`/`iframe`/`object`/`embed`/`form` 及所有 `on*` 事件属性、未列出的 class/attr。
- **评论正文（`comments.body_md`）**：服务端用 `marked` 渲染后再过同一份白名单，与正文只差 `img[src]` 一项——站内 `/api/files/…` 与 `https:` 外链原样保留，`http:` / `data:` / 非法地址删掉 `src`（评论区没有上传入口，不写 `data-original-src` 占位）。`<script>`、事件属性、`javascript:` 链接、白名单外标签一律剥除，与正文同口径。

## 四、前端对接要点

- **升级顺序**：代码部署后、管理员在「系统管理 → 数据库维护」点一次「检查并升级数据库」（`POST /api/admin/setup`）之前，全新库还没有任何表——注册、登录、页面等业务接口都会失败。点完之后一次建全（含默认空间），即可正常使用；已初始化的库再点一次只显示 `skipped`，不重复建表、不重复播种默认空间。从旧版升级时，这一次 setup 会把旧账本 `{prefix}schema_migrations` 改名承接为 `_{prefix}schema_migrations`，已应用记录保留（迁移全显示 `skipped`）。
- 所有请求带 `credentials: "include"`；收到 401 时先 `POST /api/auth/refresh` 重试一次，仍 401 再跳登录。
- 401 有两个含义，客户端必须分开：会话中间件的 `Unauthorized` 才是会话过期（上面的刷新流程）；登录与两步验证端点的 401 表达「这次验证没通过」——`Invalid credentials`（账号密码错）、`Invalid verification code`（TOTP 输错）、`Invalid or expired 2FA session`（挑战过期/作废）、`Verification failed`（Passkey 验证未过）。后者不得提示「登录状态已失效」，否则用户会被引去重走整个登录。
- 登录两步：`requires2fa` 时用 `tempToken` 调 TOTP 或 passkey 验证端点；两步表单必须换 DOM 节点（前端单要求）。
- 受限会话（`needs2faSetup`）：只能进 2FA 设置，配置成功后受限标记自动清零，无需重新登录。
- 页面读态渲染 `contentHtml`；编辑态使用 `contentJson`。外链图片以 `data-original-src` + `data-confluence-img` 呈现「未转存」。文字颜色/高亮/单元格底色在 `contentHtml` 里是 data 载具（见「服务端消毒规则」），由读态扩展还原成内联样式，前端不要另外拼颜色样式。
- 代码块折叠：`content_html` 里三态由 `pre[data-collapsed]` 承载（`"true"` / `"false"` / 无此属性），读态由编辑器扩展还原成节点属性 `collapsed`。无属性时的初始状态由前端按代码行数自动决定（>20 行折叠、≤20 行展开）——这是前端行为，服务端不参与、也不在 `content_html` 里预判。折叠只影响显示：MD 派生仍是围栏代码块、`collapsed` 丢弃，属已知降级。
- 上传：正文图（编辑器、粘贴、补抓）走 `POST /api/files`（落 `pages/`）；插件导入走 `POST /api/import/files`（落 `imports/`）；Profile 页头像走 `POST /api/me/avatar`，响应即最新 `Me`，不再「先上传拿 key、再 PUT /api/me/profile」。图片地址白名单（前后端同义）需同时接受平铺与 `pages|imports/` 前缀，否则新图会被判成「未转存」。
- 「数据库维护」页的最近一轮清理摘要取 `GET /api/admin/r2-cleanup` 的 `lastRun`，渲染一行（运行时间 + 计数）；手动清理走两步 UI：第一步 dry run 预览可清理数（`prunable`）与总大小（`prunableBytes`），第二步确认后实跑（`truncated: true` 时提示还有剩余）；`running` 非空时按钮禁用并显示「清理进行中」。按钮文案与确认细节见前端单。
- 主题等纯前端偏好不进本契约（客户端持久化）。
- 本契约不含：公开分享、多人实时协同、宏、Jira、通用附件、Markdown 存储、注册邮箱验证与邮件通知渠道（SMTP 配置与验证码 plumbing 见「数据模型」与「管理」，邮箱验证码 2FA 与找回密码端点见「鉴权」）。
