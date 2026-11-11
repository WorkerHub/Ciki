/**
 * 「升级前」的库结构与存量数据夹具（只给一次性重建迁移的演练测试用）。
 *
 * 为什么要把旧 DDL 抄进测试：`src/lib/migrations.ts` 的 `schema_v1` 已经被改写为
 * 新基线，仓库里不再有「旧结构」的生成器；而重建迁移的验收恰恰是「拿真实旧库跑一遍」。
 * 这份 DDL 是升级前最后一版结构（schema_v5 收尾时点）的冻结快照，**不得随代码演进
 * 修改**——它代表线上存量库，改了就等于改测试的输入。
 *
 * 数据刻意覆盖迁移的每个分支：
 * - 用户 2 个（含 TOTP、通行密钥、会话、导入/只读令牌、头像 key）；
 * - 空间 2 个（默认空间 + 另一个），成员关系各一；
 * - 页面 4 个：父页 + 子页（正文里有 `/p/<uuid>` 站内链接与 `/api/files/` 图片）、
 *   回收站页、另一空间的页；
 * - 版本 3 条：两条老的「三列文本」形态、一条已 gzip 形态（两种存量形态都要搬）；
 * - 评论 2 条：顶层 + 回复（父子都要重映射）。
 */
import type { SqliteD1 } from "./sqlite-d1"

/** 旧结构 DDL（`{prefix}` 占位，与实际迁移执行器同一替换口径）。 */
const LEGACY_DDL = `CREATE TABLE IF NOT EXISTS {prefix}users (
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
CREATE UNIQUE INDEX IF NOT EXISTS {prefix}users_public_id
  ON {prefix}users(public_id) WHERE public_id <> '';

CREATE TABLE IF NOT EXISTS {prefix}user_2fa (
  user_id      TEXT PRIMARY KEY,
  totp_secret  TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  email_otp_enabled INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS {prefix}auth_counters (
  key          TEXT PRIMARY KEY,
  action       TEXT NOT NULL,
  account      TEXT NOT NULL DEFAULT '',
  ip           TEXT NOT NULL DEFAULT '',
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  locked_until INTEGER,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS {prefix}auth_counters_action_account
  ON {prefix}auth_counters(action, account);

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
  content_md   TEXT,
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
  created_at   TEXT NOT NULL,
  content_gzip BLOB
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

CREATE TABLE IF NOT EXISTS {prefix}read_tokens (
  user_id      TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS {prefix}read_tokens_token_hash
  ON {prefix}read_tokens(token_hash);

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

CREATE TABLE IF NOT EXISTS {prefix}email_codes (
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
  ON {prefix}email_codes(expires_at);

CREATE TABLE IF NOT EXISTS {prefix}comments (
  id         TEXT PRIMARY KEY,
  page_id    TEXT NOT NULL,
  parent_id  TEXT,
  author_id  TEXT NOT NULL,
  body_md    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  edited_at  TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS {prefix}comments_page_created
  ON {prefix}comments(page_id, created_at);
CREATE INDEX IF NOT EXISTS {prefix}comments_parent
  ON {prefix}comments(parent_id);
CREATE INDEX IF NOT EXISTS {prefix}comments_author
  ON {prefix}comments(author_id);

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

/** 旧版账本名（带前导下划线，与现行同名）。 */
const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS _ciki_schema_migrations (
  name       TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch())
)`

/** 升级前账本里已应用的迁移。 */
export const LEGACY_MIGRATIONS = [
  "schema_v1",
  "schema_v2",
  "schema_v3",
  "schema_v4",
  "schema_v5"
]

/** 旧 id（UUID 形态），测试按它们断言「映射后落在哪个整数上」。 */
export const LEGACY_IDS = {
  userAdmin: "11111111-1111-4111-8111-111111111111",
  userEditor: "22222222-2222-4222-8222-222222222222",
  spaceDefault: "space-default",
  spaceSecond: "33333333-3333-4333-8333-333333333333",
  pageHome: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  pageChild: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  pageTrashed: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  pageOtherSpace: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  revisionLegacy: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  revisionGzip: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  revisionChild: "99999999-9999-4999-8999-999999999999",
  commentTop: "77777777-7777-4777-8777-777777777777",
  commentReply: "88888888-8888-4888-8888-888888888888"
} as const

