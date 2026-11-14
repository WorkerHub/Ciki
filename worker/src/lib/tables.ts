/**
 * 所有表名/索引名的唯一拼装点（规格 §6：表名一律经 TABLE_PREFIX helper，
 * 不得写死最终表名）。前缀来自 src/lib/table-prefix.ts 的 getTablePrefix()。
 *
 * 除本文件外，其它模块不得用 `${prefix}pages` 这类字面量拼表名。
 */

/** 把逻辑表名拼成当前部署下的实际表名。 */
export function tableName(prefix: string, name: string): string {
  return `${prefix}${name}`
}

/** 把逻辑索引名拼成当前部署下的实际索引名。 */
export function indexName(prefix: string, name: string): string {
  return `idx_${prefix}${name}`
}

export const usersTable = (prefix: string) => tableName(prefix, "users")
export const user2faTable = (prefix: string) => tableName(prefix, "user_2fa")
export const passkeysTable = (prefix: string) =>
  tableName(prefix, "passkey_credentials")
export const sessionsTable = (prefix: string) => tableName(prefix, "sessions")
export const challengesTable = (prefix: string) =>
  tableName(prefix, "auth_challenges")
export const countersTable = (prefix: string) =>
  tableName(prefix, "auth_counters")
export const settingsTable = (prefix: string) =>
  tableName(prefix, "system_settings")
/**
 * 邮箱验证码（#48 契约 DDL）：(user_id, purpose, binding) 复合主键，重发覆盖旧码；
 * 库内只存 `SHA-256("<purpose>:<userId>:<code>")`，不存明文码。
 */
export const emailCodesTable = (prefix: string) =>
  tableName(prefix, "email_codes")
/** 空间（规格「Ciki Space」）：默认空间由唯一迁移 schema_v1 播种，`is_default=1`。 */
export const spacesTable = (prefix: string) => tableName(prefix, "spaces")
/** 空间成员与角色（admin / editor / viewer），(space_id, user_id) 唯一。 */
export const spaceMembersTable = (prefix: string) =>
  tableName(prefix, "space_members")
export const pagesTable = (prefix: string) => tableName(prefix, "pages")
export const revisionsTable = (prefix: string) =>
  tableName(prefix, "page_revisions")
/**
 * 页尾评论（规格「Ciki 页尾评论」）：`parent_id` 为 NULL 是顶层评论，回复恒指向其
 * 顶层评论 id（只一级，不产生二级嵌套）；软删只置 `deleted_at`，彻底删除随父页硬删。
 */
export const commentsTable = (prefix: string) => tableName(prefix, "comments")
/**
 * 个人导入令牌（`schema_v3` 起为多行）：每个浏览器插件凭证一行，只存 SHA-256。
 * 与接口令牌分表，两个入口互不通用（表隔离）。
 */
export const importTokensTable = (prefix: string) =>
  tableName(prefix, "import_tokens")
/** `import_tokens.token_hash` 的唯一索引名（沿用基线里的名字，不带 `idx_` 前缀）。 */
export const importTokensTokenHashIndex = (prefix: string) =>
  tableName(prefix, "import_tokens_token_hash")
/**
 * 接口令牌（`schema_v3` 起读写合表）：`kind` 区分只读 / 读写，一个令牌一行。
 * 读接口接受两种 kind，写接口只接受 `write`；与导入令牌仍是两张表、互不通用。
 */
export const apiTokensTable = (prefix: string) =>
  tableName(prefix, "api_tokens")
/** `api_tokens.token_hash` 的唯一索引名（与既有令牌表同口径，不带 `idx_` 前缀）。 */
export const apiTokensTokenHashIndex = (prefix: string) =>
  tableName(prefix, "api_tokens_token_hash")
/**
 * 只读接口令牌表（一期形态）：**仅** `schema_v1` 基线建表、`schema_v2` 旧定义与
 * `schema_v3` 迁移搬运使用；运行期不再读写它（`schema_v3` 会删掉这张表）。
 */
export const readTokensTable = (prefix: string) =>
  tableName(prefix, "read_tokens")
/**
 * 读写接口令牌表（二期 `schema_v2` 形态）：同样只供迁移与旧定义使用，
 * 运行期已并入 `api_tokens`（见 core/api-token.ts）。
 */
export const writeTokensTable = (prefix: string) =>
  tableName(prefix, "write_tokens")
/** `write_tokens.token_hash` 的唯一索引名（`schema_v2` 建表用，不带 `idx_` 前缀）。 */
export const writeTokensTokenHashIndex = (prefix: string) =>
  tableName(prefix, "write_tokens_token_hash")
/**
 * 令牌空间范围（`schema_v3` 起按令牌 id）：一行 = 「该令牌可见该空间」。
 * `(token_id, space_id)` 复合主键；无行 = 不限制。范围只收窄不放大：生效范围是
 * 「主人可见空间 ∩ 范围」，在每次令牌校验时回表计算（见 core/token-scope.ts）。
 */
export const tokenSpaceScopesTable = (prefix: string) =>
  tableName(prefix, "token_space_scopes")
/** FTS5 虚拟表同样经前缀 helper 拼名（规格 §6）。 */
export const pagesFtsTable = (prefix: string) => tableName(prefix, "pages_fts")
/**
 * 迁移账本（规格 §4.4）：表名带前导下划线、排在业务表之前——
 * `_ciki_schema_migrations`、无前缀时 `_schema_migrations`。换前缀即换一套账本。
 */
export const migrationsTable = (prefix: string) =>
  `_${tableName(prefix, "schema_migrations")}`

/**
 * 旧版迁移账本名（无前导下划线，如 `ciki_schema_migrations`）。
 * 只供 setup 的一次性改名承接使用，业务代码不得再往这张表读写信账。
 */
export const legacyMigrationsTable = (prefix: string) =>
  tableName(prefix, "schema_migrations")
/** R2 孤儿清理的运行日志（规格 §3）：每轮一行，不含任何对象内容。 */
export const r2CleanupRunsTable = (prefix: string) =>
  tableName(prefix, "r2_cleanup_runs")
/** waker SDK 的 executionId 幂等账本（回调协议 v2，列照 SDK 的 executionLedgerDdl）。 */
export const wakerExecutionsTable = (prefix: string) =>
  tableName(prefix, "waker_executions")
