/**
 * 结构坍缩后的迁移（`schema_v7` + `schema_v8`）的**演练测试**：拿真实生产形态（v6 形态）的库
 * 跑一次完整升级。
 *
 * 这是本单最重要的证据——重建是不可回头的一次性操作，所以逐项对应验收标准：
 * - 只记 `schema_v7` + `schema_v8` 两条迁移，旧账本行原样留着；
 * - `users` 的三列消失、`language` 逐值保真、存量用户 `email_verified` 一律置 1；
 * - 其余列逐值保真、逐表行数不变、页面/版本的 `content_hash` 逐行不变、正文对象
 *   全量可回读（不抽样、不重传）；
 * - `email_codes` 换成含 `register_verify` 的新 CHECK，既有行原样保留；
 * - FTS 照旧可检索；`v7_*` 临时表零残留、索引齐全；重复 setup 幂等；
 * - 正文对象缺失或损坏 → 在切表前中止，旧表与账本一字未动，修好重跑成功；
 * - UUID 时代形态（`pages` 无 `content_hash`）→ 明确报「不支持的旧结构」，一个表都不动。
 */
import { describe, expect, it } from "vitest"
import {
  contentObjectKey,
  hashContent,
  putContent,
  readContent
} from "../src/core/content-store"
import { decryptSecret, encryptSecret } from "../src/core/secret-box"
import { toMatchQuery } from "../src/lib/fts"
import { gunzipText, gzipText } from "../src/lib/gzip"
import { SCHEMA_TABLES } from "../src/lib/schema"
import { runSetup } from "../src/lib/setup"
import {
  TEST_ENCRYPTION_KEY,
  initializedContext,
  makeContext
} from "./support/app"
import type { MemoryR2 } from "./support/memory-r2"
import type { SqliteD1 } from "./support/sqlite-d1"
import {
  V6_CHILD_JSON,
  V6_HOME_JSON,
  V6_REVISION_ONE_JSON,
  V6_REVISION_TWO_JSON,
  V6_TRASHED_JSON,
  createV6Database,
  seedV6Database
} from "./support/v6-schema"

const TOTP_SECRET = "JBSWY3DPEHPK3PXP"

/**
 * 一次完整升级按账本顺序执行 `schema_v7` + `schema_v8` 两条，状态相同。
 */
function ledgerResult(status: "applied" | "skipped") {
  return [
    { name: "schema_v7", status },
    { name: "schema_v8", status }
  ]
}

function encryptedTotp(): Promise<string> {
  return encryptSecret(TEST_ENCRYPTION_KEY, TOTP_SECRET, "ciki:totp:1")
}

/** 建一个生产形态（v6）的库并把存量数据灌好。 */
async function v6Context() {
  const context = makeContext()
  await createV6Database(context.db)
  const seed = await seedV6Database(context, await encryptedTotp())
  return { ...context, seed }
}

/** 表的列名（PRAGMA table_info）。 */
function columns(db: SqliteD1, table: string): string[] {
  const rows = db.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string
  }>
  return rows.map((row) => row.name)
}

function tableNames(db: SqliteD1): string[] {
  return (
    db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name)
}

/** 把内容桶里的对象换成「同一 key、不同字节」（等价于 R2 写入静默损坏）。 */
async function corruptObject(content: MemoryR2, hash: string): Promise<void> {
  const key = contentObjectKey(hash)
  const object = content.store.get(key)
  if (!object) throw new Error(`test setup: object ${key} is missing`)
  await content.put(key, await gzipText(`${await gunzipText(object.bytes)} `))
}

