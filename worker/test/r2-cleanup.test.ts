/**
 * 月度 R2 孤儿清理（规格 §3）的端到端测试：
 * 引用集四类来源、30 天门槛、删除上限与截断、单个失败不中断、20 天幂等兜底、
 * dry_run 只算不删、日志行、管理接口与 scheduled 的让路；
 * 手动入口另测：并发互斥（撞锁 409 / 过期接管 / 锁必释放）、绕过 20 天闸、
 * dry run 的可清理数与总大小、GET 的运行态。
 */
import { describe, expect, it } from "vitest"
import handler from "../src/index"
import {
  CLEANUP_LOCK_TTL_MS,
  DELETE_LIMIT_PER_RUN,
  runR2Cleanup
} from "../src/core/r2-cleanup"
import { CLEANUP_LOCK_KEY } from "../src/db/queries/r2-cleanup"
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
const PAGE_JSON_KEY = UUID(2)
const PAGE_HTML_KEY = UUID(3)
const REVISION_KEY = UUID(4)
const TRASHED_KEY = UUID(5)
const OLD_ORPHAN = UUID(6)
const YOUNG_ORPHAN = UUID(7)

type Db = Awaited<ReturnType<typeof initializedContext>>["db"]

function daysAgo(days: number, from = Date.now()): Date {
  return new Date(from - days * DAY_MS)
}

/** 直接插页面行（正文里带 /api/files/<key> 引用），绕开消毒以覆盖 JSON+HTML 两种形态。 */
function insertPage(
  db: Db,
  id: string,
  keys: { json?: string; html?: string },
  deletedAt: string | null = null
): void {
  const now = new Date().toISOString()
  const json = JSON.stringify({
    type: "doc",
    content: keys.json
      ? [{ type: "image", attrs: { src: `/api/files/${keys.json}` } }]
      : []
  })
  const html = keys.html
    ? `<p><img src="/api/files/${keys.html}"></p>`
    : "<p>x</p>"
  db.db
    .prepare(
      `INSERT INTO ciki_pages
        (id, parent_id, title, sort_order, content_json, content_html, content_text,
         created_by, updated_by, created_at, updated_at, deleted_at)
       VALUES (?, NULL, ?, 0, ?, ?, 'x', 'u1', 'u1', ?, ?, ?)`
    )
    .run(id, id, json, html, now, now, deletedAt)
}

function insertRevision(
  db: Db,
  id: string,
  pageId: string,
  keyRef: string
): void {
  db.db
    .prepare(
      `INSERT INTO ciki_page_revisions
        (id, page_id, title, content_json, content_html, content_text, editor_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'x', 'u1', ?)`
    )
    .run(
      id,
      pageId,
      id,
      JSON.stringify({ type: "doc" }),
      `<p><img src="/api/files/${keyRef}"></p>`,
      new Date().toISOString()
    )
}

/** 新形态的版本行：只存 gzip 的 JSON，三列文本为空串（与线上写入路径一致）。 */
async function insertGzipRevision(
  db: Db,
  id: string,
  pageId: string,
  keyRef: string
): Promise<void> {
  const { gzipText } = await import("../src/lib/gzip")
  const json = JSON.stringify({
    type: "doc",
    content: [{ type: "image", attrs: { src: `/api/files/${keyRef}` } }]
  })
  db.db
    .prepare(
      `INSERT INTO ciki_page_revisions
        (id, page_id, title, content_json, content_html, content_text,
         editor_id, created_at, content_gzip)
       VALUES (?, ?, ?, '', '', '', 'u1', ?, ?)`
    )
    .run(id, pageId, id, new Date().toISOString(), await gzipText(json))
}

async function seedOldObject(
  r2: Awaited<ReturnType<typeof initializedContext>>["r2"],
  key: string,
  ageDays = 31
): Promise<void> {
  await r2.putWithUploaded(key, new Uint8Array([1]), daysAgo(ageDays))
}

function countRuns(db: Db): number {
  const row = db.db
    .prepare("SELECT COUNT(*) AS count FROM ciki_r2_cleanup_runs")
    .get() as { count: number }
  return row.count
}

