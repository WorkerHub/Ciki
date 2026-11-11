/**
 * 月度 R2 桶治理的端到端测试（图片桶 + 内容桶，共用一套框架、按 kind 分区）：
 *
 * - 图片桶：引用集四类来源（头像 / 页面 HTML / 页面 MD / 版本正文里的 JSON）、30 天门槛、
 *   删除上限与截断、单个失败不中断、20 天幂等兜底、dry_run 只算不删、日志行、
 *   管理接口与 scheduled 的让路；
 * - 内容桶：引用集 = 页面当前正文 ∪ 全部版本（含回收站），只删未引用且 >30 天的对象；
 * - 桶隔离：两边各自只扫自己的桶，图片清理不碰内容对象、内容清理不碰图片对象；
 * - 并发互斥：同 kind 撞锁 409 / 过期接管 / 锁必释放，跨 kind 互不阻塞。
 */
import { describe, expect, it } from "vitest"
import handler from "../src/index"
import {
  CLEANUP_LOCK_TTL_MS,
  DELETE_LIMIT_PER_RUN,
  R2CleanupBusyError,
  runR2Cleanup
} from "../src/core/r2-cleanup"
import { runContentCleanup } from "../src/core/content-cleanup"
import { contentObjectKey, hashContent } from "../src/core/content-store"
import { CLEANUP_LOCK_KEY } from "../src/db/queries/r2-cleanup"
import { gzipText } from "../src/lib/gzip"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"

const DAY_MS = 24 * 60 * 60 * 1000
const UUID = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}.png`

const AVATAR_KEY = UUID(1)
const PAGE_HTML_KEY = UUID(2)
const PAGE_MD_KEY = UUID(3)
const REVISION_KEY = UUID(4)
const TRASHED_KEY = UUID(5)
const OLD_ORPHAN = UUID(6)
const YOUNG_ORPHAN = UUID(7)

type Context = Awaited<ReturnType<typeof initializedContext>>
type Db = Context["db"]
type Bucket = Context["r2"]

function daysAgo(days: number, from = Date.now()): Date {
  return new Date(from - days * DAY_MS)
}

/** 带一个图片引用的正文 JSON。 */
function imageDoc(key: string, extra = ""): string {
  return JSON.stringify({
    type: "doc",
    content: [
      { type: "image", attrs: { src: `/api/files/${key}` } },
      ...(extra
        ? [{ type: "paragraph", content: [{ type: "text", text: extra }] }]
        : [])
    ]
  })
}

/** 直接插页面行：正文只剩 `content_hash` 指针，HTML/MD 是派生件。 */
function insertPage(
  db: Db,
  row: {
    id: number
    contentHash: string
    html?: string
    md?: string
    deletedAt?: string | null
  }
): void {
  const now = new Date().toISOString()
  db.db
    .prepare(
      `INSERT INTO ciki_pages
        (id, space_id, parent_id, title, sort_order, content_hash,
         content_html, content_text, content_md, created_by, updated_by,
         created_at, updated_at, deleted_at)
       VALUES (?, 1, NULL, ?, 0, ?, ?, 'x', ?, 1, 1, ?, ?, ?)`
    )
    .run(
      row.id,
      `p${row.id}`,
      row.contentHash,
      row.html ?? "<p>x</p>",
      row.md ?? "",
      now,
      now,
      row.deletedAt ?? null
    )
}

function insertRevision(
  db: Db,
  row: { id: number; pageId: number; versionNo: number; contentHash: string }
): void {
  db.db
    .prepare(
      `INSERT INTO ciki_page_revisions
        (id, page_id, version_no, title, content_hash, editor_id, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    )
    .run(
      row.id,
      row.pageId,
      row.versionNo,
      `v${row.versionNo}`,
      row.contentHash,
      new Date().toISOString()
    )
}

async function seedImageObject(
  r2: Bucket,
  key: string,
  ageDays = 31
): Promise<void> {
  await r2.putWithUploaded(key, new Uint8Array([1]), daysAgo(ageDays))
}

/** 往内容桶放一份 gzip 正文对象（可指定年龄），返回它的哈希。 */
async function seedContentObject(
  context: Context,
  json: string,
  ageDays = 31
): Promise<string> {
  const hash = await hashContent(json)
  await context.content.putWithUploaded(
    contentObjectKey(hash),
    await gzipText(json),
    daysAgo(ageDays)
  )
  return hash
}

function countRuns(db: Db, kind?: "images" | "content"): number {
  const row = (
    kind
      ? db.db
          .prepare(
            "SELECT COUNT(*) AS count FROM ciki_r2_cleanup_runs WHERE kind = ?"
          )
          .get(kind)
      : db.db
          .prepare("SELECT COUNT(*) AS count FROM ciki_r2_cleanup_runs")
          .get()
  ) as { count: number }
  return row.count
}

