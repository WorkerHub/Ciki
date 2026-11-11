/**
 * 「升级前」的库结构与存量数据夹具：当前生产形态（schema_v6 之后的结构）。
 *
 * 为什么单独成文件：结构坍缩后唯一支持的升级源就是这一形态——整数 id、正文在 R2、
 * `users` 仍带 base_currency/timezone/theme、`email_codes` 的 CHECK 还没有
 * `register_verify`。重建迁移的验收必须拿这个形态的真实库跑一遍。
 *
 * 只冻结「本次要改」的两张表（`users` 与 `email_codes`）；其余表结构与定版一致，
 * 直接复用 `schema.ts` 的 DDL，避免把 19 张表的 DDL 抄第二份。
 *
 * 数据刻意覆盖迁移的分支：
 * - 两个用户：`email_verified` 一个 1 一个 0（迁移后必须全是 1），`language` 一个 zh
 *   一个 en（必须逐值保真），三列里放非默认值（证明它们是被丢弃而不是被默认值覆盖）；
 * - 页面 3 张（含回收站页），版本 2 条，正文对象都真实写进内容桶；
 * - 账号体系一整套：会话、导入/只读令牌、通行密钥、TOTP、验证码、挑战；
 * - 计数、设置、清理日志、回调账本各一行（重建后必须原样在）。
 */
import type { Env } from "../../src/types"
import { putContent } from "../../src/core/content-store"
import { baselineStatements, withTable } from "../../src/lib/schema"
import { toIndexText } from "../../src/lib/fts"
import {
  emailCodesTable,
  migrationsTable,
  tableName,
  usersTable
} from "../../src/lib/tables"
import type { SqliteD1 } from "./sqlite-d1"

/** 升级前账本里已应用的迁移（坍缩前的历史，迁移后原样留着）。 */
export const V6_LEDGER_ROWS = [
  "schema_v1",
  "schema_v2",
  "schema_v3",
  "schema_v4",
  "schema_v5",
  "schema_v6"
]

/** 冻结的 v6 形态 `users`：比定版多 base_currency / timezone / theme 三列。 */
const V6_USERS_DDL = `CREATE TABLE {table} (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
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
  avatar_key     TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
)`

/** 冻结的 v6 形态 `email_codes`：purpose 的 CHECK 还没有 register_verify。 */
const V6_EMAIL_CODES_DDL = `CREATE TABLE {table} (
  user_id    INTEGER NOT NULL,
  purpose    TEXT NOT NULL CHECK (purpose IN ('password_reset', '2fa_login', '2fa_enable')),
  binding    TEXT NOT NULL DEFAULT '',
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, purpose, binding)
)`

/** 页面正文（内容桶里的对象就是这几份 JSON 的 UTF-8 字节）。 */
export const V6_HOME_JSON = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "首页正文" }] }
  ]
})
export const V6_CHILD_JSON = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "子页正文" }] }
  ]
})
export const V6_TRASHED_JSON = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "回收站页" }] }
  ]
})
export const V6_REVISION_ONE_JSON = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "第一版" }] }]
})
export const V6_REVISION_TWO_JSON = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "第二版" }] }]
})

