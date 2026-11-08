/**
 * 数据库结构的唯一真源：有序迁移列表。
 *
 * 规则（移植 eNotify 的账本迁移做法）：
 * - 只允许在末尾追加 `schema_vN`，已合并的迁移不得改名、改内容或调序。
 * - 迁移必须可重复执行：`CREATE … IF NOT EXISTS`、`ADD COLUMN`、`INSERT OR IGNORE`；
 *   不做 DROP / RENAME / 数据重写。
 * - 迁移 SQL 字符串里不得出现 `;`：执行器按 `;` 切分后逐条执行。
 * - 表名/索引名一律经 src/lib/tables.ts 拼装，本文件只写 `{prefix}` 占位。
 * - SQLite 缺 `ADD COLUMN IF NOT EXISTS` 之类的能力时，可在 `prepare` 里做结构补齐
 *   与数据回填：它先于 sql 执行、只允许补新列里仍为空的值，不得覆盖既有数据，
 *   同样必须可重复执行。
 */
import { prepareIdentitySchema } from "./identity-schema"
import {
  importTokensTable,
  pagesFtsTable,
  pagesTable,
  r2CleanupRunsTable,
  spaceMembersTable,
  spacesTable,
  tableName,
  wakerExecutionsTable
} from "./tables"
import { prepareSpaceSchema, spaceSchemaStatements } from "./space-schema"

export interface Migration {
  name: string
  sql: string
  /** 在 sql 之前执行的幂等补齐（加列、回填），见文件头注释。 */
  prepare?: (db: D1Database, prefix: string) => Promise<void>
}

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
 * schema_v1 — ciki 的全部表。
 *
 * 鉴权部分按 eNotify 移植（users / user_2fa 的密码哈希与 TOTP 存储口径），
 * 但会话改为不透明令牌 + SHA-256 落库、passkey 凭证独立成表、一次性挑战与
 * 限流计数落 D1（仓库没有 KV 绑定，规格补遗定版）。
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
  USING fts5(page_id UNINDEXED, title, content_text)`

/**
 * schema_v2 — 个人导入令牌（规格 §12.1）。
 *
 * 每用户一行（user_id 主键，生成/重置即覆盖），只存令牌的 SHA-256；
 * `revoked_at` 非空即吊销，校验时回表连 users 一起查（停用/未批准立即失效）。
 * 不设过期列：失效只走吊销 / 重置 / 用户停用，避免“到期需重新生成”的隐性状态。
 */
const SCHEMA_V2 = `CREATE TABLE IF NOT EXISTS {prefix}import_tokens (
  user_id      TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS {prefix}import_tokens_token_hash
  ON {prefix}import_tokens(token_hash)`

/**
 * schema_v3 — 身份模型（规格「Ciki UI/身份优化批」）。
 *
 * users 加 username（显示名，可改、不唯一）/ public_id（8 位系统生成、唯一、不可改）/
 * avatar_key（头像在 R2 的 key）；存量行的回填在 prepareIdentitySchema 里，只写
 * 新列的空值。public_id 用部分唯一索引：未回填的空串不参与唯一性，回填完成后
 * 由数据库兜底并发建号的撞键。
 */
const SCHEMA_V3 = `CREATE UNIQUE INDEX IF NOT EXISTS {prefix}users_public_id
  ON {prefix}users(public_id) WHERE public_id <> ''`

/**
 * schema_v5 — 月度 R2 孤儿清理（规格 §3）与 waker 回调账本。
 *
 * - `r2_cleanup_runs`：每轮一行。为了「最近一轮」与 20 天幂等兜底可直接查，
 *   计数列全部 NOT NULL DEFAULT 0；`dry_run=1` 的行不代表线上真删过。
 * - `waker_executions`：waker 客户端 SDK 的 executionId 幂等账本
 *   （列照 SDK 的 `executionLedgerDdl()`，表名经 tables.ts 的 helper）。
 *
 * 与既有迁移一样：只追加、可重复执行（IF NOT EXISTS），语句之间用 `;` 分隔。
 */
const SCHEMA_V5 = `CREATE TABLE IF NOT EXISTS {prefix}r2_cleanup_runs (
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

export function getMigrations(prefix: string): Migration[] {
  // 说明：表名统一由 tables.ts 的 helper 提供；这里只做前缀替换，
  // 并断言 helper 与迁移 SQL 用的是同一套名字（改一处就会在这里暴露）。
  const expected = [
    pagesTable(prefix),
    pagesFtsTable(prefix),
    tableName(prefix, "users")
  ]
  const sql = render(SCHEMA_V1, prefix)
  for (const name of expected) {
    if (!sql.includes(name)) {
      throw new Error(`migration schema_v1 is missing table ${name}`)
    }
  }

  const sqlV2 = render(SCHEMA_V2, prefix)
  if (!sqlV2.includes(importTokensTable(prefix))) {
    throw new Error(
      `migration schema_v2 is missing table ${importTokensTable(prefix)}`
    )
  }

  const sqlV3 = render(SCHEMA_V3, prefix)
  if (!sqlV3.includes(tableName(prefix, "users"))) {
    throw new Error(
      `migration schema_v3 is missing table ${tableName(prefix, "users")}`
    )
  }

  // schema_v4 的正文与 prepare 共用 space-schema.ts 的 DDL 常量（单一真源）。
  const sqlV4 = spaceSchemaStatements(prefix).join(";\n")
  for (const name of [
    spacesTable(prefix),
    spaceMembersTable(prefix),
    pagesTable(prefix)
  ]) {
    if (!sqlV4.includes(name)) {
      throw new Error(`migration schema_v4 is missing table ${name}`)
    }
  }

  const sqlV5 = render(SCHEMA_V5, prefix)
  for (const name of [
    r2CleanupRunsTable(prefix),
    wakerExecutionsTable(prefix)
  ]) {
    if (!sqlV5.includes(name)) {
      throw new Error(`migration schema_v5 is missing table ${name}`)
    }
  }
  return [
    { name: "schema_v1", sql },
    { name: "schema_v2", sql: sqlV2 },
    { name: "schema_v3", sql: sqlV3, prepare: prepareIdentitySchema },
    { name: "schema_v4", sql: sqlV4, prepare: prepareSpaceSchema },
    { name: "schema_v5", sql: sqlV5 }
  ]
}