/** 旧正文里引用的图片 key（迁移后仍应原样保留）。 */
export const LEGACY_IMAGE_KEY = "0f3c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b.png"

/** 父页正文 JSON：含站内链接（指向子页）与图片引用。 */
export const LEGACY_HOME_JSON = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "去" },
        {
          type: "text",
          text: "子页",
          marks: [
            {
              type: "link",
              attrs: { href: `/p/${LEGACY_IDS.pageChild}` }
            }
          ]
        }
      ]
    },
    {
      type: "image",
      attrs: { src: `/api/files/${LEGACY_IMAGE_KEY}`, alt: "配图" }
    }
  ]
})

/** 子页正文 JSON：反向链接回父页（父→子、子→父两个方向都要改写）。 */
export const LEGACY_CHILD_JSON = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "回首页",
          marks: [
            { type: "link", attrs: { href: `/p/${LEGACY_IDS.pageHome}` } }
          ]
        }
      ]
    }
  ]
})

/** 回收站页正文（回收站页面也要迁，含链接）。 */
export const LEGACY_TRASHED_JSON = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "已删除的页" }]
    }
  ]
})

/** 另一空间的页正文。 */
export const LEGACY_OTHER_JSON = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "别的空间" }] }
  ]
})

/** 老形态版本正文（三列文本，未 gzip）。 */
export const LEGACY_REVISION_JSON = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "旧版本链接",
          marks: [
            { type: "link", attrs: { href: `/p/${LEGACY_IDS.pageChild}` } }
          ]
        }
      ]
    }
  ]
})

/** 已 gzip 形态的版本正文（迁移前最后一次保存）。 */
export const LEGACY_GZIP_REVISION_JSON = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "新版本" }] }]
})

export interface LegacySeed {
  /** 会话 token 的哈希（断言会话行原样保留）。 */
  sessionTokenHash: string
}

