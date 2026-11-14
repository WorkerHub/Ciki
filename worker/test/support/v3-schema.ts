/**
 * 「升级前」的库夹具：最终令牌形态（= 今日 `schema_v1` 基线结构）＋ 坍缩前留下的
 * 账本，用来演练「坍缩为单条 schema_v1」这一步账本手术。
 *
 * 生产库的唯一形态就是它：表/索引与基线逐项一致（全部经 `schema.ts` 的
 * `baselineStatements` 建出，不多不少），账本里是 `schema_v1`–`schema_v3` 三行
 * ——旧版增量链一路升上来的库都带着这些历史行，所以升级必须把同名旧行也一并清掉。
 *
 * 冻结的只有「账本行」这一份历史事实；结构直接复用 `schema.ts`（基线已冻结，
 * v3 与 v1 结构相同是本单的前提），不把表 DDL 抄第二份。
 *
 * 数据覆盖升级路径要保住的东西：真实密码（升级后还能登录）、既有会话、两个空间、
 * 正常页 + 子页 + 回收站页、两版本、真实写进内容桶的正文对象、FTS 行、评论、令牌、
 * 验证码与站点设置（`runSetup` 末尾的 `INSERT OR IGNORE` 因此才是空转）。
 */
import { hashPassword, randomToken, sha256Hex } from "../../src/core/auth"
import { putContent } from "../../src/core/content-store"
import { toIndexText } from "../../src/lib/fts"
import { SCHEMA_INDEXES, SCHEMA_TABLES, withTable } from "../../src/lib/schema"
import { DEFAULT_SETTINGS } from "../../src/lib/setup"
import { migrationsTable, tableName } from "../../src/lib/tables"
import type { TestContext } from "./app"
import type { SqliteD1 } from "./sqlite-d1"

/** 夹具用户的明文密码（升级后用它登录，证明库里的哈希还能用）。 */
export const V3_PASSWORD = "Test-Password-123"

/** 可回放明文令牌（升级后拿它调接口，证明令牌仍可鉴权）。 */
export const V3_READ_TOKEN = "collapse-read-token"
export const V3_WRITE_TOKEN = "collapse-write-token"
export const V3_IMPORT_TOKEN = "collapse-import-token"

/** 生产账本的样子：坍缩前 v1–v3 全部应用过，旧行都还在。 */
export const V3_LEDGER_ROWS = ["schema_v1", "schema_v2", "schema_v3"] as const

/** 停在 v2 的账本（有 v2、无 v3）：本版必须拒绝并指路。 */
export const V2_LEDGER_ROWS = V3_LEDGER_ROWS.slice(0, 2)

/** 页面正文（内容桶里的对象就是这几份 JSON 的 UTF-8 字节）。 */
export const V3_HOME_JSON = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "首页正文" }] }
  ]
})
export const V3_CHILD_JSON = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "子页正文" }] }
  ]
})
export const V3_TRASHED_JSON = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "回收站页" }] }
  ]
})
export const V3_REVISION_ONE_JSON = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "首页第一版" }] }
  ]
})

export interface V3Seed {
  /** 升级前就存在、且仍然有效的会话令牌（证明会话与用户没有被改动）。 */
  sessionToken: string
  hashes: {
    home: string
    child: string
    trashed: string
    revisionOne: string
  }
}

/**
 * 建出最终令牌形态的库与账本（不含业务数据）。
 *
 * 建表方式刻意照抄旧版存量的重建：先按定版 DDL 建 `v7_*` 临时表、
 * `ALTER TABLE … RENAME TO …` 改名成正式表，最后才建索引与 `v7_*` 临时表。
 * 生产库就是这么来的，所以 `sqlite_master.sql` 里的表名与今天的 DDL 文本并不逐字相同
 * ——形态校验只读系统表、不比文本，这里正好把它钉住。
 */
export async function createV3Database(
  ctx: TestContext,
  ledger: readonly string[] = V3_LEDGER_ROWS
): Promise<void> {
  const prefix = "ciki_"
  const temp = (name: string) => tableName(prefix, `v7_${name}`)
  for (const table of SCHEMA_TABLES) {
    await ctx.db.exec(withTable(table.ddl, temp(table.name)))
  }
  for (const table of SCHEMA_TABLES) {
    await ctx.db.exec(
      `ALTER TABLE ${temp(table.name)} RENAME TO ${tableName(prefix, table.name)}`
    )
  }
  for (const ddl of SCHEMA_INDEXES) {
    await ctx.db.exec(ddl.replaceAll("{prefix}", prefix))
  }
  await ctx.db.exec(
    `CREATE TABLE ${migrationsTable(prefix)} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))`
  )
  for (const name of ledger) {
    await ctx.db.db
      .prepare(`INSERT INTO ${migrationsTable(prefix)} (name) VALUES (?)`)
      .run(name)
  }
}

