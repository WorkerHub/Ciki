/**
 * 一次性重建迁移（`schema_v6`）的**演练测试**：拿真实旧结构的库跑一遍完整升级。
 *
 * 这是本单最重要的证据——迁移是不可回头的一次性操作，所以这里逐项对应验收标准：
 * - 全部 id 整数化且**顺序确定**（页面/用户/空间/评论按 `created_at`，版本页内连续）；
 * - 正文（当前 + 全部版本，含 gzip 形态与回收站页面）搬到 `ciki-content`，
 *   key = `content/<sha256>`，哈希对象是**改写站内链接之后**的原始 JSON；
 * - 逐页逐版本**全量**校验：解压后与库里的 `content_hash` 逐字节一致（不抽样）；
 * - 站内链接 `/p/<uuid>` → `/p/<新 id>`，图片 `/api/files/` 原样；
 * - 派生列（HTML/纯文本/MD）同口径改写，FTS 用整数 id 重建；
 * - 会话、令牌、通行密钥、TOTP 全部活着（TOTP 用新 AAD 重新加密，旧 AAD 解不开）；
 * - 重复 setup 幂等；任一步失败则旧结构与数据一字未动、账本不记账。
 */
import { describe, expect, it } from "vitest"
import { decryptSecret, encryptSecret } from "../src/core/secret-box"
import { contentObjectKey, hashContent } from "../src/core/content-store"
import { toMatchQuery } from "../src/lib/fts"
import { gunzipText } from "../src/lib/gzip"
import { runSetup } from "../src/lib/setup"
import { TEST_ENCRYPTION_KEY, makeContext } from "./support/app"
import type { SqliteD1 } from "./support/sqlite-d1"
import {
  LEGACY_GZIP_REVISION_JSON,
  LEGACY_HOME_JSON,
  LEGACY_IDS,
  LEGACY_IMAGE_KEY,
  LEGACY_REVISION_JSON,
  LEGACY_CHILD_JSON,
  LEGACY_TRASHED_JSON,
  createLegacyDatabase,
  seedLegacyDatabase
} from "./support/legacy-schema"

type TestDb = SqliteD1

const TOTP_SECRET = "JBSWY3DPEHPK3PXP"

/** 旧站内链接改写后的期望正文（父页：子页指向新 id 2）。 */
const REWRITTEN_HOME_JSON = LEGACY_HOME_JSON.replace(
  `/p/${LEGACY_IDS.pageChild}`,
  "/p/2"
)
const REWRITTEN_CHILD_JSON = LEGACY_CHILD_JSON.replace(
  `/p/${LEGACY_IDS.pageHome}`,
  "/p/1"
)
const REWRITTEN_TRASHED_JSON = LEGACY_TRASHED_JSON
const REWRITTEN_REVISION_JSON = LEGACY_REVISION_JSON.replace(
  `/p/${LEGACY_IDS.pageChild}`,
  "/p/2"
)

async function encryptedLegacyTotp(): Promise<string> {
  return encryptSecret(
    TEST_ENCRYPTION_KEY,
    TOTP_SECRET,
    `ciki:totp:${LEGACY_IDS.userAdmin}`
  )
}

/** 建一个旧库并把存量数据灌好。 */
async function legacyContext() {
  const context = makeContext()
  await createLegacyDatabase(context.db)
  const seed = await seedLegacyDatabase(context.db, await encryptedLegacyTotp())
  return { ...context, seed }
}

/** 表的列名（PRAGMA table_info）。 */
function columns(db: TestDb, table: string): string[] {
  const rows = db.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string
  }>
  return rows.map((row) => row.name)
}

