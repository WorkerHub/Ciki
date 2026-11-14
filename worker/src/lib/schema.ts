/**
 * 基线表结构的唯一真源（ID 整数化 + 正文上 R2 之后的定版结构）。
 *
 * 这份 DDL 只属于唯一迁移 `schema_v1`：全新库按它一次建出全部表/索引（表名带生效
 * 前缀，见 `migrations.ts` 的 `baselineStatements` 用法）。
 *
 * 约定：
 * - 每个 DDL 是一条完整语句，内部不得出现 `;`（迁移执行器按 `;` 切分）。
 * - 索引用 `{prefix}` 占位、在表建好后建；唯一约束一律用唯一索引表达。
 * - 主键一律 `INTEGER PRIMARY KEY AUTOINCREMENT`：id 永不复用，删掉的用户/页面不会
 *   被后来的新行「继承」掉旧的引用（`created_by` 等没有外键约束）。
 *
 * 基线已冻结：`schema_v1` 不得改名、改内容或调序，今后结构变化从 `schema_v2` 往后
 * 追加（新表/新索引写进本条迁移自己的 sql，不改这里的历史定义）。
 */
import { tableName } from "./tables"

export interface SchemaTable {
  /** 逻辑表名（不含前缀）。 */
  name: string
  /** `CREATE TABLE` 语句，表名用 `{table}` 占位。 */
  ddl: string
}

/**
 * 全部表（含 FTS5 虚拟表）。顺序即 `schema_v1` 建表语句的顺序，父子无外键、互不依赖。
 */
export const SCHEMA_TABLES: SchemaTable[] = [
  {
    name: "users",
    ddl: `CREATE TABLE IF NOT EXISTS {table} (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'user',
  is_active      INTEGER NOT NULL DEFAULT 1,
  approval_status TEXT NOT NULL DEFAULT 'approved',
  email_verified INTEGER NOT NULL DEFAULT 0,
  language       TEXT NOT NULL DEFAULT 'zh',
  username       TEXT NOT NULL DEFAULT '',
  avatar_key     TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
)`
  },
  {
    name: "user_2fa",
    ddl: `CREATE TABLE IF NOT EXISTS {table} (
  user_id          INTEGER PRIMARY KEY,
  totp_secret      TEXT,
  totp_enabled     INTEGER NOT NULL DEFAULT 0,
  email_otp_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL
)`
  },
  {
    name: "passkey_credentials",
    ddl: `CREATE TABLE IF NOT EXISTS {table} (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  credential_id TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
)`
  },
  {
    name: "sessions",
    ddl: `CREATE TABLE IF NOT EXISTS {table} (
  id              TEXT PRIMARY KEY,
  token_hash      TEXT NOT NULL,
  user_id         INTEGER NOT NULL,
  needs_2fa_setup INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  ip              TEXT NOT NULL DEFAULT '',
  user_agent      TEXT NOT NULL DEFAULT ''
)`
  },
  {
    name: "auth_challenges",
    ddl: `CREATE TABLE IF NOT EXISTS {table} (
  key        TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  purpose    TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)`
  },
  {
    name: "auth_counters",
    ddl: `CREATE TABLE IF NOT EXISTS {table} (
  key          TEXT PRIMARY KEY,
  action       TEXT NOT NULL,
  account      TEXT NOT NULL DEFAULT '',
  ip           TEXT NOT NULL DEFAULT '',
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  locked_until INTEGER,
  updated_at   INTEGER NOT NULL
)`
  },
  {
    name: "system_settings",
    ddl: `CREATE TABLE IF NOT EXISTS {table} (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`
  },
  {
    name: "spaces",
    ddl: `CREATE TABLE IF NOT EXISTS {table} (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
)`
  },
  {
    name: "space_members",
    ddl: `CREATE TABLE IF NOT EXISTS {table} (
  space_id   INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, user_id)
)`
  },
  {
    name: "pages",
    ddl: `CREATE TABLE IF NOT EXISTS {table} (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id     INTEGER NOT NULL DEFAULT 0,
  parent_id    INTEGER,
  title        TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  content_html TEXT NOT NULL DEFAULT '',
  content_text TEXT NOT NULL DEFAULT '',
  content_md   TEXT NOT NULL DEFAULT '',
  created_by   INTEGER NOT NULL,
  updated_by   INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
)`
  },
  {
    name: "page_revisions",
    ddl: `CREATE TABLE IF NOT EXISTS {table} (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id      INTEGER NOT NULL,
  version_no   INTEGER NOT NULL,
  title        TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  editor_id    INTEGER NOT NULL,
  created_at   TEXT NOT NULL
)`
  },
  {
    name: "comments",
    ddl: `CREATE TABLE IF NOT EXISTS {table} (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id    INTEGER NOT NULL,
  parent_id  INTEGER,
  author_id  INTEGER NOT NULL,
  body_md    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  edited_at  TEXT,
  deleted_at TEXT
)`
  },
  {
    name: "import_tokens",
    ddl: `CREATE TABLE IF NOT EXISTS {table} (
  user_id      INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
)`
  },
  {
    name: "read_tokens",
    ddl: `CREATE TABLE IF NOT EXISTS {table} (
  user_id      INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
)`
  },
  {
    name: "email_codes",
    ddl: `CREATE TABLE IF NOT EXISTS {table} (
  user_id    INTEGER NOT NULL,
  purpose    TEXT NOT NULL CHECK (purpose IN ('password_reset', '2fa_login', '2fa_enable', 'register_verify')),
  binding    TEXT NOT NULL DEFAULT '',
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, purpose, binding)
)`
  },
  {
    name: "r2_cleanup_runs",
    ddl: `CREATE TABLE IF NOT EXISTS {table} (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL DEFAULT 'images',
  started_at    TEXT NOT NULL,
  finished_at   TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  status        TEXT NOT NULL,
  dry_run       INTEGER NOT NULL DEFAULT 0,
  scanned       INTEGER NOT NULL DEFAULT 0,
  referenced    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0,
  young_skipped INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  truncated     INTEGER NOT NULL DEFAULT 0
)`
  },
  {
    name: "waker_executions",
    ddl: `CREATE TABLE IF NOT EXISTS {table} (
  execution_id   TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL,
  job_name       TEXT NOT NULL,
  scheduled_for  INTEGER NOT NULL,
  status         TEXT NOT NULL,
  response_json  TEXT,
  claimed_at     INTEGER NOT NULL,
  completed_at   INTEGER
)`
  },
  {
    name: "pages_fts",
    ddl: `CREATE VIRTUAL TABLE IF NOT EXISTS {table}
  USING fts5(page_id UNINDEXED, title, content_text)`
  }
]

