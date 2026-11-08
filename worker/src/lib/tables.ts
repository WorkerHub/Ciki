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
/** 空间（规格「Ciki Space」）：默认空间由 schema_v4 建，`is_default=1`。 */
export const spacesTable = (prefix: string) => tableName(prefix, "spaces")
/** 空间成员与角色（admin / editor / viewer），(space_id, user_id) 唯一。 */
export const spaceMembersTable = (prefix: string) =>
  tableName(prefix, "space_members")
export const pagesTable = (prefix: string) => tableName(prefix, "pages")
export const revisionsTable = (prefix: string) =>
  tableName(prefix, "page_revisions")
/** 个人导入令牌（规格 §12.1）：每用户一枚，只存 SHA-256。 */
export const importTokensTable = (prefix: string) =>
  tableName(prefix, "import_tokens")
/** FTS5 虚拟表同样经前缀 helper 拼名（规格 §6）。 */
export const pagesFtsTable = (prefix: string) => tableName(prefix, "pages_fts")
/** 迁移账本：与业务表同一前缀，换前缀即换一套账本。 */
export const migrationsTable = (prefix: string) =>
  tableName(prefix, "schema_migrations")
/** R2 孤儿清理的运行日志（规格 §3）：每轮一行，不含任何对象内容。 */
export const r2CleanupRunsTable = (prefix: string) =>
  tableName(prefix, "r2_cleanup_runs")
/** waker SDK 的 executionId 幂等账本（回调协议 v2，列照 SDK 的 executionLedgerDdl）。 */
export const wakerExecutionsTable = (prefix: string) =>
  tableName(prefix, "waker_executions")