describe("重建迁移：全新旧库跑一次 setup", () => {
  it("id 全部整数化，且顺序按 created_at（页面/用户/空间/评论/版本）", async () => {
    const { env, db } = await legacyContext()
    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)

    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v6", status: "applied" }
    ])

    const users = db.db
      .prepare("SELECT id, email FROM ciki_users ORDER BY id")
      .all() as Array<{ id: number; email: string }>
    expect(users).toEqual([
      { id: 1, email: "admin@example.com" },
      { id: 2, email: "editor@example.com" }
    ])

    const spaces = db.db
      .prepare(
        "SELECT id, slug, name, is_default, created_by FROM ciki_spaces ORDER BY id"
      )
      .all() as Array<{
      id: number
      slug: string
      name: string
      is_default: number
      created_by: number
    }>
    expect(spaces).toEqual([
      {
        id: 1,
        slug: "space-1",
        name: "默认空间",
        is_default: 1,
        created_by: 1
      },
      {
        id: 2,
        slug: "space-2",
        name: "第二个空间",
        is_default: 0,
        created_by: 1
      }
    ])

    const pages = db.db
      .prepare(
        "SELECT id, title, space_id, parent_id, deleted_at, created_by, updated_by FROM ciki_pages ORDER BY id"
      )
      .all() as Array<{
      id: number
      title: string
      space_id: number
      parent_id: number | null
      deleted_at: string | null
      created_by: number
      updated_by: number
    }>
    expect(
      pages.map((page) => [page.id, page.title, page.space_id, page.parent_id])
    ).toEqual([
      [1, "首页", 1, null],
      [2, "子页", 1, 1],
      [3, "回收站页", 1, null],
      [4, "别的空间", 2, null]
    ])
    expect(pages[2].deleted_at).not.toBeNull()
    expect(pages[1].created_by).toBe(2)
    expect(pages[0].updated_by).toBe(1)

    const revisions = db.db
      .prepare(
        "SELECT id, page_id, version_no, editor_id FROM ciki_page_revisions ORDER BY id"
      )
      .all() as Array<{
      id: number
      page_id: number
      version_no: number
      editor_id: number
    }>
    expect(revisions).toEqual([
      { id: 1, page_id: 1, version_no: 1, editor_id: 1 },
      { id: 2, page_id: 1, version_no: 2, editor_id: 1 },
      { id: 3, page_id: 2, version_no: 1, editor_id: 2 }
    ])

    const comments = db.db
      .prepare(
        "SELECT id, page_id, parent_id, author_id FROM ciki_comments ORDER BY id"
      )
      .all() as Array<{
      id: number
      page_id: number
      parent_id: number | null
      author_id: number
    }>
    expect(comments).toEqual([
      { id: 1, page_id: 1, parent_id: null, author_id: 1 },
      { id: 2, page_id: 1, parent_id: 1, author_id: 2 }
    ])
  })

  it("正文全量搬到内容桶：逐页逐版本哈希等于库里的指针，解压即原文", async () => {
    const { env, db, content } = await legacyContext()
    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)

    const pages = db.db
      .prepare("SELECT id, content_hash FROM ciki_pages ORDER BY id")
      .all() as Array<{ id: number; content_hash: string }>
    // 回收站页与另一空间的页同样要搬（回收站页面不能丢正文）。
    const expectedByPage = new Map<number, string>([
      [1, REWRITTEN_HOME_JSON],
      [2, REWRITTEN_CHILD_JSON],
      [3, REWRITTEN_TRASHED_JSON],
      [
        4,
        JSON.stringify({
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "别的空间" }] }
          ]
        })
      ]
    ])

    for (const page of pages) {
      const expected = expectedByPage.get(page.id)
      expect(expected).toBeDefined()
      expect(page.content_hash).toBe(await hashContent(expected ?? ""))
      const object = content.store.get(contentObjectKey(page.content_hash))
      expect(object).toBeDefined()
      expect(await gunzipText(object?.bytes ?? new Uint8Array())).toBe(expected)
    }

    const revisions = db.db
      .prepare(
        "SELECT id, page_id, content_hash FROM ciki_page_revisions ORDER BY id"
      )
      .all() as Array<{ id: number; page_id: number; content_hash: string }>
    const expectedRevisions = [
      REWRITTEN_REVISION_JSON,
      LEGACY_GZIP_REVISION_JSON,
      REWRITTEN_CHILD_JSON
    ]
    expect(revisions).toHaveLength(expectedRevisions.length)
    for (const [index, revision] of revisions.entries()) {
      const expected = expectedRevisions[index]
      expect(revision.content_hash).toBe(await hashContent(expected))
      const object = content.store.get(contentObjectKey(revision.content_hash))
      expect(await gunzipText(object?.bytes ?? new Uint8Array())).toBe(expected)
    }
  })

  it("站内链接改写、图片原样；派生列与 FTS 同口径", async () => {
    const { env, db } = await legacyContext()
    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)

    const home = db.db
      .prepare(
        "SELECT content_html, content_text, content_md FROM ciki_pages WHERE id = 1"
      )
      .get() as {
      content_html: string
      content_text: string
      content_md: string
    }
    expect(home.content_html).toContain('href="/p/2"')
    expect(home.content_html).toContain(`/api/files/${LEGACY_IMAGE_KEY}`)
    expect(home.content_html).not.toContain(LEGACY_IDS.pageChild)
    expect(home.content_md).toContain("/p/2")
    expect(home.content_text).toBe("去 子页")

    const child = db.db
      .prepare("SELECT content_md FROM ciki_pages WHERE id = 2")
      .get() as { content_md: string }
    expect(child.content_md).toContain("/p/1")

    const fts = db.db
      .prepare(
        "SELECT CAST(page_id AS INTEGER) AS page_id FROM ciki_pages_fts ORDER BY page_id"
      )
      .all() as Array<{ page_id: number }>
    // 回收站页面不进索引，其余三页都在。
    expect(fts.map((row) => row.page_id)).toEqual([1, 2, 4])
    // CJK 按逐字空格化 + 短语匹配（写入与查询共用 toIndexText）。
    const hit = db.db
      .prepare(
        "SELECT COUNT(*) AS count FROM ciki_pages_fts WHERE ciki_pages_fts MATCH ?"
      )
      .get(toMatchQuery("子页") ?? "") as { count: number }
    expect(hit.count).toBeGreaterThan(0)
  })

  it("账号体系完整迁移：会话/令牌/通行密钥/TOTP（AAD 换成新 id）", async () => {
    const { env, db, seed } = await legacyContext()
    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)

    const session = db.db
      .prepare("SELECT user_id, token_hash FROM ciki_sessions")
      .get() as { user_id: number; token_hash: string }
    expect(session.user_id).toBe(1)
    expect(session.token_hash).toBe(seed.sessionTokenHash)

    const tokens = db.db
      .prepare("SELECT user_id FROM ciki_import_tokens")
      .get() as { user_id: number }
    expect(tokens.user_id).toBe(1)
    const readTokens = db.db
      .prepare("SELECT user_id FROM ciki_read_tokens")
      .get() as { user_id: number }
    expect(readTokens.user_id).toBe(2)

    const passkey = db.db
      .prepare("SELECT id, user_id, counter FROM ciki_passkey_credentials")
      .get() as { id: number; user_id: number; counter: number }
    expect(passkey).toMatchObject({ id: 1, user_id: 1, counter: 7 })

    const twofa = db.db
      .prepare("SELECT user_id, totp_secret, totp_enabled FROM ciki_user_2fa")
      .get() as { user_id: number; totp_secret: string; totp_enabled: number }
    expect(twofa.user_id).toBe(1)
    expect(twofa.totp_enabled).toBe(1)
    expect(
      await decryptSecret(TEST_ENCRYPTION_KEY, twofa.totp_secret, "ciki:totp:1")
    ).toBe(TOTP_SECRET)
    await expect(
      decryptSecret(
        TEST_ENCRYPTION_KEY,
        twofa.totp_secret,
        `ciki:totp:${LEGACY_IDS.userAdmin}`
      )
    ).rejects.toThrow()

    const emailCode = db.db
      .prepare("SELECT user_id FROM ciki_email_codes")
      .get() as { user_id: number }
    expect(emailCode.user_id).toBe(1)
    const challenge = db.db
      .prepare("SELECT user_id FROM ciki_auth_challenges")
      .get() as { user_id: number }
    expect(challenge.user_id).toBe(1)

    const avatar = db.db
      .prepare("SELECT avatar_key FROM ciki_users WHERE id = 1")
      .get() as { avatar_key: string }
    expect(avatar.avatar_key).toBe("avatars/old.png")
  })

  it("结构切换干净：正文列与 public_id 消失，临时表不留，索引齐全", async () => {
    const { env, db } = await legacyContext()
    const result = await runSetup(env)
    if (!result.success) throw new Error(result.error)

    expect(columns(db, "ciki_pages")).not.toContain("content_json")
    expect(columns(db, "ciki_pages")).toContain("content_hash")
    expect(columns(db, "ciki_page_revisions")).not.toContain("content_json")
    expect(columns(db, "ciki_page_revisions")).not.toContain("content_gzip")
    expect(columns(db, "ciki_page_revisions")).toContain("version_no")
    expect(columns(db, "ciki_users")).not.toContain("public_id")

    const names = (
      db.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table','index')"
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(names.filter((name) => name.includes("v6_"))).toEqual([])
    for (const index of [
      "ciki_page_revisions_page_version",
      "ciki_pages_space_deleted",
      "ciki_spaces_slug",
      "ciki_pages_content_hash"
    ]) {
      expect(names).toContain(index)
    }
  })

  it("重复 setup 幂等：一字不改、不重复上传、不重复发号", async () => {
    const { env, db, content } = await legacyContext()
    const first = await runSetup(env)
    if (!first.success) throw new Error(first.error)
    const before = {
      pages: db.db.prepare("SELECT COUNT(*) AS c FROM ciki_pages").get(),
      objects: content.store.size,
      hash: db.db
        .prepare("SELECT content_hash FROM ciki_pages WHERE id = 1")
        .get()
    }

    const again = await runSetup(env)
    if (!again.success) throw new Error(again.error)
    expect(again.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v6", status: "skipped" }
    ])
    expect(db.db.prepare("SELECT COUNT(*) AS c FROM ciki_pages").get()).toEqual(
      before.pages
    )
    expect(content.store.size).toBe(before.objects)
    expect(
      db.db.prepare("SELECT content_hash FROM ciki_pages WHERE id = 1").get()
    ).toEqual(before.hash)
  })
})

