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
/** 个人导入令牌（规格 §12.1）：每用户一枚，只存 SHA-256。 */
export const importTokensTable = (prefix: string) =>
  tableName(prefix, "import_tokens")
/**
 * 只读接口令牌（一期）：与导入令牌并列、互不通用，形状同 `import_tokens` 但**独立一张表**
 * ——两边各查各的表，双向隔离靠表隔离落地，不靠路由层的额外判断。
 */
export const readTokensTable = (prefix: string) =>
  tableName(prefix, "read_tokens")
/**
 * 读写接口令牌（二期，`schema_v2` 追加）：与只读令牌**逐列一致但独立一张表**。
 * 三套令牌（导入 / 只读 / 读写）的隔离同样靠表隔离落地：读侧中间件两张表都认，
 * 但只认自己那种；导入令牌与只读令牌调写接口一律 401。
 */
export const writeTokensTable = (prefix: string) =>
  tableName(prefix, "write_tokens")
/** `write_tokens.token_hash` 的唯一索引名（与 `read_tokens` 同口径，不带 `idx_` 前缀）。 */
export const writeTokensTokenHashIndex = (prefix: string) =>
  tableName(prefix, "write_tokens_token_hash")
/**
 * 令牌空间范围（二期，`schema_v2` 追加）：一行 = 「该用户的该类令牌可见该空间」。
 * 三列联合主键；无行 = 不限制。范围只收窄不放大：生效范围是「主人可见空间 ∩ 范围」，
 * 在每次令牌校验时回表计算（见 core/token-scope.ts）。
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
