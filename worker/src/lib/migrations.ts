/**
 * 数据库结构的唯一真源：一个初始化版本，今后的改动只在末尾追加。
 *
 * 规则：
 * - `schema_v1` 是全新库的唯一初始化迁移：一次建出全部表/索引，并播种默认空间。
 *   Ciki 没有要保留的存量库，因此不提供 v1→v5 那样的逐版本升级路径。
 * - 今后的结构变化只在末尾追加 `schema_v2`、`schema_v3`…，已合并的迁移不得改名、
 *   改内容或调序。
 * - 迁移必须可重复执行：`CREATE … IF NOT EXISTS`、`ADD COLUMN`、`INSERT OR IGNORE`；
 *   不做 DROP / RENAME / 数据重写。
 * - 语句之间用 `;` 分隔，语句内部不得出现 `;`（含字符串字面量）：执行器按 `;`
 *   切分后逐条执行。
 * - 表名/索引名一律经 src/lib/tables.ts 拼装，本文件只写 `{prefix}` 占位。
 * - SQLite 缺 `ADD COLUMN IF NOT EXISTS` 之类的能力时，可在 `prepare` 里做结构补齐
 *   与数据回填：它先于 sql 执行、只允许补新列里仍为空的值，不得覆盖既有数据，
 *   同样必须可重复执行（`schema_v2` 的 `user_2fa.email_otp_enabled` 就是这么补的）。
 */
import {
  challengesTable,
  countersTable,
  emailCodesTable,
  importTokensTable,
  pagesFtsTable,
  pagesTable,
  passkeysTable,
  r2CleanupRunsTable,
  revisionsTable,
  sessionsTable,
  settingsTable,
  spaceMembersTable,
  spacesTable,
  user2faTable,
  usersTable,
  wakerExecutionsTable
} from "./tables"

export interface Migration {
  name: string
  sql: string
  /** 在 sql 之前执行的幂等补齐（加列、回填），见文件头注释。 */
  prepare?: (db: D1Database, prefix: string) => Promise<void>
}

/** 默认空间的固定 id：初始化迁移建它、导入缺省落它、删除守卫保护它。 */
export const DEFAULT_SPACE_ID = "space-default"

export const DEFAULT_SPACE_NAME = "默认空间"

/**
 * auth_counters 的建表语句（D1 计数表是限流的唯一权威）。setup 限流器会在迁移
 * 之前用同一份 DDL 先建表，所以这里导出模板、两处共用，避免结构漂移。
 */
