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
export const pagesTable = (prefix: string) => tableName(prefix, "pages")
export const revisionsTable = (prefix: string) =>
  tableName(prefix, "page_revisions")
/** FTS5 虚拟表同样经前缀 helper 拼名（规格 §6）。 */
export const pagesFtsTable = (prefix: string) => tableName(prefix, "pages_fts")
/** 迁移账本：与业务表同一前缀，换前缀即换一套账本。 */
export const migrationsTable = (prefix: string) =>
  tableName(prefix, "schema_migrations")