/**
 * 索引（`{prefix}` 占位，表建好后建）。
 *
 * 唯一约束一律用唯一索引表达：部分唯一索引（`is_default`、`username` 空串除外）
 * SQLite 只在 CREATE INDEX 里支持带 WHERE，表内联 UNIQUE 做不到。
 */

/**
 * `users.username` 的唯一性最终防线（契约「username 有唯一索引、空串除外」）。
 *
 * 大小写不敏感（`COLLATE NOCASE`）：`alice` 与 `Alice` 视为重名——username 是
 * 唯一对外的用户身份，只差大小写的两个名字会在评论等处混淆。这条索引就在 `schema_v1`
 * 基线里（全新库一步建全），形态校验（`schema-shape.ts`）也按它比对：必须是
 * 「唯一 + 部分索引」。
 */
export const USERS_USERNAME_UNIQUE_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS {prefix}users_username
  ON {prefix}users(username COLLATE NOCASE) WHERE username <> ''`

export const SCHEMA_INDEXES: string[] = [
  USERS_USERNAME_UNIQUE_INDEX,
  `CREATE INDEX IF NOT EXISTS {prefix}passkey_credentials_user_id
    ON {prefix}passkey_credentials(user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS {prefix}passkey_credentials_credential_id
    ON {prefix}passkey_credentials(credential_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS {prefix}sessions_token_hash
    ON {prefix}sessions(token_hash)`,
  `CREATE INDEX IF NOT EXISTS {prefix}sessions_user_id
    ON {prefix}sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS {prefix}auth_challenges_expires_at
    ON {prefix}auth_challenges(expires_at)`,
  `CREATE INDEX IF NOT EXISTS {prefix}auth_counters_action_account
    ON {prefix}auth_counters(action, account)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS {prefix}spaces_slug
    ON {prefix}spaces(slug)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS {prefix}spaces_is_default
    ON {prefix}spaces(is_default) WHERE is_default = 1`,
  `CREATE INDEX IF NOT EXISTS {prefix}space_members_user_id
    ON {prefix}space_members(user_id)`,
  `CREATE INDEX IF NOT EXISTS {prefix}pages_parent_sort
    ON {prefix}pages(parent_id, sort_order)`,
  `CREATE INDEX IF NOT EXISTS {prefix}pages_deleted_at
    ON {prefix}pages(deleted_at)`,
  `CREATE INDEX IF NOT EXISTS {prefix}pages_updated_at
    ON {prefix}pages(updated_at)`,
  `CREATE INDEX IF NOT EXISTS {prefix}pages_space_parent_sort
    ON {prefix}pages(space_id, parent_id, sort_order)`,
  `CREATE INDEX IF NOT EXISTS {prefix}pages_space_deleted
    ON {prefix}pages(space_id, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS {prefix}pages_content_hash
    ON {prefix}pages(content_hash)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS {prefix}page_revisions_page_version
    ON {prefix}page_revisions(page_id, version_no)`,
  `CREATE INDEX IF NOT EXISTS {prefix}page_revisions_content_hash
    ON {prefix}page_revisions(content_hash)`,
  `CREATE INDEX IF NOT EXISTS {prefix}comments_page_created
    ON {prefix}comments(page_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS {prefix}comments_parent
    ON {prefix}comments(parent_id)`,
  `CREATE INDEX IF NOT EXISTS {prefix}comments_author
    ON {prefix}comments(author_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS {prefix}import_tokens_token_hash
    ON {prefix}import_tokens(token_hash)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS {prefix}read_tokens_token_hash
    ON {prefix}read_tokens(token_hash)`,
  `CREATE INDEX IF NOT EXISTS {prefix}email_codes_expires_at
    ON {prefix}email_codes(expires_at)`,
  `CREATE INDEX IF NOT EXISTS {prefix}r2_cleanup_runs_kind_started
    ON {prefix}r2_cleanup_runs(kind, started_at)`
]

/** 把 DDL 里的 `{table}` 换成实际表名。 */
export function withTable(ddl: string, table: string): string {
  return ddl.replaceAll("{table}", table)
}

/** 取某个逻辑表的 DDL（表名仍带 `{table}` 占位）。 */
export function tableDdl(name: string): string {
  const table = SCHEMA_TABLES.find((entry) => entry.name === name)
  if (!table) throw new Error(`Unknown schema table ${name}`)
  return table.ddl
}

/** 全新库需要的全部语句（表 + 索引），`;` 分隔、可直接交给迁移执行器。 */
export function baselineStatements(prefix: string): string[] {
  const statements = SCHEMA_TABLES.map((table) =>
    withTable(table.ddl, tableName(prefix, table.name))
  )
  for (const ddl of SCHEMA_INDEXES) {
    statements.push(ddl.replaceAll("{prefix}", prefix))
  }
  return statements
}