describe("重建：生产形态（v6）跑一次 setup", () => {
  it("只记 schema_v7 + schema_v8；users 三列消失、language 保真、存量用户一律已验证", async () => {
    const { env, db } = await v6Context()
    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)

    expect(result.migrations).toEqual(ledgerResult("applied"))

    const userColumns = columns(db, "ciki_users")
    expect(userColumns).not.toContain("base_currency")
    expect(userColumns).not.toContain("timezone")
    expect(userColumns).not.toContain("theme")
    expect(userColumns).toContain("language")
    expect(userColumns).toContain("email_verified")

    const users = db.db
      .prepare(
        `SELECT id, email, password_hash, role, is_active, approval_status,
                email_verified, language, username, avatar_key, created_at
           FROM ciki_users ORDER BY id`
      )
      .all() as Array<Record<string, unknown>>
    expect(users).toEqual([
      {
        id: 1,
        email: "admin@example.com",
        password_hash: "hash-1",
        role: "admin",
        is_active: 1,
        approval_status: "approved",
        email_verified: 1,
        language: "zh",
        username: "admin",
        avatar_key: "avatars/old.png",
        created_at: "2026-01-01T00:00:00.000Z"
      },
      {
        id: 2,
        email: "editor@example.com",
        password_hash: "hash-2",
        role: "user",
        is_active: 1,
        approval_status: "approved",
        // 迁移前是 0：存量用户一律置 1，不锁任何人。
        email_verified: 1,
        language: "en",
        username: "editor",
        avatar_key: "",
        created_at: "2026-01-02T00:00:00.000Z"
      }
    ])
  })

  it("email_codes 换新 CHECK：既有行保留，register_verify 可写入", async () => {
    const { env, db } = await v6Context()
    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)

    const rows = db.db
      .prepare(
        "SELECT user_id, purpose, code_hash, attempts FROM ciki_email_codes"
      )
      .all()
    expect(rows).toEqual([
      { user_id: 1, purpose: "2fa_enable", code_hash: "code-hash", attempts: 2 }
    ])

    // 旧 CHECK 会拒掉这个 purpose；新 CHECK 必须收下。
    db.db
      .prepare(
        `INSERT INTO ciki_email_codes
          (user_id, purpose, binding, code_hash, attempts, created_at, expires_at)
         VALUES (2, 'register_verify', '', 'new-hash', 0, 1, 9999999999)`
      )
      .run()
    expect(
      db.db
        .prepare(
          "SELECT COUNT(*) AS count FROM ciki_email_codes WHERE purpose = 'register_verify'"
        )
        .get()
    ).toEqual({ count: 1 })
  })

  it("其余表逐值保真：正文指针不变、对象不重传、FTS 可检索、账号体系完整", async () => {
    const { env, db, content, seed } = await v6Context()
    const objectsBefore = content.store.size
    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)

    const pages = db.db
      .prepare(
        `SELECT id, space_id, parent_id, title, content_hash, content_html,
                content_text, content_md, created_by, updated_by, deleted_at
           FROM ciki_pages ORDER BY id`
      )
      .all() as Array<Record<string, unknown>>
    expect(pages.map((page) => page.content_hash)).toEqual([
      seed.hashes.home,
      seed.hashes.child,
      seed.hashes.trashed
    ])
    expect(pages.map((page) => [page.id, page.title, page.space_id])).toEqual([
      [1, "首页", 1],
      [2, "子页", 1],
      [3, "回收站页", 1]
    ])
    expect(pages[1].parent_id).toBe(1)
    expect(pages[2].deleted_at).toBe("2026-02-01T00:00:00.000Z")

    const revisions = db.db
      .prepare(
        "SELECT id, page_id, version_no, title, content_hash, editor_id FROM ciki_page_revisions ORDER BY id"
      )
      .all()
    expect(revisions).toEqual([
      {
        id: 1,
        page_id: 1,
        version_no: 1,
        title: "首页",
        content_hash: seed.hashes.revisionOne,
        editor_id: 1
      },
      {
        id: 2,
        page_id: 1,
        version_no: 2,
        title: "首页",
        content_hash: seed.hashes.revisionTwo,
        editor_id: 1
      }
    ])

    // 正文全量回读：哈希等于指针、解压即原文；对象数没变（迁移不重传内容）。
    const expected: Record<string, string> = {
      [seed.hashes.home]: V6_HOME_JSON,
      [seed.hashes.child]: V6_CHILD_JSON,
      [seed.hashes.trashed]: V6_TRASHED_JSON,
      [seed.hashes.revisionOne]: V6_REVISION_ONE_JSON,
      [seed.hashes.revisionTwo]: V6_REVISION_TWO_JSON
    }
    for (const [hash, json] of Object.entries(expected)) {
      expect(await hashContent(json)).toBe(hash)
      expect(await readContent(env, hash)).toBe(json)
    }
    expect(content.store.size).toBe(objectsBefore)

    // FTS 原样可检索（回收站页本来就不在索引里）。
    const hit = db.db
      .prepare(
        "SELECT CAST(page_id AS INTEGER) AS page_id FROM ciki_pages_fts WHERE ciki_pages_fts MATCH ?"
      )
      .all(toMatchQuery("子页") ?? "") as Array<{ page_id: number }>
    expect(hit.map((row) => row.page_id)).toEqual([2])
    expect(
      db.db.prepare("SELECT COUNT(*) AS count FROM ciki_pages_fts").get()
    ).toEqual({ count: 2 })

    // 账号体系：会话、令牌、通行密钥、TOTP（AAD 未变，仍解得出原密钥）、挑战。
    expect(
      db.db.prepare("SELECT user_id, token_hash FROM ciki_sessions").get()
    ).toEqual({ user_id: 1, token_hash: seed.sessionTokenHash })
    expect(
      db.db.prepare("SELECT user_id FROM ciki_import_tokens").get()
    ).toEqual({ user_id: 1 })
    expect(db.db.prepare("SELECT user_id FROM ciki_read_tokens").get()).toEqual(
      {
        user_id: 2
      }
    )
    expect(
      db.db
        .prepare("SELECT user_id, counter FROM ciki_passkey_credentials")
        .get()
    ).toEqual({ user_id: 1, counter: 7 })
    expect(
      db.db.prepare("SELECT user_id FROM ciki_auth_challenges").get()
    ).toEqual({ user_id: 1 })
    const twofa = db.db
      .prepare("SELECT totp_secret, totp_enabled FROM ciki_user_2fa")
      .get() as { totp_secret: string; totp_enabled: number }
    expect(twofa.totp_enabled).toBe(1)
    expect(
      await decryptSecret(TEST_ENCRYPTION_KEY, twofa.totp_secret, "ciki:totp:1")
    ).toBe(TOTP_SECRET)

    // 空间与成员、评论、计数、设置、清理日志、回调账本原样在。
    expect(
      db.db
        .prepare("SELECT id, slug, is_default FROM ciki_spaces ORDER BY id")
        .all()
    ).toEqual([
      { id: 1, slug: "space-1", is_default: 1 },
      { id: 2, slug: "space-2", is_default: 0 }
    ])
    expect(
      db.db
        .prepare(
          "SELECT space_id, user_id, role FROM ciki_space_members ORDER BY space_id, user_id"
        )
        .all()
    ).toEqual([
      { space_id: 1, user_id: 1, role: "admin" },
      { space_id: 1, user_id: 2, role: "editor" },
      { space_id: 2, user_id: 1, role: "admin" }
    ])
    expect(
      db.db
        .prepare(
          "SELECT id, parent_id, author_id FROM ciki_comments ORDER BY id"
        )
        .all()
    ).toEqual([
      { id: 1, parent_id: null, author_id: 1 },
      { id: 2, parent_id: 1, author_id: 2 }
    ])
    expect(
      db.db
        .prepare(
          "SELECT count FROM ciki_auth_counters WHERE action = 'register'"
        )
        .get()
    ).toEqual({ count: 2 })
    expect(
      db.db
        .prepare(
          "SELECT value FROM ciki_system_settings WHERE key = 'site_name'"
        )
        .get()
    ).toEqual({ value: "Ciki" })
    expect(
      db.db.prepare("SELECT trigger, dry_run FROM ciki_r2_cleanup_runs").get()
    ).toEqual({ trigger: "manual", dry_run: 1 })
    expect(
      db.db.prepare("SELECT execution_id FROM ciki_waker_executions").get()
    ).toEqual({ execution_id: "exec-1" })

    // 旧账本记录原样留着（执行器只认当前列表，不删历史）。
    const ledger = db.db
      .prepare("SELECT name FROM _ciki_schema_migrations ORDER BY name")
      .all() as Array<{ name: string }>
    expect(ledger.map((row) => row.name)).toEqual([
      "schema_v1",
      "schema_v2",
      "schema_v3",
      "schema_v4",
      "schema_v5",
      "schema_v6",
      "schema_v7",
      "schema_v8"
    ])
  })

  it("结构切换干净：v7_* 临时表零残留、定版索引齐全", async () => {
    const { env, db } = await v6Context()
    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)

    const names = tableNames(db)
    expect(names.filter((name) => name.includes("v7_"))).toEqual([])

    const indexes = (
      db.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    for (const name of [
      "ciki_page_revisions_page_version",
      "ciki_pages_space_deleted",
      "ciki_spaces_slug",
      "ciki_pages_content_hash",
      "ciki_email_codes_expires_at",
      "ciki_sessions_token_hash",
      "ciki_users_username"
    ]) {
      expect(indexes).toContain(name)
    }
  })

  it("重复 setup 幂等：一字不改、不重复建表", async () => {
    const { env, db, content, seed } = await v6Context()
    const first = await runSetup(env)
    if (!first.success) throw new Error(first.error)

    const before = {
      pages: db.db.prepare("SELECT COUNT(*) AS count FROM ciki_pages").get(),
      objects: content.store.size,
      hash: db.db
        .prepare("SELECT content_hash FROM ciki_pages WHERE id = 1")
        .get()
    }

    const again = await runSetup(env)
    if (!again.success) throw new Error(again.error)
    expect(again.migrations).toEqual(ledgerResult("skipped"))
    expect(
      db.db.prepare("SELECT COUNT(*) AS count FROM ciki_pages").get()
    ).toEqual(before.pages)
    expect(content.store.size).toBe(before.objects)
    expect(
      db.db.prepare("SELECT content_hash FROM ciki_pages WHERE id = 1").get()
    ).toEqual(before.hash)
    expect(
      db.db.prepare("SELECT content_hash FROM ciki_pages WHERE id = 1").get()
    ).toEqual({ content_hash: seed.hashes.home })
  })
})