function lastRunRow(db: Db, kind: "images" | "content" = "images") {
  return db.db
    .prepare(
      "SELECT * FROM ciki_r2_cleanup_runs WHERE kind = ? ORDER BY rowid DESC LIMIT 1"
    )
    .get(kind) as {
    kind: string
    trigger: string
    status: string
    dry_run: number
    scanned: number
    referenced: number
    deleted: number
    young_skipped: number
    failed: number
    truncated: number
  }
}

/** 直接写一行清理锁：模拟「另一轮正在跑」，或一条过期锁。锁按 kind 分区。 */
function writeLock(
  db: Db,
  ageMs: number,
  overrides: Partial<{ trigger: string; dryRun: boolean; kind: string }> = {}
): void {
  const now = new Date()
  const value = JSON.stringify({
    token: "holder-token",
    startedAt: new Date(now.getTime() - ageMs).toISOString(),
    trigger: overrides.trigger ?? "cron",
    dryRun: overrides.dryRun ?? false
  })
  db.db
    .prepare(
      `INSERT INTO ciki_system_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(
      `${CLEANUP_LOCK_KEY}:${overrides.kind ?? "images"}`,
      value,
      now.toISOString()
    )
}

function clearLock(db: Db, kind = "images"): void {
  db.db
    .prepare("DELETE FROM ciki_system_settings WHERE key = ?")
    .run(`${CLEANUP_LOCK_KEY}:${kind}`)
}

function lockValue(db: Db, kind = "images"): string | undefined {
  const row = db.db
    .prepare("SELECT value FROM ciki_system_settings WHERE key = ?")
    .get(`${CLEANUP_LOCK_KEY}:${kind}`) as { value: string } | undefined
  return row?.value
}

/** 一套「页面 + 版本 + 头像」的引用夹具，图片桶与内容桶都用它。 */
async function seedReferencedContent(context: Context): Promise<{
  htmlHash: string
  revisionHash: string
  trashedHash: string
}> {
  const htmlHash = await seedContentObject(context, imageDoc(PAGE_HTML_KEY))
  const revisionHash = await seedContentObject(context, imageDoc(REVISION_KEY))
  const trashedHash = await seedContentObject(context, imageDoc(TRASHED_KEY))

  insertPage(context.db, {
    id: 1,
    contentHash: htmlHash,
    html: `<p><img src="/api/files/${PAGE_HTML_KEY}"></p>`,
    md: `![](${"/api/files/"}${PAGE_MD_KEY})`
  })
  insertRevision(context.db, {
    id: 1,
    pageId: 1,
    versionNo: 1,
    contentHash: revisionHash
  })
  insertPage(context.db, {
    id: 2,
    contentHash: trashedHash,
    html: `<p><img src="/api/files/${TRASHED_KEY}"></p>`,
    deletedAt: new Date().toISOString()
  })
  return { htmlHash, revisionHash, trashedHash }
}

describe("图片桶：引用集 = 头像 + 页面 HTML/MD + 版本正文 + 回收站", () => {
  it("命中引用集的一律保留，只删「未引用且 >30 天」的对象", async () => {
    const context = await initializedContext()
    const { env, db, r2 } = context
    // 首个注册用户即管理员，下面给它的 avatar_key 写值（上传校验与本单无关）。
    await adminSession(env)
    db.db
      .prepare("UPDATE ciki_users SET avatar_key = ? WHERE id = 1")
      .run(AVATAR_KEY)

    await seedReferencedContent(context)
    for (const key of [
      AVATAR_KEY,
      PAGE_HTML_KEY,
      PAGE_MD_KEY,
      REVISION_KEY,
      TRASHED_KEY
    ]) {
      await seedImageObject(r2, key)
    }
    await seedImageObject(r2, OLD_ORPHAN)
    await seedImageObject(r2, YOUNG_ORPHAN, 1)

    const summary = await runR2Cleanup(env, {
      trigger: "manual",
      dryRun: false,
      rerunGuard: "enforce"
    })

    expect(summary.kind).toBe("images")
    expect(summary.status).toBe("ok")
    expect(summary.scanned).toBe(7)
    expect(summary.referenced).toBe(5)
    expect(summary.deleted).toBe(1)
    expect(summary.youngSkipped).toBe(1)
    expect(summary.failed).toBe(0)
    expect(summary.truncated).toBe(false)

    expect(r2.store.has(OLD_ORPHAN)).toBe(false)
    for (const kept of [
      AVATAR_KEY,
      PAGE_HTML_KEY,
      PAGE_MD_KEY,
      REVISION_KEY,
      TRASHED_KEY,
      YOUNG_ORPHAN
    ]) {
      expect(r2.store.has(kept)).toBe(true)
    }

    const row = lastRunRow(db)
    expect(row.kind).toBe("images")
    expect(row.trigger).toBe("manual")
    expect(row.status).toBe("ok")
    expect(row.dry_run).toBe(0)
    expect(row.scanned).toBe(7)
    expect(row.referenced).toBe(5)
    expect(row.deleted).toBe(1)
    expect(row.young_skipped).toBe(1)
    expect(row.failed).toBe(0)
    expect(row.truncated).toBe(0)
  })

  it("分页：对象数超过单页（MemoryR2 每页 2 条）也全部扫到", async () => {
    const context = await initializedContext()
    const { env, r2 } = context
    const hash = await seedContentObject(context, "<p>plain</p>")
    insertPage(context.db, {
      id: 1,
      contentHash: hash,
      html: `<p><img src="/api/files/${PAGE_HTML_KEY}"></p>`
    })
    await seedImageObject(r2, PAGE_HTML_KEY)
    for (let index = 0; index < 9; index += 1) {
      await seedImageObject(r2, `orphan-${String(index)}.png`)
    }
    const summary = await runR2Cleanup(env, {
      trigger: "manual",
      dryRun: false,
      rerunGuard: "enforce"
    })
    expect(summary.scanned).toBe(10)
    expect(summary.deleted).toBe(9)
    expect(r2.store.has(PAGE_HTML_KEY)).toBe(true)
  })
})

describe("图片桶：key 形状与 #24 的前缀 key 解耦", () => {
  it("正文里的 pages/ 前缀 key（含 %2F 编码）同样算引用", async () => {
    const context = await initializedContext()
    const { env, r2 } = context
    const prefixed = "pages/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png"
    const encoded = "pages/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png"
    const hash = await seedContentObject(context, "<p>plain</p>")
    insertPage(context.db, {
      id: 1,
      contentHash: hash,
      html: `<p><img src="/api/files/${prefixed}"></p>`,
      md: `![](/api/files/${encoded.replace("/", "%2F")})`
    })
    await seedImageObject(r2, prefixed)
    await seedImageObject(r2, encoded)

    const summary = await runR2Cleanup(env, {
      trigger: "manual",
      dryRun: false,
      rerunGuard: "enforce"
    })

    expect(summary.referenced).toBe(2)
    expect(summary.deleted).toBe(0)
    expect(r2.store.has(prefixed)).toBe(true)
    expect(r2.store.has(encoded)).toBe(true)
  })
})

describe("内容桶：引用集 = 页面当前正文 ∪ 全部版本（含回收站）", () => {
  it("未引用且 >30 天的内容对象被删，引用的与年轻的都留下", async () => {
    const context = await initializedContext()
    const { env, content } = context
    const { htmlHash, revisionHash, trashedHash } =
      await seedReferencedContent(context)
    const orphanHash = await seedContentObject(
      context,
      JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] })
    )
    const youngHash = await seedContentObject(
      context,
      JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph", attrs: { a: 1 } }]
      }),
      1
    )

    const summary = await runContentCleanup(env, {
      trigger: "manual",
      dryRun: false,
      rerunGuard: "enforce"
    })

    expect(summary.kind).toBe("content")
    expect(summary.status).toBe("ok")
    expect(summary.scanned).toBe(5)
    expect(summary.referenced).toBe(3)
    expect(summary.deleted).toBe(1)
    expect(summary.youngSkipped).toBe(1)

    expect(content.store.has(contentObjectKey(orphanHash))).toBe(false)
    for (const hash of [htmlHash, revisionHash, trashedHash, youngHash]) {
      expect(content.store.has(contentObjectKey(hash))).toBe(true)
    }
    expect(lastRunRow(context.db, "content").kind).toBe("content")
  })

  it("桶隔离：内容清理不碰图片桶，图片清理不碰内容桶（哪怕内容对象没人引用）", async () => {
    const context = await initializedContext()
    const { env, r2, content } = context
    const orphanHash = await seedContentObject(
      context,
      JSON.stringify({ type: "doc", content: [] })
    )
    // 内容桶里放一个「图片形态」的 key、图片桶里放一个「内容形态」的 key：
    // 两边都只按自己的桶判活，绝不会因为对方没引用就互相删。
    await content.putWithUploaded("loose.png", new Uint8Array([9]), daysAgo(40))
    await r2.putWithUploaded(
      contentObjectKey(orphanHash),
      new Uint8Array([9]),
      daysAgo(40)
    )

    const images = await runR2Cleanup(env, {
      trigger: "manual",
      dryRun: false,
      rerunGuard: "bypass"
    })
    expect(images.deleted).toBe(1)
    expect(r2.store.has(contentObjectKey(orphanHash))).toBe(false)
    expect(content.store.has(contentObjectKey(orphanHash))).toBe(true)
    expect(content.store.has("loose.png")).toBe(true)

    const contentSummary = await runContentCleanup(env, {
      trigger: "manual",
      dryRun: false,
      rerunGuard: "bypass"
    })
    expect(contentSummary.deleted).toBe(2)
    expect(content.store.has(contentObjectKey(orphanHash))).toBe(false)
    expect(content.store.has("loose.png")).toBe(false)
    expect(r2.store.size).toBe(0)
  })
})

describe("dry_run：只算不删", () => {
  it("对象原样保留、删除数是「将删数」，日志 dry_run=1 且不进「最近一轮」", async () => {
    const context = await initializedContext()
    const { env, db, r2 } = context
    await seedImageObject(r2, OLD_ORPHAN)

    const summary = await runR2Cleanup(env, {
      trigger: "manual",
      dryRun: true,
      rerunGuard: "enforce"
    })

    expect(summary.dryRun).toBe(true)
    expect(summary.deleted).toBe(1)
    expect(r2.store.has(OLD_ORPHAN)).toBe(true)

    const row = lastRunRow(db)
    expect(row.dry_run).toBe(1)

    const cookie = await adminSession(env)
    const res = await request(env, "/api/admin/r2-cleanup", {
      headers: { cookie }
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { lastRun: unknown }).toEqual({
      kind: "images",
      lastRun: null,
      running: null
    })
  })
})

describe("防双跑：20 天幂等兜底", () => {
  function seedRun(db: Db, ageDays: number, kind = "images"): void {
    db.db
      .prepare(
        `INSERT INTO ciki_r2_cleanup_runs
          (kind, started_at, finished_at, trigger, status, dry_run,
           scanned, referenced, deleted, young_skipped, failed, truncated)
         VALUES (?, ?, ?, 'cron', 'ok', 0, 0, 0, 0, 0, 0, 0)`
      )
      .run(kind, daysAgo(ageDays).toISOString(), daysAgo(ageDays).toISOString())
  }

  it("19 天前成功过 → 真实触发写一行 skipped 并什么也不删；dry_run 照常执行", async () => {
    const context = await initializedContext()
    const { env, db, r2 } = context
    await seedImageObject(r2, OLD_ORPHAN)
    seedRun(db, 19)

    const skipped = await runR2Cleanup(env, {
      trigger: "cron",
      dryRun: false,
      rerunGuard: "enforce"
    })
    expect(skipped.status).toBe("skipped")
    expect(skipped.deleted).toBe(0)
    expect(r2.store.has(OLD_ORPHAN)).toBe(true)
    expect(countRuns(db)).toBe(2)
    expect(lastRunRow(db).status).toBe("skipped")

    const dry = await runR2Cleanup(env, {
      trigger: "manual",
      dryRun: true,
      rerunGuard: "enforce"
    })
    expect(dry.status).toBe("ok")
    expect(dry.deleted).toBe(1)
  })

  it("21 天前成功过 → 正常执行，对象被删", async () => {
    const context = await initializedContext()
    const { env, db, r2 } = context
    await seedImageObject(r2, OLD_ORPHAN)
    seedRun(db, 21)

    const summary = await runR2Cleanup(env, {
      trigger: "waker",
      dryRun: false,
      rerunGuard: "enforce"
    })
    expect(summary.status).toBe("ok")
    expect(summary.deleted).toBe(1)
    expect(r2.store.has(OLD_ORPHAN)).toBe(false)
    expect(lastRunRow(db).trigger).toBe("waker")
  })

  it("闸按 kind 分区：图片 19 天前跑过不影响内容桶照常跑", async () => {
    const context = await initializedContext()
    const { env, content } = context
    const orphanHash = await seedContentObject(
      context,
      JSON.stringify({ type: "doc", content: [] })
    )
    seedRun(context.db, 19, "images")

    const summary = await runContentCleanup(env, {
      trigger: "cron",
      dryRun: false,
      rerunGuard: "enforce"
    })
    expect(summary.status).toBe("ok")
    expect(summary.deleted).toBe(1)
    expect(content.store.has(contentObjectKey(orphanHash))).toBe(false)
  })
})

describe("执行安全：删除上限与单个失败", () => {
  it(`超过 ${DELETE_LIMIT_PER_RUN} 个候选时只删上限并标 truncated`, async () => {
    const context = await initializedContext()
    const { env, db, r2 } = context
    const total = DELETE_LIMIT_PER_RUN + 5
    for (let index = 0; index < total; index += 1) {
      await seedImageObject(r2, `orphan-${String(index).padStart(4, "0")}.png`)
    }

    const summary = await runR2Cleanup(env, {
      trigger: "manual",
      dryRun: false,
      rerunGuard: "enforce"
    })

    expect(summary.scanned).toBe(total)
    expect(summary.deleted).toBe(DELETE_LIMIT_PER_RUN)
    expect(summary.truncated).toBe(true)
    expect(r2.store.size).toBe(total - DELETE_LIMIT_PER_RUN)
    expect(lastRunRow(db).truncated).toBe(1)
  })

  it("单个删除失败不中断整轮，失败计入日志", async () => {
    const context = await initializedContext()
    const { env, db, r2 } = context
    await seedImageObject(r2, "broken.png")
    await seedImageObject(r2, "fine.png")
    r2.failDeleteKeys.add("broken.png")

    const summary = await runR2Cleanup(env, {
      trigger: "manual",
      dryRun: false,
      rerunGuard: "enforce"
    })

    expect(summary.status).toBe("ok")
    expect(summary.deleted).toBe(1)
    expect(summary.failed).toBe(1)
    expect(r2.store.has("broken.png")).toBe(true)
    expect(r2.store.has("fine.png")).toBe(false)
    expect(lastRunRow(db).failed).toBe(1)
  })
})

describe("管理接口：手动触发与摘要", () => {
  it("非管理员 403；dryRun 只算不删；GET 给出「最近一轮」", async () => {
    const context = await initializedContext()
    const { env, r2 } = context
    const admin = await adminSession(env)
    const user = await userSession(env, admin)
    await seedImageObject(r2, OLD_ORPHAN)

    const forbidden = await request(env, "/api/admin/r2-cleanup", {
      method: "POST",
      headers: { cookie: user, "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true })
    })
    expect(forbidden.status).toBe(403)

    const dry = await jsonRequest(
      env,
      "POST",
      "/api/admin/r2-cleanup",
      { dryRun: true },
      admin
    )
    expect(dry.status).toBe(200)
    const dryBody = (await dry.json()) as { dryRun: boolean; deleted: number }
    expect(dryBody.dryRun).toBe(true)
    expect(dryBody.deleted).toBe(1)
    expect(r2.store.has(OLD_ORPHAN)).toBe(true)

    const before = await request(env, "/api/admin/r2-cleanup", {
      headers: { cookie: admin }
    })
    expect((await before.json()) as { lastRun: unknown }).toEqual({
      kind: "images",
      lastRun: null,
      running: null
    })

    const real = await jsonRequest(
      env,
      "POST",
      "/api/admin/r2-cleanup",
      {},
      admin
    )
    expect(real.status).toBe(200)
    expect(r2.store.has(OLD_ORPHAN)).toBe(false)

    const after = await request(env, "/api/admin/r2-cleanup", {
      headers: { cookie: admin }
    })
    const afterBody = (await after.json()) as {
      lastRun: {
        trigger: string
        status: string
        dryRun: boolean
        scanned: number
        deleted: number
      } | null
    }
    expect(afterBody.lastRun).not.toBeNull()
    expect(afterBody.lastRun?.trigger).toBe("manual")
    expect(afterBody.lastRun?.status).toBe("ok")
    expect(afterBody.lastRun?.dryRun).toBe(false)
    expect(afterBody.lastRun?.scanned).toBe(1)
    expect(afterBody.lastRun?.deleted).toBe(1)
  })

  it("kind=content 走内容桶；不传 kind 仍是图片桶（老调用不变）", async () => {
    const context = await initializedContext()
    const { env, r2, content } = context
    const admin = await adminSession(env)
    const orphanHash = await seedContentObject(
      context,
      JSON.stringify({ type: "doc", content: [] })
    )
    await seedImageObject(r2, OLD_ORPHAN)

    const images = await jsonRequest(
      env,
      "POST",
      "/api/admin/r2-cleanup",
      {},
      admin
    )
    expect(((await images.json()) as { kind: string }).kind).toBe("images")
    expect(r2.store.has(OLD_ORPHAN)).toBe(false)
    expect(content.store.has(contentObjectKey(orphanHash))).toBe(true)

    const contents = await jsonRequest(
      env,
      "POST",
      "/api/admin/r2-cleanup",
      { kind: "content" },
      admin
    )
    const body = (await contents.json()) as { kind: string; deleted: number }
    expect(body.kind).toBe("content")
    expect(body.deleted).toBe(1)
    expect(content.store.has(contentObjectKey(orphanHash))).toBe(false)

    // GET 的 kind 决定读哪一类日志。
    const got = await request(env, "/api/admin/r2-cleanup?kind=content", {
      headers: { cookie: admin }
    })
    const gotBody = (await got.json()) as { kind: string; lastRun: unknown }
    expect(gotBody.kind).toBe("content")
    expect(gotBody.lastRun).not.toBeNull()
  })
})

describe("scheduled：两个入口按 WAKER_SIGNING_KEY 有无让路", () => {
  it("配了 key → 直接跳过，不跑也不写日志行", async () => {
    const context = await initializedContext({
      WAKER_SIGNING_KEY: "unit-test-signing-key"
    })
    const { env, db, r2 } = context
    await seedImageObject(r2, OLD_ORPHAN)

    await handler.scheduled!(
      {} as ScheduledController,
      env,
      {} as ExecutionContext
    )

    expect(countRuns(db)).toBe(0)
    expect(r2.store.has(OLD_ORPHAN)).toBe(true)
  })

  it("没配 key → 走 Cron 入口把两个桶各跑一轮并落日志", async () => {
    const context = await initializedContext()
    const { env, db, r2, content } = context
    const orphanHash = await seedContentObject(
      context,
      JSON.stringify({ type: "doc", content: [] })
    )
    await seedImageObject(r2, OLD_ORPHAN)

    await handler.scheduled!(
      {} as ScheduledController,
      env,
      {} as ExecutionContext
    )

    expect(countRuns(db, "images")).toBe(1)
    expect(countRuns(db, "content")).toBe(1)
    expect(lastRunRow(db, "images").trigger).toBe("cron")
    expect(lastRunRow(db, "content").trigger).toBe("cron")
    expect(r2.store.has(OLD_ORPHAN)).toBe(false)
    expect(content.store.has(contentObjectKey(orphanHash))).toBe(false)
  })
})

describe("并发互斥：同一时刻只许一轮", () => {
  it("同类另一轮持锁时手动接口 409 CLEANUP_IN_PROGRESS、不扫不删不写日志行；释放后恢复", async () => {
    const context = await initializedContext()
    const { env, db, r2 } = context
    const admin = await adminSession(env)
    await seedImageObject(r2, OLD_ORPHAN)
    writeLock(db, 0, { trigger: "cron" })

    const dry = await jsonRequest(
      env,
      "POST",
      "/api/admin/r2-cleanup",
      { dryRun: true },
      admin
    )
    expect(dry.status).toBe(409)
    const dryBody = (await dry.json()) as {
      error: string
      code: string
      retryAfter: number
    }
    expect(dryBody.code).toBe("CLEANUP_IN_PROGRESS")
    expect(dryBody.retryAfter).toBeGreaterThan(0)

    const real = await jsonRequest(
      env,
      "POST",
      "/api/admin/r2-cleanup",
      {},
      admin
    )
    expect(real.status).toBe(409)

    expect(countRuns(db)).toBe(0)
    expect(r2.store.has(OLD_ORPHAN)).toBe(true)

    clearLock(db)
    const ok = await jsonRequest(
      env,
      "POST",
      "/api/admin/r2-cleanup",
      {},
      admin
    )
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { deleted: number }).deleted).toBe(1)
    expect(r2.store.has(OLD_ORPHAN)).toBe(false)
  })

  it("跨 kind 不互相阻塞：图片持锁时内容清理照常跑", async () => {
    const context = await initializedContext()
    const { env, db } = context
    const admin = await adminSession(env)
    const orphanHash = await seedContentObject(
      context,
      JSON.stringify({ type: "doc", content: [] })
    )
    writeLock(db, 0, { trigger: "cron" })

    const res = await jsonRequest(
      env,
      "POST",
      "/api/admin/r2-cleanup",
      { kind: "content" },
      admin
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { deleted: number }).deleted).toBe(1)
    expect(context.content.store.has(contentObjectKey(orphanHash))).toBe(false)
    // 图片那把锁还在（不是自己抢的，不释放）。
    expect(lockValue(db, "images")).toBeDefined()
  })

  it("同一时刻并发发起两轮：只有一个跑，另一个直接判忙（不扫不删）", async () => {
    const context = await initializedContext()
    const { env, db, r2 } = context
    await seedImageObject(r2, OLD_ORPHAN)

    const results = await Promise.allSettled([
      runR2Cleanup(env, {
        trigger: "cron",
        dryRun: false,
        rerunGuard: "enforce"
      }),
      runR2Cleanup(env, {
        trigger: "manual",
        dryRun: false,
        rerunGuard: "bypass"
      })
    ])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const reason = (rejected[0] as PromiseRejectedResult).reason
    expect(reason).toBeInstanceOf(R2CleanupBusyError)
    expect((reason as R2CleanupBusyError).retryAfterSeconds).toBeGreaterThan(0)
    expect(countRuns(db)).toBe(1)
    expect(lockValue(db)).toBeUndefined()
    expect(r2.store.has(OLD_ORPHAN)).toBe(false)
  })

  it("锁过期（超过 TTL）可被接管，跑完锁行消失", async () => {
    const context = await initializedContext()
    const { env, db, r2 } = context
    const admin = await adminSession(env)
    await seedImageObject(r2, OLD_ORPHAN)
    writeLock(db, CLEANUP_LOCK_TTL_MS + 60_000)

    const res = await jsonRequest(
      env,
      "POST",
      "/api/admin/r2-cleanup",
      {},
      admin
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { status: string }).status).toBe("ok")
    expect(r2.store.has(OLD_ORPHAN)).toBe(false)
    expect(lockValue(db)).toBeUndefined()
  })

  it("跑完与扫描异常都释放锁：异常那轮仍落一行 failed", async () => {
    const context = await initializedContext()
    const { env, db, r2, content } = context
    await seedImageObject(r2, OLD_ORPHAN)

    const ok = await runR2Cleanup(env, {
      trigger: "manual",
      dryRun: false,
      rerunGuard: "bypass"
    })
    expect(ok.status).toBe("ok")
    expect(lockValue(db)).toBeUndefined()

    // 坏 gzip 内容对象：解压抛错 → 整轮 failed，锁同样不能留下。
    const badHash = "f".repeat(64)
    await content.putWithUploaded(
      contentObjectKey(badHash),
      new Uint8Array([1, 2, 3, 4]),
      daysAgo(40)
    )
    insertPage(context.db, { id: 9, contentHash: badHash })
    insertRevision(context.db, {
      id: 9,
      pageId: 9,
      versionNo: 1,
      contentHash: badHash
    })

    await expect(
      runR2Cleanup(env, {
        trigger: "manual",
        dryRun: false,
        rerunGuard: "bypass"
      })
    ).rejects.toThrow()
    expect(lastRunRow(db).status).toBe("failed")
    expect(lockValue(db)).toBeUndefined()
  })
})

describe("手动实跑：绕过 20 天闸，自动入口照旧受闸", () => {
  it("19 天前成功过 → POST 真跑仍执行并删除；随后 scheduled 仍写 skipped", async () => {
    const context = await initializedContext()
    const { env, db, r2 } = context
    const admin = await adminSession(env)
    await seedImageObject(r2, OLD_ORPHAN)
    db.db
      .prepare(
        `INSERT INTO ciki_r2_cleanup_runs
          (kind, started_at, finished_at, trigger, status, dry_run,
           scanned, referenced, deleted, young_skipped, failed, truncated)
         VALUES ('images', ?, ?, 'cron', 'ok', 0, 3, 0, 0, 0, 0, 0)`
      )
      .run(daysAgo(19).toISOString(), daysAgo(19).toISOString())

    const res = await jsonRequest(
      env,
      "POST",
      "/api/admin/r2-cleanup",
      {},
      admin
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      status: string
      deleted: number
      trigger: string
    }
    expect(body.status).toBe("ok")
    expect(body.trigger).toBe("manual")
    expect(body.deleted).toBe(1)
    expect(r2.store.has(OLD_ORPHAN)).toBe(false)

    // 手动轮已写入「最近一次成功」，自动入口照旧在 20 天窗口内跳过（闸只约束自动入口）。
    await handler.scheduled!(
      {} as ScheduledController,
      env,
      {} as ExecutionContext
    )
    expect(lastRunRow(db, "images").status).toBe("skipped")
    expect(lastRunRow(db, "images").trigger).toBe("cron")
  })
})

describe("dry run：可清理数与总大小（不受单轮上限截断）", () => {
  it("超过删除上限时 prunable 给全量、deleted 仍只到上限；真跑响应不含这两个字段", async () => {
    const context = await initializedContext()
    const { env, r2 } = context
    const total = DELETE_LIMIT_PER_RUN + 5
    for (let index = 0; index < total; index += 1) {
      await seedImageObject(r2, `orphan-${String(index).padStart(4, "0")}.png`)
    }

    const dry = await runR2Cleanup(env, {
      trigger: "manual",
      dryRun: true,
      rerunGuard: "bypass"
    })
    if (!dry.dryRun) throw new Error("dry run must report dryRun: true")
    expect(dry.prunable).toBe(total)
    expect(dry.prunableBytes).toBe(total) // 每个对象 1 字节
    expect(dry.deleted).toBe(DELETE_LIMIT_PER_RUN)
    expect(dry.truncated).toBe(true)

    const real = await runR2Cleanup(env, {
      trigger: "manual",
      dryRun: false,
      rerunGuard: "bypass"
    })
    expect(real.dryRun).toBe(false)
    expect("prunable" in real).toBe(false)
    expect("prunableBytes" in real).toBe(false)
    expect(real.deleted).toBe(DELETE_LIMIT_PER_RUN)
    expect(real.truncated).toBe(true)
  })

  it("空桶：prunable 与 prunableBytes 都是 0", async () => {
    const context = await initializedContext()
    const dry = await runR2Cleanup(context.env, {
      trigger: "manual",
      dryRun: true,
      rerunGuard: "bypass"
    })
    if (!dry.dryRun) throw new Error("dry run must report dryRun: true")
    expect(dry.prunable).toBe(0)
    expect(dry.prunableBytes).toBe(0)

    const contentDry = await runContentCleanup(context.env, {
      trigger: "manual",
      dryRun: true,
      rerunGuard: "bypass"
    })
    if (!contentDry.dryRun) throw new Error("dry run must report dryRun: true")
    expect(contentDry.prunable).toBe(0)
    expect(contentDry.prunableBytes).toBe(0)
  })
})

describe("运行态：GET 的 running", () => {
  it("无锁 → null；持锁 → 与 409 同一算法；过期 → null 且可接管", async () => {
    const context = await initializedContext()
    const { env, db } = context
    const admin = await adminSession(env)
    const getIdle = () =>
      request(env, "/api/admin/r2-cleanup", { headers: { cookie: admin } })

    expect((await (await getIdle()).json()) as unknown).toEqual({
      kind: "images",
      lastRun: null,
      running: null
    })

    writeLock(db, 0, { trigger: "manual", dryRun: true })
    const busy = (await (await getIdle()).json()) as {
      running: {
        startedAt: string
        trigger: string
        dryRun: boolean
        retryAfter: number
      } | null
    }
    expect(busy.running?.trigger).toBe("manual")
    expect(busy.running?.dryRun).toBe(true)
    expect(busy.running?.retryAfter).toBeGreaterThan(0)

    const conflict = await jsonRequest(
      env,
      "POST",
      "/api/admin/r2-cleanup",
      { dryRun: true },
      admin
    )
    expect(conflict.status).toBe(409)
    const conflictBody = (await conflict.json()) as { retryAfter: number }
    // 同一个 TTL 判定，两处只差调用之间流逝的毫秒数（跨秒边界时差 1）。
    expect(conflictBody.retryAfter).toBeLessThanOrEqual(
      busy.running?.retryAfter ?? 0
    )
    expect(conflictBody.retryAfter).toBeGreaterThanOrEqual(
      (busy.running?.retryAfter ?? 0) - 1
    )

    writeLock(db, CLEANUP_LOCK_TTL_MS + 60_000, { trigger: "waker" })
    const stale = (await (await getIdle()).json()) as { running: unknown }
    expect(stale.running).toBeNull()
  })
})

describe("存储口径：管理面 /storage（本库体积 + 页数）", () => {
  it("页数/版本数/用户数取自 D1，体积标注 own-database", async () => {
    const context = await initializedContext()
    const { env } = context
    const admin = await adminSession(env)
    const { htmlHash } = await seedReferencedContent(context)

    const res = await request(env, "/api/admin/storage", {
      headers: { cookie: admin }
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      pageCount: number
      trashedPageCount: number
      revisionCount: number
      spaceCount: number
      userCount: number
      databaseSizeBytes: number | null
      sizeScope: string
      measure: string
    }
    expect(body.pageCount).toBe(1)
    expect(body.trashedPageCount).toBe(1)
    expect(body.revisionCount).toBe(1)
    expect(body.spaceCount).toBe(1)
    expect(body.userCount).toBe(1)
    // Ciki 的 D1 是独占库（非共享库）：体积口径标注为本库。
    expect(body.sizeScope).toBe("own-database")
    expect(body.measure).toBe("sqlite-page-count")
    expect(typeof body.databaseSizeBytes).toBe("number")
    expect(body.databaseSizeBytes).toBeGreaterThan(0)
    expect(htmlHash).toHaveLength(64)
  })
})