/** 灌入存量数据（账号、空间、页面与正文对象、评论、令牌、设置）。 */
export async function seedV3Database(ctx: TestContext): Promise<V3Seed> {
  const { env, db } = ctx
  const prefix = "ciki_"
  const table = (name: string) => tableName(prefix, name)
  const now = "2026-03-01T00:00:00.000Z"
  const passwordHash = await hashPassword(V3_PASSWORD)

  await db.db
    .prepare(
      `INSERT INTO ${table("users")}
        (id, email, password_hash, role, is_active, approval_status, email_verified,
         language, username, avatar_key, created_at, updated_at)
       VALUES (1, 'admin@example.com', ?, 'admin', 1, 'approved', 1, 'zh', 'admin', 'avatars/a.png', '2026-01-01T00:00:00.000Z', ?),
              (2, 'editor@example.com', ?, 'user', 1, 'approved', 1, 'en', 'editor', '', '2026-01-02T00:00:00.000Z', ?)`
    )
    .run(passwordHash, now, passwordHash, now)

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

  // 令牌最终形态：只读（用户 2）+ 读写（用户 1），范围各一份；导入令牌多行。
  await db.db
    .prepare(
      `INSERT INTO ${table("api_tokens")}
        (user_id, kind, name, token_hash, created_at, last_used_at, revoked_at)
       VALUES (2, 'read', '只读 Token', ?, ?, NULL, NULL),
              (1, 'write', '读写 Token', ?, ?, NULL, NULL)`
    )
    .run(
      await sha256Hex(V3_READ_TOKEN),
      now,
      await sha256Hex(V3_WRITE_TOKEN),
      now
    )

  const readRow = db.db
    .prepare(`SELECT id FROM ${table("api_tokens")} WHERE kind = 'read'`)
    .get() as { id: number }
  const writeRow = db.db
    .prepare(`SELECT id FROM ${table("api_tokens")} WHERE kind = 'write'`)
    .get() as { id: number }
  await db.db
    .prepare(
      `INSERT INTO ${table("token_space_scopes")} (token_id, space_id) VALUES (?, 1), (?, 2)`
    )
    .run(readRow.id, writeRow.id)

  await db.db
    .prepare(
      `INSERT INTO ${table("import_tokens")}
        (user_id, name, token_hash, created_at, last_used_at, revoked_at)
       VALUES (1, '浏览器插件', ?, ?, NULL, NULL)`
    )
    .run(await sha256Hex(V3_IMPORT_TOKEN), now)

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

  const insertSetting = db.db.prepare(
    `INSERT INTO ${table("system_settings")} (key, value, updated_at) VALUES (?, ?, ?)`
  )
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insertSetting.run(key, value, now)
  }
  insertSetting.run(
    "smtp_config",
    JSON.stringify({ host: "smtp.example.com" }),
    now
  )

  // 升级前就存在的会话：升级后仍然有效（会话表与用户未被改动）。
  const sessionToken = randomToken()
  await db.db
    .prepare(
      `INSERT INTO ${table("sessions")}
        (id, token_hash, user_id, needs_2fa_setup, created_at, last_seen_at, expires_at, ip, user_agent)
       VALUES ('sess-1', ?, 1, 0, 1, 1, 9999999999, '203.0.113.9', 'ua')`
    )
    .run(await sha256Hex(sessionToken))

  const hashes = {
    home: await putContent(env, V3_HOME_JSON),
    child: await putContent(env, V3_CHILD_JSON),
    trashed: await putContent(env, V3_TRASHED_JSON),
    revisionOne: await putContent(env, V3_REVISION_ONE_JSON)
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
    2,
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
    .run(hashes.revisionOne, hashes.home)

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

  return { sessionToken, hashes }
}

/** 表里的全部行（升级前后逐表比对用；调用方自己排除账本表）。 */
export function rowsOf(db: SqliteD1, table: string): unknown[] {
  return db.db.prepare(`SELECT * FROM ${table}`).all()
}