/** 建出旧结构的库（含账本与默认空间），返回可继续插数据的 D1 替身。 */
export async function createLegacyDatabase(
  db: SqliteD1,
  prefix = "ciki_"
): Promise<void> {
  await db.exec(LEDGER_DDL)
  for (const statement of LEGACY_DDL.split(";\n").map((s) => s.trim())) {
    if (!statement) continue
    await db.exec(statement.replaceAll("{prefix}", prefix))
  }
  for (const name of LEGACY_MIGRATIONS) {
    await db.db
      .prepare(
        "INSERT INTO _ciki_schema_migrations (name, applied_at) VALUES (?, 1)"
      )
      .run(name)
  }
  await db.db
    .prepare(
      `INSERT INTO ciki_spaces (id, name, description, is_default, created_by, created_at, updated_at)
       VALUES (?, '默认空间', '', 1, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    )
    .run(LEGACY_IDS.spaceDefault, LEGACY_IDS.userAdmin)
}

/**
 * 往旧库塞入存量数据（时间戳固定，好断言按 `created_at` 发号的结果）。
 *
 * 调用前需要先建出两个用户：这里按 `LEGACY_IDS` 直接写行，密码哈希用占位串
 * （迁移不校验密码，原样搬）。
 */
export async function seedLegacyDatabase(
  db: SqliteD1,
  totpSecretCiphertext: string
): Promise<LegacySeed> {
  const now = "2026-05-01T00:00:00.000Z"
  await db.db
    .prepare(
      `INSERT INTO ciki_users
        (id, email, password_hash, role, is_active, approval_status, email_verified,
         username, public_id, avatar_key, created_at, updated_at)
       VALUES (?, 'admin@example.com', 'hash-1', 'admin', 1, 'approved', 1,
               'admin', 'AAAAAAA1', 'avatars/old.png', '2026-01-01T00:00:00.000Z', ?)`
    )
    .run(LEGACY_IDS.userAdmin, now)
  await db.db
    .prepare(
      `INSERT INTO ciki_users
        (id, email, password_hash, role, is_active, approval_status, email_verified,
         username, public_id, avatar_key, created_at, updated_at)
       VALUES (?, 'editor@example.com', 'hash-2', 'user', 1, 'approved', 1,
               'editor', 'BBBBBBB2', '', '2026-01-02T00:00:00.000Z', ?)`
    )
    .run(LEGACY_IDS.userEditor, now)

  await db.db
    .prepare(
      `INSERT INTO ciki_spaces (id, name, description, is_default, created_by, created_at, updated_at)
       VALUES (?, '第二个空间', '说明', 0, ?, '2026-01-03T00:00:00.000Z', ?)`
    )
    .run(LEGACY_IDS.spaceSecond, LEGACY_IDS.userAdmin, now)

  await db.db
    .prepare(
      `INSERT INTO ciki_space_members (space_id, user_id, role, created_at)
       VALUES (?, ?, 'admin', ?), (?, ?, 'editor', ?),
              (?, ?, 'editor', ?)`
    )
    .run(
      LEGACY_IDS.spaceDefault,
      LEGACY_IDS.userAdmin,
      now,
      LEGACY_IDS.spaceDefault,
      LEGACY_IDS.userEditor,
      now,
      LEGACY_IDS.spaceSecond,
      LEGACY_IDS.userAdmin,
      now
    )

  await db.db
    .prepare(
      `INSERT INTO ciki_user_2fa (user_id, totp_secret, totp_enabled, email_otp_enabled, updated_at)
       VALUES (?, ?, 1, 0, ?)`
    )
    .run(LEGACY_IDS.userAdmin, totpSecretCiphertext, now)

  await db.db
    .prepare(
      `INSERT INTO ciki_passkey_credentials
        (id, user_id, credential_id, public_key, counter, transports, created_at)
       VALUES ('pk-old', ?, 'cred-1', 'pk-1', 7, 'internal', ?)`
    )
    .run(LEGACY_IDS.userAdmin, now)

  const sessionTokenHash = "a".repeat(64)
  await db.db
    .prepare(
      `INSERT INTO ciki_sessions
        (id, token_hash, user_id, needs_2fa_setup, created_at, last_seen_at, expires_at, ip, user_agent)
       VALUES ('sess-1', ?, ?, 0, 1, 1, 9999999999, '203.0.113.9', 'ua')`
    )
    .run(sessionTokenHash, LEGACY_IDS.userAdmin)

  await db.db
    .prepare(
      `INSERT INTO ciki_import_tokens (user_id, token_hash, created_at)
       VALUES (?, 'import-hash', ?)`
    )
    .run(LEGACY_IDS.userAdmin, now)
  await db.db
    .prepare(
      `INSERT INTO ciki_read_tokens (user_id, token_hash, created_at)
       VALUES (?, 'read-hash', ?)`
    )
    .run(LEGACY_IDS.userEditor, now)
  await db.db
    .prepare(
      `INSERT INTO ciki_email_codes (user_id, purpose, binding, code_hash, created_at, expires_at)
       VALUES (?, '2fa_enable', '', 'code-hash', 1, 9999999999)`
    )
    .run(LEGACY_IDS.userAdmin)
  await db.db
    .prepare(
      `INSERT INTO ciki_auth_challenges (key, user_id, purpose, payload, expires_at, created_at)
       VALUES ('challenge-1', ?, 'totp_setup', 'secret', 9999999999, 1)`
    )
    .run(LEGACY_IDS.userAdmin)

  const insertPage = db.db.prepare(
    `INSERT INTO ciki_pages
      (id, space_id, parent_id, title, sort_order, content_json, content_html,
       content_text, content_md, created_by, updated_by, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  insertPage.run(
    LEGACY_IDS.pageHome,
    LEGACY_IDS.spaceDefault,
    null,
    "首页",
    LEGACY_HOME_JSON,
    `<p>去 <a href="/p/${LEGACY_IDS.pageChild}">子页</a></p><img src="/api/files/${LEGACY_IMAGE_KEY}">`,
    "去 子页",
    `去 [子页](/p/${LEGACY_IDS.pageChild})\n\n![](${LEGACY_IMAGE_KEY})`,
    LEGACY_IDS.userAdmin,
    LEGACY_IDS.userAdmin,
    "2026-01-01T00:00:00.000Z",
    now,
    null
  )
  insertPage.run(
    LEGACY_IDS.pageChild,
    LEGACY_IDS.spaceDefault,
    LEGACY_IDS.pageHome,
    "子页",
    LEGACY_CHILD_JSON,
    `<p><a href="/p/${LEGACY_IDS.pageHome}">回首页</a></p>`,
    "回首页",
    `[回首页](/p/${LEGACY_IDS.pageHome})`,
    LEGACY_IDS.userEditor,
    LEGACY_IDS.userEditor,
    "2026-01-02T00:00:00.000Z",
    now,
    null
  )
  insertPage.run(
    LEGACY_IDS.pageTrashed,
    LEGACY_IDS.spaceDefault,
    null,
    "回收站页",
    LEGACY_TRASHED_JSON,
    "<p>已删除的页</p>",
    "已删除的页",
    "已删除的页",
    LEGACY_IDS.userAdmin,
    LEGACY_IDS.userAdmin,
    "2026-01-03T00:00:00.000Z",
    now,
    now
  )
  insertPage.run(
    LEGACY_IDS.pageOtherSpace,
    LEGACY_IDS.spaceSecond,
    null,
    "别的空间",
    LEGACY_OTHER_JSON,
    "<p>别的空间</p>",
    "别的空间",
    "别的空间",
    LEGACY_IDS.userAdmin,
    LEGACY_IDS.userAdmin,
    "2026-01-04T00:00:00.000Z",
    now,
    null
  )

  // 版本：一条老形态（三列文本 + 无 gzip）、一条 gzip 形态、一条子页版本。
  await db.db
    .prepare(
      `INSERT INTO ciki_page_revisions
        (id, page_id, title, content_json, content_html, content_text, editor_id, created_at, content_gzip)
       VALUES (?, ?, '首页', ?, '', '', ?, '2026-01-01T10:00:00.000Z', NULL)`
    )
    .run(
      LEGACY_IDS.revisionLegacy,
      LEGACY_IDS.pageHome,
      LEGACY_REVISION_JSON,
      LEGACY_IDS.userAdmin
    )
  await db.db
    .prepare(
      `INSERT INTO ciki_page_revisions
        (id, page_id, title, content_json, content_html, content_text, editor_id, created_at, content_gzip)
       VALUES (?, ?, '首页', '', '', '', ?, '2026-01-01T11:00:00.000Z', ?)`
    )
    .run(
      LEGACY_IDS.revisionGzip,
      LEGACY_IDS.pageHome,
      LEGACY_IDS.userAdmin,
      await gzipBytes(LEGACY_GZIP_REVISION_JSON)
    )
  await db.db
    .prepare(
      `INSERT INTO ciki_page_revisions
        (id, page_id, title, content_json, content_html, content_text, editor_id, created_at, content_gzip)
       VALUES (?, ?, '子页', '', '', '', ?, '2026-01-02T11:00:00.000Z', ?)`
    )
    .run(
      LEGACY_IDS.revisionChild,
      LEGACY_IDS.pageChild,
      LEGACY_IDS.userEditor,
      await gzipBytes(LEGACY_CHILD_JSON)
    )

  // 评论：顶层 + 回复（parent_id 指向顶层，迁移后两行都要重映射）。
  await db.db
    .prepare(
      `INSERT INTO ciki_comments (id, page_id, parent_id, author_id, body_md, created_at)
       VALUES (?, ?, NULL, ?, '顶层评论', '2026-01-01T12:00:00.000Z')`
    )
    .run(LEGACY_IDS.commentTop, LEGACY_IDS.pageHome, LEGACY_IDS.userAdmin)
  await db.db
    .prepare(
      `INSERT INTO ciki_comments (id, page_id, parent_id, author_id, body_md, created_at)
       VALUES (?, ?, ?, ?, '回复', '2026-01-01T13:00:00.000Z')`
    )
    .run(
      LEGACY_IDS.commentReply,
      LEGACY_IDS.pageHome,
      LEGACY_IDS.commentTop,
      LEGACY_IDS.userEditor
    )

  return { sessionTokenHash }
}

/** 旧版 gzip 字节 → 新表的 BLOB 列可直接接受。 */
async function gzipBytes(text: string): Promise<Uint8Array> {
  const { gzipText } = await import("../../src/lib/gzip")
  return gzipText(text)
}