describe("重建：失败与重跑", () => {
  it("上次中断留下的 v7_* 临时表：重跑前先清掉，不影响本次切换", async () => {
    const { env, db } = await v6Context()
    // 模拟上次在切表前中断：临时表里是半截数据，甚至形状都不对。
    await db.exec(
      `CREATE TABLE ciki_v7_users (id INTEGER PRIMARY KEY, junk TEXT)`
    )
    await db.exec(`INSERT INTO ciki_v7_users (id, junk) VALUES (1, 'half')`)
    await db.exec(`CREATE TABLE ciki_v7_pages (id INTEGER PRIMARY KEY)`)

    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)
    expect(result.migrations).toEqual(ledgerResult("applied"))
    expect(tableNames(db).filter((name) => name.includes("v7_"))).toEqual([])
    expect(
      db.db.prepare("SELECT COUNT(*) AS count FROM ciki_users").get()
    ).toEqual({ count: 2 })
  })

  it("正文对象被污染（哈希对不上）→ 中止、不切表；修好重跑成功", async () => {
    const { env, db, content, seed } = await v6Context()
    await corruptObject(content, seed.hashes.home)

    await expect(runSetup(env)).rejects.toThrow(/failed verification/)

    // 旧结构原样：三列还在、账本没有 schema_v7、数据一行没少。
    expect(columns(db, "ciki_users")).toContain("base_currency")
    expect(
      db.db.prepare("SELECT COUNT(*) AS count FROM ciki_users").get()
    ).toEqual({ count: 2 })
    expect(
      db.db
        .prepare(
          "SELECT name FROM _ciki_schema_migrations WHERE name = 'schema_v7'"
        )
        .all()
    ).toEqual([])

    // 修好对象（同 key 覆盖成正确字节）后重跑：切换完成。
    await putContent(env, V6_HOME_JSON)
    const retry = await runSetup(env)
    if (!retry.success) throw new Error(retry.error)
    expect(retry.migrations).toEqual(ledgerResult("applied"))
    expect(columns(db, "ciki_users")).not.toContain("base_currency")
    expect(
      db.db
        .prepare(
          "SELECT COUNT(*) AS count FROM ciki_users WHERE email_verified = 0"
        )
        .get()
    ).toEqual({ count: 0 })
  })

  it("正文对象缺失 → 中止、不切表；补回对象后重跑成功", async () => {
    const { env, db, content, seed } = await v6Context()
    await content.delete(contentObjectKey(seed.hashes.child))

    await expect(runSetup(env)).rejects.toThrow(/is missing/)
    expect(columns(db, "ciki_users")).toContain("base_currency")
    expect(
      db.db.prepare("SELECT COUNT(*) AS count FROM ciki_pages").get()
    ).toEqual({ count: 3 })

    // 补回对象后重跑成功（重跑开头会先清 v7_* 临时表）。
    await putContent(env, V6_CHILD_JSON)
    const retry = await runSetup(env)
    if (!retry.success) throw new Error(retry.error)
    expect(retry.migrations).toEqual(ledgerResult("applied"))
    expect(tableNames(db).filter((name) => name.includes("v7_"))).toEqual([])
  })

  it("UUID 时代形态（pages 无 content_hash）→ 明确报错，一个表都不动", async () => {
    const { env, db } = makeContext()
    await db.exec(`
      CREATE TABLE ciki_users (
        id INTEGER PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT NOT NULL,
        role TEXT NOT NULL, is_active INTEGER NOT NULL, approval_status TEXT NOT NULL,
        email_verified INTEGER NOT NULL, base_currency TEXT NOT NULL,
        language TEXT NOT NULL, username TEXT NOT NULL, avatar_key TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE ciki_pages (id TEXT PRIMARY KEY, content_json TEXT NOT NULL);
      CREATE VIRTUAL TABLE ciki_pages_fts USING fts5(page_id UNINDEXED, title, content_text);
    `)
    await db.db
      .prepare(
        `INSERT INTO ciki_users VALUES
          (1, 'old@example.com', 'hash', 'admin', 1, 'approved', 1, 'CNY', 'zh', 'old', '', '2026-01-01', '2026-01-01')`
      )
      .run()

    await expect(runSetup(env)).rejects.toThrow(
      /Unsupported legacy database shape/
    )

    // 什么都没动：旧列还在、旧表还在、临时表没建、账本没记账。
    expect(columns(db, "ciki_users")).toContain("base_currency")
    expect(columns(db, "ciki_pages")).toEqual(["id", "content_json"])
    expect(tableNames(db).filter((name) => name.includes("v7_"))).toEqual([])
    expect(
      db.db
        .prepare(
          "SELECT name FROM _ciki_schema_migrations WHERE name = 'schema_v7'"
        )
        .all()
    ).toEqual([])
    expect(
      db.db.prepare("SELECT COUNT(*) AS count FROM ciki_users").get()
    ).toEqual({ count: 1 })
  })
})