/** 建出 v6 形态的库（含旧账本）。 */
export async function createV6Database(db: SqliteD1): Promise<void> {
  const prefix = "ciki_"
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${migrationsTable(prefix)} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))`
  )
  for (const statement of baselineStatements(prefix)) {
    await db.exec(statement)
  }

  // 把两张「本次要改」的表换成升级前形态（其余表与定版一致）。
  await db.exec(`DROP TABLE ${usersTable(prefix)}`)
  await db.exec(withTable(V6_USERS_DDL, usersTable(prefix)))
  await db.exec(`DROP TABLE ${emailCodesTable(prefix)}`)
  await db.exec(withTable(V6_EMAIL_CODES_DDL, emailCodesTable(prefix)))
  await db.exec(
    `CREATE INDEX IF NOT EXISTS ${prefix}email_codes_expires_at ON ${emailCodesTable(prefix)}(expires_at)`
  )

  for (const name of V6_LEDGER_ROWS) {
    await db.db
      .prepare(
        `INSERT INTO ${migrationsTable(prefix)} (name, applied_at) VALUES (?, 1)`
      )
      .run(name)
  }
}

export interface V6Seed {
  /** 会话 token 的哈希（断言会话行原样保留）。 */
  sessionTokenHash: string
  /** 每张页面/版本正文的内容哈希（断言指针不变、对象可回读）。 */
  hashes: {
    home: string
    child: string
    trashed: string
    revisionOne: string
    revisionTwo: string
  }
}

/** 往 v6 形态的库里灌存量数据（时间戳固定）。 */
export async function seedV6Database(
  ctx: { db: SqliteD1; env: Env },
  totpSecretCiphertext: string
): Promise<V6Seed> {
  const { db, env } = ctx
  const prefix = "ciki_"
  const now = "2026-05-01T00:00:00.000Z"
  const table = (logical: string) => tableName(prefix, logical)

  await db.db
    .prepare(
      `INSERT INTO ${table("users")}
        (id, email, password_hash, role, is_active, approval_status, email_verified,
         base_currency, timezone, language, theme, username, avatar_key, created_at, updated_at)
       VALUES (1, 'admin@example.com', 'hash-1', 'admin', 1, 'approved', 1,
               'USD', 'Asia/Tokyo', 'zh', 'dark', 'admin', 'avatars/old.png',
               '2026-01-01T00:00:00.000Z', ?)`
    )
    .run(now)
  await db.db
    .prepare(
      `INSERT INTO ${table("users")}
        (id, email, password_hash, role, is_active, approval_status, email_verified,
         base_currency, timezone, language, theme, username, avatar_key, created_at, updated_at)
       VALUES (2, 'editor@example.com', 'hash-2', 'user', 1, 'approved', 0,
               'EUR', 'Europe/Berlin', 'en', 'system', 'editor', '',
               '2026-01-02T00:00:00.000Z', ?)`
    )
    .run(now)

  await db.db
    .prepare(
      `INSERT INTO ${table("spaces")} (id, slug, name, description, is_default, created_by, created_at, updated_at)
       VALUES (1, 'space-1', '默认空间', '', 1, 1, '2026-01-01T00:00:00.000Z', ?),
              (2, 'space-2', '第二个空间', '说明', 0, 1, '2026-01-03T00:00:00.000Z', ?)`
    )
    .run(now, now)

  await db.db
    .prepare(
      `INSERT INTO ${table("space_members")} (space_id, user_id, role, created_at)
       VALUES (1, 1, 'admin', ?), (1, 2, 'editor', ?), (2, 1, 'admin', ?)`
    )
    .run(now, now, now)

  await db.db
    .prepare(
      `INSERT INTO ${table("user_2fa")} (user_id, totp_secret, totp_enabled, email_otp_enabled, updated_at)
       VALUES (1, ?, 1, 0, ?)`
    )
    .run(totpSecretCiphertext, now)

  await db.db
    .prepare(
      `INSERT INTO ${table("passkey_credentials")}
        (id, user_id, credential_id, public_key, counter, transports, created_at)
       VALUES (1, 1, 'cred-1', 'pk-1', 7, 'internal', ?)`
    )
    .run(now)

  const sessionTokenHash = "a".repeat(64)
  await db.db
    .prepare(
      `INSERT INTO ${table("sessions")}
        (id, token_hash, user_id, needs_2fa_setup, created_at, last_seen_at, expires_at, ip, user_agent)
       VALUES ('sess-1', ?, 1, 0, 1, 1, 9999999999, '203.0.113.9', 'ua')`
    )
    .run(sessionTokenHash)

  await db.db
    .prepare(
      `INSERT INTO ${table("import_tokens")} (user_id, token_hash, created_at)
       VALUES (1, 'import-hash', ?)`
    )
    .run(now)
  await db.db
    .prepare(
      `INSERT INTO ${table("read_tokens")} (user_id, token_hash, created_at)
       VALUES (2, 'read-hash', ?)`
    )
    .run(now)

  // 旧 CHECK 允许的既有用途：重建后这张表换新 CHECK，行本身必须原样留下。
  await db.db
    .prepare(
      `INSERT INTO ${table("email_codes")}
        (user_id, purpose, binding, code_hash, attempts, created_at, expires_at)
       VALUES (1, '2fa_enable', '', 'code-hash', 2, 1, 9999999999)`
    )
    .run()

  await db.db
    .prepare(
      `INSERT INTO ${table("auth_challenges")} (key, user_id, purpose, payload, expires_at, created_at)
       VALUES ('challenge-1', 1, 'totp_setup', 'secret', 9999999999, 1)`
    )
    .run()

  await db.db
    .prepare(
      `INSERT INTO ${table("auth_counters")} (key, action, account, ip, count, window_start, updated_at)
       VALUES ('register:::203.0.113.9', 'register', '', '203.0.113.9', 2, 1, 1)`
    )
    .run()

  await db.db
    .prepare(
      `INSERT INTO ${table("system_settings")} (key, value, updated_at)
       VALUES ('site_name', 'Ciki', ?)`
    )
    .run(now)

  const hashes = {
    home: await putContent(env, V6_HOME_JSON),
    child: await putContent(env, V6_CHILD_JSON),
    trashed: await putContent(env, V6_TRASHED_JSON),
    revisionOne: await putContent(env, V6_REVISION_ONE_JSON),
    revisionTwo: await putContent(env, V6_REVISION_TWO_JSON)
  }

  const insertPage = db.db.prepare(
    `INSERT INTO ${table("pages")}
      (id, space_id, parent_id, title, sort_order, content_hash, content_html,
       content_text, content_md, created_by, updated_by, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  insertPage.run(
    1,
    1,
    null,
    "首页",
    hashes.home,
    "<p>首页正文</p>",
    "首页正文",
    "首页正文",
    1,
    1,
    "2026-01-01T00:00:00.000Z",
    now,
    null
  )
  insertPage.run(
    2,
    1,
    1,
    "子页",
    hashes.child,
    "<p>子页正文</p>",
    "子页正文",
    "子页正文",
    2,
    2,
    "2026-01-02T00:00:00.000Z",
    now,
    null
  )
  insertPage.run(
    3,
    1,
    null,
    "回收站页",
    hashes.trashed,
    "<p>回收站页</p>",
    "回收站页",
    "回收站页",
    1,
    1,
    "2026-01-03T00:00:00.000Z",
    now,
    "2026-02-01T00:00:00.000Z"
  )

  await db.db
    .prepare(
      `INSERT INTO ${table("page_revisions")}
        (id, page_id, version_no, title, content_hash, editor_id, created_at)
       VALUES (1, 1, 1, '首页', ?, 1, '2026-01-01T10:00:00.000Z'),
              (2, 1, 2, '首页', ?, 1, '2026-01-01T11:00:00.000Z')`
    )
    .run(hashes.revisionOne, hashes.revisionTwo)

  const insertFts = db.db.prepare(
    `INSERT INTO ${table("pages_fts")} (page_id, title, content_text) VALUES (?, ?, ?)`
  )
  insertFts.run(1, toIndexText("首页"), toIndexText("首页正文"))
  insertFts.run(2, toIndexText("子页"), toIndexText("子页正文"))

  await db.db
    .prepare(
      `INSERT INTO ${table("comments")}
        (id, page_id, parent_id, author_id, body_md, created_at)
       VALUES (1, 1, NULL, 1, '顶层评论', '2026-01-01T12:00:00.000Z'),
              (2, 1, 1, 2, '回复', '2026-01-01T13:00:00.000Z')`
    )
    .run()

  await db.db
    .prepare(
      `INSERT INTO ${table("r2_cleanup_runs")}
        (kind, started_at, finished_at, trigger, status, dry_run, scanned, referenced,
         deleted, young_skipped, failed, truncated)
       VALUES ('images', ?, ?, 'manual', 'ok', 1, 3, 2, 0, 1, 0, 0)`
    )
    .run(now, now)

  await db.db
    .prepare(
      `INSERT INTO ${table("waker_executions")}
        (execution_id, job_id, job_name, scheduled_for, status, claimed_at)
       VALUES ('exec-1', 'job-1', 'monthly', 1, 'done', 1)`
    )
    .run()

  return { sessionTokenHash, hashes }
}