function lastRunRow(db: Db) {
  return db.db
    .prepare("SELECT * FROM ciki_r2_cleanup_runs ORDER BY rowid DESC LIMIT 1")
    .get() as {
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

/** 直接写一行清理锁：模拟「另一轮正在跑」，或一条过期锁。 */
function writeLock(
  db: Db,
  ageMs: number,
  overrides: Partial<{ trigger: string; dryRun: boolean }> = {}
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
    .run(CLEANUP_LOCK_KEY, value, now.toISOString())
}

function clearLock(db: Db): void {
  db.db
    .prepare("DELETE FROM ciki_system_settings WHERE key = ?")
    .run(CLEANUP_LOCK_KEY)
}

function lockValue(db: Db): string | undefined {
  const row = db.db
    .prepare("SELECT value FROM ciki_system_settings WHERE key = ?")
    .get(CLEANUP_LOCK_KEY) as { value: string } | undefined
  return row?.value
}

describe("引用集：头像 + 页面当前版本（JSON/HTML）+ 历史版本 + 回收站", () => {
  it("命中引用集的一律保留，只删「未引用且 >30 天」的对象", async () => {
    const { env, db, r2 } = await initializedContext()
    // 首个注册用户即管理员，下面给它的 avatar_key 写值（上传校验与本单无关）。
    await adminSession(env)

    // 头像：引用集只读 users.avatar_key，这里直接写库。
    await seedOldObject(r2, AVATAR_KEY)
    db.db
      .prepare("UPDATE ciki_users SET avatar_key = ? WHERE email = ?")
      .run(AVATAR_KEY, "admin@example.com")

    insertPage(db, "p-json", { json: PAGE_JSON_KEY })
    insertPage(db, "p-html", { html: PAGE_HTML_KEY })
    insertPage(db, "p-trash", { html: TRASHED_KEY }, new Date().toISOString())
    insertRevision(db, "r-1", "p-html", REVISION_KEY)

    for (const key of [
      PAGE_JSON_KEY,
      PAGE_HTML_KEY,
      REVISION_KEY,
      TRASHED_KEY
    ]) {
      await seedOldObject(r2, key)
    }
    await seedOldObject(r2, OLD_ORPHAN)
    await seedOldObject(r2, YOUNG_ORPHAN, 1)

    const summary = await runR2Cleanup(env, {
      trigger: "manual",
      dryRun: false,
      rerunGuard: "enforce"
    })

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
      PAGE_JSON_KEY,
      PAGE_HTML_KEY,
      REVISION_KEY,
      TRASHED_KEY,
      YOUNG_ORPHAN
    ]) {
      expect(r2.store.has(kept)).toBe(true)
    }

    const row = lastRunRow(db)
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
    const { env, db, r2 } = await initializedContext()
    insertPage(db, "p-only", { html: PAGE_HTML_KEY })
    await seedOldObject(r2, PAGE_HTML_KEY)
    for (let index = 0; index < 9; index += 1) {
      await seedOldObject(r2, `orphan-${index}.png`)
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

describe("引用集：key 形状与 #24 的前缀 key 解耦", () => {
  it("正文里的 pages/ 前缀 key（含 %2F 编码）同样算引用", async () => {
    const { env, db, r2 } = await initializedContext()
    const prefixed = "pages/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png"
    const encoded = "pages/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png"
    insertPage(db, "p-prefixed", { json: prefixed })
    insertPage(db, "p-encoded", { html: encoded.replace("/", "%2F") })
    await seedOldObject(r2, prefixed)
    await seedOldObject(r2, encoded)

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

describe("引用集：gzip 化的版本行同样算引用（迁移前后口径一致）", () => {
  it("解压后从 JSON 提取 key：迁移前（旧三列）与迁移后（gzip）引用集相同", async () => {
    const before = await initializedContext()
    const after = await initializedContext()
    await adminSession(before.env)
    await adminSession(after.env)

    // 同一条内容，两种落库形态：迁移前存三列文本，迁移后只剩 gzip 的 JSON。
    insertRevision(before.db, "r-gzip", "p-1", REVISION_KEY)
    await insertGzipRevision(after.db, "r-gzip", "p-1", REVISION_KEY)

    const beforeSummary = await runR2Cleanup(before.env, {
      trigger: "manual",
      dryRun: true,
      rerunGuard: "enforce"
    })
    const afterSummary = await runR2Cleanup(after.env, {
      trigger: "manual",
      dryRun: true,
      rerunGuard: "enforce"
    })

    expect(afterSummary.referenced).toBe(beforeSummary.referenced)
    expect(afterSummary.referenced).toBe(1)

    // 已迁移的引用对象都不会被删。
    await seedOldObject(before.r2, REVISION_KEY)
    await seedOldObject(after.r2, REVISION_KEY)
    const real = await runR2Cleanup(after.env, {
      trigger: "manual",
      dryRun: false,
      rerunGuard: "enforce"
    })
    expect(real.deleted).toBe(0)
    expect(after.r2.store.has(REVISION_KEY)).toBe(true)
  })
})

describe("dry_run：只算不删", () => {
  it("对象原样保留、删除数是「将删数」，日志 dry_run=1 且不进「最近一轮」", async () => {
    const { env, db, r2 } = await initializedContext()
    await seedOldObject(r2, OLD_ORPHAN)

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
    // GET 形状按冻结契约多了 running（此刻无锁 → null），lastRun 口径不变。
    expect((await res.json()) as { lastRun: unknown }).toEqual({
      lastRun: null,
      running: null
    })
  })
})

describe("防双跑：20 天幂等兜底", () => {
  it("19 天前成功过 → 真实触发写一行 skipped 并什么也不删；dry_run 照常执行", async () => {
    const { env, db, r2 } = await initializedContext()
    await seedOldObject(r2, OLD_ORPHAN)
    db.db
      .prepare(
        `INSERT INTO ciki_r2_cleanup_runs
          (id, started_at, finished_at, trigger, status, dry_run,
           scanned, referenced, deleted, young_skipped, failed, truncated)
         VALUES ('seed', ?, ?, 'cron', 'ok', 0, 3, 0, 0, 0, 0, 0)`
      )
      .run(daysAgo(19).toISOString(), daysAgo(19).toISOString())

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
    const { env, db, r2 } = await initializedContext()
    await seedOldObject(r2, OLD_ORPHAN)
    db.db
      .prepare(
        `INSERT INTO ciki_r2_cleanup_runs
          (id, started_at, finished_at, trigger, status, dry_run,
           scanned, referenced, deleted, young_skipped, failed, truncated)
         VALUES ('seed', ?, ?, 'cron', 'ok', 0, 0, 0, 0, 0, 0, 0)`
      )
      .run(daysAgo(21).toISOString(), daysAgo(21).toISOString())

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
})

describe("执行安全：删除上限与单个失败", () => {
  it(`超过 ${DELETE_LIMIT_PER_RUN} 个候选时只删上限并标 truncated`, async () => {
    const { env, db, r2 } = await initializedContext()
    const total = DELETE_LIMIT_PER_RUN + 5
    for (let index = 0; index < total; index += 1) {
      await seedOldObject(r2, `orphan-${String(index).padStart(4, "0")}.png`)
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
    const { env, db, r2 } = await initializedContext()
    await seedOldObject(r2, "broken.png")
    await seedOldObject(r2, "fine.png")
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
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)
    await seedOldObject(r2, OLD_ORPHAN)

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
        startedAt: string
        finishedAt: string
        trigger: string
        status: string
        dryRun: boolean
        scanned: number
        referenced: number
        deleted: number
        youngSkipped: number
        failed: number
        truncated: boolean
      } | null
    }
    expect(afterBody.lastRun).not.toBeNull()
    expect(afterBody.lastRun?.trigger).toBe("manual")
    expect(afterBody.lastRun?.status).toBe("ok")
    expect(afterBody.lastRun?.dryRun).toBe(false)
    expect(afterBody.lastRun?.scanned).toBe(1)
    expect(afterBody.lastRun?.deleted).toBe(1)
  })
})

describe("scheduled：两个入口按 WAKER_SIGNING_KEY 有无让路", () => {
  it("配了 key → 直接跳过，不跑也不写日志行", async () => {
    const { env, db, r2 } = await initializedContext({
      WAKER_SIGNING_KEY: "unit-test-signing-key"
    })
    await seedOldObject(r2, OLD_ORPHAN)

    await handler.scheduled!(
      {} as ScheduledController,
      env,
      {} as ExecutionContext
    )

    expect(countRuns(db)).toBe(0)
    expect(r2.store.has(OLD_ORPHAN)).toBe(true)
  })

  it("没配 key → 走 Cron 入口跑一轮并落日志", async () => {
    const { env, db, r2 } = await initializedContext()
    await seedOldObject(r2, OLD_ORPHAN)

    await handler.scheduled!(
      {} as ScheduledController,
      env,
      {} as ExecutionContext
    )

    expect(countRuns(db)).toBe(1)
    expect(lastRunRow(db).trigger).toBe("cron")
    expect(r2.store.has(OLD_ORPHAN)).toBe(false)
  })
})

describe("并发互斥：同一时刻只许一轮", () => {
  it("另一轮持锁时手动接口 409 CLEANUP_IN_PROGRESS、不扫不删不写日志行；释放后恢复", async () => {
    const { env, db, r2 } = await initializedContext()
    const admin = await adminSession(env)
    await seedOldObject(r2, OLD_ORPHAN)
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

  it("锁过期（超过 TTL）可被接管，跑完锁行消失", async () => {
    const { env, db, r2 } = await initializedContext()
    const admin = await adminSession(env)
    await seedOldObject(r2, OLD_ORPHAN)
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
    const { env, db, r2 } = await initializedContext()
    await seedOldObject(r2, OLD_ORPHAN)

    const ok = await runR2Cleanup(env, {
      trigger: "manual",
      dryRun: false,
      rerunGuard: "bypass"
    })
    expect(ok.status).toBe("ok")
    expect(lockValue(db)).toBeUndefined()

    // 坏 gzip 版本行：解压抛错 → 整轮 failed，锁同样不能留下。
    db.db
      .prepare(
        `INSERT INTO ciki_page_revisions
          (id, page_id, title, content_json, content_html, content_text,
           editor_id, created_at, content_gzip)
         VALUES ('bad-revision', 'p1', 'bad', '', '', '', 'u1', ?, ?)`
      )
      .run(new Date().toISOString(), new Uint8Array([1, 2, 3, 4]))

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
    const { env, db, r2 } = await initializedContext()
    const admin = await adminSession(env)
    await seedOldObject(r2, OLD_ORPHAN)
    db.db
      .prepare(
        `INSERT INTO ciki_r2_cleanup_runs
          (id, started_at, finished_at, trigger, status, dry_run,
           scanned, referenced, deleted, young_skipped, failed, truncated)
         VALUES ('seed', ?, ?, 'cron', 'ok', 0, 3, 0, 0, 0, 0, 0)`
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
    expect(lastRunRow(db).status).toBe("skipped")
    expect(lastRunRow(db).trigger).toBe("cron")
  })
})

describe("dry run：可清理数与总大小（不受单轮上限截断）", () => {
  it("超过删除上限时 prunable 给全量、deleted 仍只到上限；真跑响应不含这两个字段", async () => {
    const { env, r2 } = await initializedContext()
    const total = DELETE_LIMIT_PER_RUN + 5
    for (let index = 0; index < total; index += 1) {
      await seedOldObject(r2, `orphan-${String(index).padStart(4, "0")}.png`)
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
    const { env } = await initializedContext()
    const dry = await runR2Cleanup(env, {
      trigger: "manual",
      dryRun: true,
      rerunGuard: "bypass"
    })
    if (!dry.dryRun) throw new Error("dry run must report dryRun: true")
    expect(dry.prunable).toBe(0)
    expect(dry.prunableBytes).toBe(0)
  })
})

describe("运行态：GET 的 running", () => {
  it("无锁 → null；持锁 → 与 409 同一算法；过期 → null 且可接管", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const getIdle = () =>
      request(env, "/api/admin/r2-cleanup", { headers: { cookie: admin } })

    expect((await (await getIdle()).json()) as unknown).toEqual({
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

    const takeover = await jsonRequest(
      env,
      "POST",
      "/api/admin/r2-cleanup",
      { dryRun: true },
      admin
    )
    expect(takeover.status).toBe(200)
    expect(lockValue(db)).toBeUndefined()
  })
})