describe("重建迁移：失败时不动旧数据", () => {
  it("版本 gzip 坏掉 → setup 失败，旧表与账本一字未动", async () => {
    const { env, db } = await legacyContext()
    // 一条解压不了的「已 gzip」版本行：迁移必须在切表前中止。
    await db.db
      .prepare(
        `INSERT INTO ciki_page_revisions
          (id, page_id, title, content_json, content_html, content_text, editor_id, created_at, content_gzip)
         VALUES ('broken-revision', ?, '坏版本', '', '', '', ?, '2026-01-05T00:00:00.000Z', ?)`
      )
      .run(LEGACY_IDS.pageHome, LEGACY_IDS.userAdmin, new Uint8Array([1, 2, 3]))

    // 迁移失败会冒泡到调用方（HTTP 层转 500 并带上原因），账本不记账。
    await expect(runSetup(env)).rejects.toThrow(/gzip/)

    // 旧结构原样：正文列还在、旧 id 还在、账本没有 schema_v6。
    expect(columns(db, "ciki_pages")).toContain("content_json")
    expect(columns(db, "ciki_page_revisions")).toContain("content_gzip")
    const pages = db.db
      .prepare("SELECT id FROM ciki_pages ORDER BY created_at")
      .all() as Array<{ id: string }>
    expect(pages.map((row) => row.id)).toContain(LEGACY_IDS.pageHome)
    const ledger = db.db
      .prepare("SELECT name FROM _ciki_schema_migrations ORDER BY name")
      .all() as Array<{ name: string }>
    expect(ledger.map((row) => row.name)).not.toContain("schema_v6")
    expect(ledger).toHaveLength(5)

    // 旧正文原样在库里（迁移中止前不会清空任何一列）。
    const legacy = db.db
      .prepare("SELECT content_json FROM ciki_page_revisions WHERE id = ?")
      .get(LEGACY_IDS.revisionLegacy) as { content_json: string }
    expect(legacy.content_json).toBe(LEGACY_REVISION_JSON)
    const home = db.db
      .prepare("SELECT content_json FROM ciki_pages WHERE id = ?")
      .get(LEGACY_IDS.pageHome) as { content_json: string }
    expect(home.content_json).toBe(LEGACY_HOME_JSON)
  })
})