describe("定版结构：空库之外的兜底", () => {
  it("v6 形态的 users 但没有 pages（残缺现场）→ 明确报错，不留带三列的表", async () => {
    const { env, db } = makeContext()
    await db.exec(`
      CREATE TABLE ciki_users (
        id INTEGER PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT NOT NULL,
        role TEXT NOT NULL, is_active INTEGER NOT NULL, approval_status TEXT NOT NULL,
        email_verified INTEGER NOT NULL, base_currency TEXT NOT NULL,
        timezone TEXT NOT NULL, language TEXT NOT NULL, theme TEXT NOT NULL,
        username TEXT NOT NULL, avatar_key TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )
    `)
    await expect(runSetup(env)).rejects.toThrow(
      /Unsupported legacy database shape/
    )
    expect(columns(db, "ciki_users")).toContain("base_currency")
    expect(tableNames(db)).not.toContain("ciki_pages")
  })

  it("只有一张半成品 users 表（缺 pages）→ 不重建，建表语句补齐", async () => {
    const { env, db } = makeContext()
    // 部分失败的迁移现场：users 已建、其余表还没有。判据都是「缺 pages」→ 空转。
    await db.exec(
      `CREATE TABLE ciki_users (
        id INTEGER PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT NOT NULL,
        role TEXT NOT NULL, is_active INTEGER NOT NULL, approval_status TEXT NOT NULL,
        email_verified INTEGER NOT NULL, language TEXT NOT NULL, username TEXT NOT NULL,
        avatar_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`
    )
    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)
    expect(result.migrations).toEqual(ledgerResult("applied"))
    const names = tableNames(db)
    for (const table of SCHEMA_TABLES) {
      expect(names).toContain(`ciki_${table.name}`)
    }
  })
})