export const AUTH_COUNTERS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS {prefix}auth_counters (
  key          TEXT PRIMARY KEY,
  action       TEXT NOT NULL,
  account      TEXT NOT NULL DEFAULT '',
  ip           TEXT NOT NULL DEFAULT '',
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  locked_until INTEGER,
  updated_at   INTEGER NOT NULL
)`

export const AUTH_COUNTERS_INDEX_DDL = `CREATE INDEX IF NOT EXISTS {prefix}auth_counters_action_account
  ON {prefix}auth_counters(action, account)`

/**
 * schema_v1 — 全新库的全部结构 + 默认空间播种。
 *
 * 鉴权部分按 eNotify 移植（users / user_2fa 的密码哈希与 TOTP 存储口径），
 * 但会话改为不透明令牌 + SHA-256 落库、passkey 凭证独立成表、一次性挑战与
 * 限流计数落 D1（仓库没有 KV 绑定，规格补遗定版）。
 *
 * 身份三列（username / public_id / avatar_key）与页面所属空间（pages.space_id）
 * 直接声明在 CREATE 里——全新库没有需要 ALTER 补列的旧表。默认空间的 id/名称由
 * DEFAULT_SPACE_ID / DEFAULT_SPACE_NAME 插值，避免与导入、删除守卫里的常量漂移。
 */
const SCHEMA_V1 = `CREATE TABLE IF NOT EXISTS {prefix}users (
  id             TEXT PRIMARY KEY,
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'user',
  is_active      INTEGER NOT NULL DEFAULT 1,
  approval_status TEXT NOT NULL DEFAULT 'approved',
  email_verified INTEGER NOT NULL DEFAULT 0,
  base_currency  TEXT NOT NULL DEFAULT 'CNY',
  timezone       TEXT NOT NULL DEFAULT 'UTC',
  language       TEXT NOT NULL DEFAULT 'zh',
  theme          TEXT NOT NULL DEFAULT 'system',
  username       TEXT NOT NULL DEFAULT '',
  public_id      TEXT NOT NULL DEFAULT '',
  avatar_key     TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS {prefix}user_2fa (
  user_id      TEXT PRIMARY KEY,
  totp_secret  TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS {prefix}passkey_credentials (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);

CREATE INDEX IF NOT EXISTS {prefix}passkey_credentials_user_id
  ON {prefix}passkey_credentials(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS {prefix}passkey_credentials_credential_id
  ON {prefix}passkey_credentials(credential_id);

CREATE TABLE IF NOT EXISTS {prefix}sessions (
  id              TEXT PRIMARY KEY,
  token_hash      TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  needs_2fa_setup INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  ip              TEXT NOT NULL DEFAULT '',
  user_agent      TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS {prefix}sessions_token_hash
  ON {prefix}sessions(token_hash);
CREATE INDEX IF NOT EXISTS {prefix}sessions_user_id
  ON {prefix}sessions(user_id);

CREATE TABLE IF NOT EXISTS {prefix}auth_challenges (
  key        TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS {prefix}auth_challenges_expires_at
  ON {prefix}auth_challenges(expires_at);

${AUTH_COUNTERS_TABLE_DDL};

${AUTH_COUNTERS_INDEX_DDL};

CREATE TABLE IF NOT EXISTS {prefix}system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS {prefix}pages (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL DEFAULT '',
  parent_id    TEXT,
  title        TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  content_json TEXT NOT NULL DEFAULT '',
  content_html TEXT NOT NULL DEFAULT '',
  content_text TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS {prefix}pages_parent_sort
  ON {prefix}pages(parent_id, sort_order);
CREATE INDEX IF NOT EXISTS {prefix}pages_deleted_at
  ON {prefix}pages(deleted_at);
CREATE INDEX IF NOT EXISTS {prefix}pages_updated_at
  ON {prefix}pages(updated_at);
CREATE INDEX IF NOT EXISTS {prefix}pages_space_parent_sort
  ON {prefix}pages(space_id, parent_id, sort_order);
CREATE INDEX IF NOT EXISTS {prefix}pages_space_deleted
  ON {prefix}pages(space_id, deleted_at);

CREATE TABLE IF NOT EXISTS {prefix}page_revisions (
  id           TEXT PRIMARY KEY,
  page_id      TEXT NOT NULL,
  title        TEXT NOT NULL,
  content_json TEXT NOT NULL,
  content_html TEXT NOT NULL,
  content_text TEXT NOT NULL,
  editor_id    TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS {prefix}page_revisions_page_created
  ON {prefix}page_revisions(page_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS {prefix}pages_fts
  USING fts5(page_id UNINDEXED, title, content_text);

CREATE TABLE IF NOT EXISTS {prefix}import_tokens (
  user_id      TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS {prefix}import_tokens_token_hash
  ON {prefix}import_tokens(token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS {prefix}users_public_id
  ON {prefix}users(public_id) WHERE public_id <> '';

CREATE TABLE IF NOT EXISTS {prefix}spaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS {prefix}spaces_is_default
  ON {prefix}spaces(is_default) WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS {prefix}space_members (
  space_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, user_id)
);

CREATE INDEX IF NOT EXISTS {prefix}space_members_user_id
  ON {prefix}space_members(user_id);

INSERT OR IGNORE INTO {prefix}spaces
  (id, name, description, is_default, created_by, created_at, updated_at)
VALUES ('${DEFAULT_SPACE_ID}', '${DEFAULT_SPACE_NAME}', '', 1,
  COALESCE((SELECT id FROM {prefix}users
             WHERE role = 'admin' ORDER BY rowid LIMIT 1), ''),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

UPDATE {prefix}pages SET space_id = COALESCE(
  (SELECT id FROM {prefix}spaces WHERE is_default = 1 LIMIT 1),
  '${DEFAULT_SPACE_ID}')
  WHERE space_id IS NULL OR space_id = '';

INSERT OR IGNORE INTO {prefix}space_members
  (space_id, user_id, role, created_at)
SELECT COALESCE((SELECT id FROM {prefix}spaces WHERE is_default = 1 LIMIT 1),
                '${DEFAULT_SPACE_ID}'),
       id,
       CASE WHEN role = 'admin' THEN 'admin' ELSE 'editor' END,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM {prefix}users;

CREATE TABLE IF NOT EXISTS {prefix}r2_cleanup_runs (
  id            TEXT PRIMARY KEY,
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
);

CREATE INDEX IF NOT EXISTS {prefix}r2_cleanup_runs_started_at
  ON {prefix}r2_cleanup_runs(started_at);

CREATE TABLE IF NOT EXISTS {prefix}waker_executions (
  execution_id   TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL,
  job_name       TEXT NOT NULL,
  scheduled_for  INTEGER NOT NULL,
  status         TEXT NOT NULL,
  response_json  TEXT,
  claimed_at     INTEGER NOT NULL,
  completed_at   INTEGER
)`

/** 把迁移里的 `{prefix}` 替换成生效前缀。 */
function render(sql: string, prefix: string): string {
  return sql.replaceAll("{prefix}", prefix)
}

/**
 * schema_v2 — 邮箱验证码（#48 契约第 5 条）。
 *
 * 新建 `email_codes` 专表：一个 `(user_id, purpose, binding)` 只保留最新一枚码
 * （重发 UPSERT 覆盖），`attempts` 由 SQL 原子自增，成功校验用 DELETE 原子消费。
 * `user_2fa.email_otp_enabled` 不在 SQL 里补——SQLite 没有
 * `ADD COLUMN IF NOT EXISTS`，放在 `prepare` 里按 PRAGMA 判断后补。
 */
const SCHEMA_V2 = `CREATE TABLE IF NOT EXISTS {prefix}email_codes (
  user_id    TEXT NOT NULL,
  purpose    TEXT NOT NULL CHECK (purpose IN ('password_reset', '2fa_login', '2fa_enable')),
  binding    TEXT NOT NULL DEFAULT '',
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, purpose, binding)
);

CREATE INDEX IF NOT EXISTS {prefix}email_codes_expires_at
  ON {prefix}email_codes(expires_at)`

/**
 * schema_v2 的结构补齐：`user_2fa` 加邮箱验证码开关列。
 *
 * 幂等：列已存在（或在同一轮里已被补过）直接返回；表不存在时跳过——正常情况下
 * `schema_v1` 已在同一轮里先建出 `user_2fa`，这里只防御“只跑过部分迁移”的库。
 */
async function prepareSchemaV2(db: D1Database, prefix: string): Promise<void> {
  const table = user2faTable(prefix)
  const columns = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>()
  if (columns.results.length === 0) return
  if (columns.results.some((column) => column.name === "email_otp_enabled")) {
    return
  }
  await db
    .prepare(
      `ALTER TABLE ${table} ADD COLUMN email_otp_enabled INTEGER NOT NULL DEFAULT 0`
    )
    .run()
}

export function getMigrations(prefix: string): Migration[] {
  // 说明：表名统一由 tables.ts 的 helper 提供；这里只做前缀替换，
  // 并断言 helper 与迁移 SQL 用的是同一套名字（改一处就会在这里暴露）。
  const sql = render(SCHEMA_V1, prefix)
  const expected = [
    usersTable(prefix),
    user2faTable(prefix),
    passkeysTable(prefix),
    sessionsTable(prefix),
    challengesTable(prefix),
    countersTable(prefix),
    settingsTable(prefix),
    pagesTable(prefix),
    revisionsTable(prefix),
    pagesFtsTable(prefix),
    importTokensTable(prefix),
    spacesTable(prefix),
    spaceMembersTable(prefix),
    r2CleanupRunsTable(prefix),
    wakerExecutionsTable(prefix)
  ]
  for (const name of expected) {
    if (!sql.includes(name)) {
      throw new Error(`migration schema_v1 is missing table ${name}`)
    }
  }

  const sqlV2 = render(SCHEMA_V2, prefix)
  if (!sqlV2.includes(emailCodesTable(prefix))) {
    throw new Error(
      `migration schema_v2 is missing table ${emailCodesTable(prefix)}`
    )
  }

  return [
    { name: "schema_v1", sql },
    { name: "schema_v2", sql: sqlV2, prepare: prepareSchemaV2 }
  ]
}