describe("schema_v8：username 唯一索引与存量重名消解", () => {
  /** 往定版结构的 users 插一行（重建后的表没有 base_currency 等三列）。 */
  function insertUser(db: SqliteD1, id: number, username: string): void {
    const now = "2026-05-02T00:00:00.000Z"
    db.db
      .prepare(
        `INSERT INTO ciki_users
          (id, email, password_hash, role, is_active, approval_status, email_verified,
           language, username, avatar_key, created_at, updated_at)
         VALUES (?, ?, ?, 'user', 1, 'approved', 1, 'zh', ?, '', ?, ?)`
      )
      .run(id, `u${id}@example.com`, `hash-${id}`, username, now, now)
  }

  /** 把已升级的库退回「v7 既存库」现场：去掉唯一索引与 v8 账本行。 */
  async function rewindToV7(db: SqliteD1): Promise<void> {
    await db.exec("DROP INDEX IF EXISTS ciki_users_username")
    await db.exec(
      "DELETE FROM _ciki_schema_migrations WHERE name = 'schema_v8'"
    )
  }

  function usernames(db: SqliteD1): Array<{ id: number; username: string }> {
    return db.db
      .prepare("SELECT id, username FROM ciki_users ORDER BY id")
      .all() as Array<{ id: number; username: string }>
  }

  it("v6 升级：只给撞名补 -2，空串原样留着，索引随后建上", async () => {
    const { env, db } = await v6Context()
    const now = "2026-05-02T00:00:00.000Z"
    // 两种典型存量：与 admin 重名（要加后缀）、以及 username 还是空串（不参与唯一约束）。
    db.db
      .prepare(
        `INSERT INTO ciki_users
          (id, email, password_hash, role, is_active, approval_status, email_verified,
           base_currency, timezone, language, theme, username, avatar_key, created_at, updated_at)
         VALUES (3, 'dup@example.com', 'hash-3', 'user', 1, 'approved', 1,
                 'CNY', 'UTC', 'zh', 'system', 'admin', '', ?, ?)`
      )
      .run(now, now)
    db.db
      .prepare(
        `INSERT INTO ciki_users
          (id, email, password_hash, role, is_active, approval_status, email_verified,
           base_currency, timezone, language, theme, username, avatar_key, created_at, updated_at)
         VALUES (4, 'empty@example.com', 'hash-4', 'user', 1, 'approved', 1,
                 'CNY', 'UTC', 'zh', 'system', '', '', ?, ?)`
      )
      .run(now, now)

    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)
    expect(result.migrations).toEqual(ledgerResult("applied"))
    expect(usernames(db)).toEqual([
      { id: 1, username: "admin" },
      { id: 2, username: "editor" },
      { id: 3, username: "admin-2" },
      { id: 4, username: "" }
    ])
    // 索引已在：大小写不同也算撞名。
    expect(() => insertUser(db, 5, "ADMIN")).toThrow(/UNIQUE constraint failed/)
  })

  it("v7 既存库：重名先消解再建索引，重跑幂等且不再改名", async () => {
    const { env, db } = await initializedContext()
    await rewindToV7(db)
    insertUser(db, 1, "dup")
    insertUser(db, 2, "DUP")
    insertUser(db, 3, "")
    insertUser(db, 4, "  spaced  ")
    insertUser(db, 5, "b".repeat(41))
    insertUser(db, 6, "é")
    insertUser(db, 7, "É")

    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)
    expect(result.migrations).toEqual([
      { name: "schema_v7", status: "skipped" },
      { name: "schema_v8", status: "applied" }
    ])
    // 只消重名：DUP 只加后缀（保留原大小写）；空白、41 码点、非 ASCII 大小写
    // 都原样保留（索引的 COLLATE NOCASE 也只折 ASCII，é 与 É 本来就不是重名）。
    expect(usernames(db)).toEqual([
      { id: 1, username: "dup" },
      { id: 2, username: "DUP-2" },
      { id: 3, username: "" },
      { id: 4, username: "  spaced  " },
      { id: 5, username: "b".repeat(41) },
      { id: 6, username: "é" },
      { id: 7, username: "É" }
    ])
    expect(
      db.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='ciki_users_username'"
        )
        .get()
    ).toEqual({ name: "ciki_users_username" })

    const again = await runSetup(env)
    if (!again.success) throw new Error(again.error)
    expect(again.migrations).toEqual(ledgerResult("skipped"))
    expect(usernames(db)).toEqual([
      { id: 1, username: "dup" },
      { id: 2, username: "DUP-2" },
      { id: 3, username: "" },
      { id: 4, username: "  spaced  " },
      { id: 5, username: "b".repeat(41) },
      { id: 6, username: "é" },
      { id: 7, username: "É" }
    ])
  })

  it("40 码点基础名：后缀算在 40 码点内，结果不超限", async () => {
    const { env, db } = await initializedContext()
    await rewindToV7(db)
    const long = "a".repeat(40)
    insertUser(db, 1, long)
    insertUser(db, 2, long)

    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)
    const rows = usernames(db)
    expect(rows[0].username).toBe(long)
    expect(rows[1].username).toBe(`${"a".repeat(38)}-2`)
    expect(Array.from(rows[1].username)).toHaveLength(40)
  })
})
