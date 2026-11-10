/**
 * 存量迁移演练：`schema_v2` 把旧形态版本行逐行压成 gzip（规格「存量迁移」）。
 *
 * 用真实的 SQLite（测试替身 node:sqlite）演练线上将要走的那条升级通道：
 * 先造一个「升级前」的库（没有 content_gzip 列、账本里没有 schema_v2），用旧形态写入
 * 若干版本，再跑一次 setup 让迁移执行，然后逐项核对：
 *   - 账本登记 schema_v2；幂等（重复 setup → skipped）与可续跑（部分行已转换）；
 *   - 每页版本条数与 title/editor_id/created_at 逐项一致；
 *   - 抽查 3 个老版本：查看结果与迁移前一致、回滚正常；
 *   - 页面行（pages）一字未动。
 */
import { describe, expect, it } from "vitest"
import {
  backfillRevisionStatement,
  listLegacyRevisionsBatch
} from "../src/db/queries/revisions"
import { gzipText, gunzipText } from "../src/lib/gzip"
import { runSetup } from "../src/lib/setup"
import { initializedContext, type TestContext } from "./support/app"
import {
  createPage,
  getRevision,
  listRevisions,
  restoreRevision,
  revisionRows,
  savePage,
  simulatePreUpgrade
} from "./support/revisions"
import { adminSession } from "./support/app"

interface LegacyRow {
  id: string
  page_id: string
  title: string
  content_json: string
  content_html: string
  content_text: string
  editor_id: string
  created_at: string
}

function legacyRows(db: TestContext["db"]): LegacyRow[] {
  return db.db
    .prepare(
      `SELECT id, page_id, title, content_json, content_html, content_text,
              editor_id, created_at
         FROM ciki_page_revisions
        ORDER BY id`
    )
    .all() as LegacyRow[]
}

/** 元数据快照：迁移只允许改正文列，这些必须逐项一致（按 id 排序后逐条比对）。 */
function metadata(rows: LegacyRow[]) {
  return rows
    .map((row) => ({
      id: row.id,
      page_id: row.page_id,
      title: row.title,
      editor_id: row.editor_id,
      created_at: row.created_at
    }))
    .sort((left, right) => (left.id < right.id ? -1 : 1))
}

function countByPage(rows: Array<{ page_id: string }>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    counts[row.page_id] = (counts[row.page_id] ?? 0) + 1
  }
  return counts
}

function pagesSnapshot(db: TestContext["db"]) {
  return db.db
    .prepare(
      `SELECT id, title, content_json, content_html, content_text, updated_at
         FROM ciki_pages ORDER BY id`
    )
    .all()
}

interface RevisionDetail {
  id: string
  title: string
  contentJson: string
  contentHtml: string
  contentText: string
}

/** 造一个「升级前」的库：两个页面、若干版本（含图片，用于清理口径的对照）。 */
async function legacyDatabase() {
  const context = await initializedContext()
  simulatePreUpgrade(context.db)
  const admin = await adminSession(context.env)
  const first = await createPage(context.env, admin, {
    title: "旧页一",
    text: "旧页一的初版"
  })
  await savePage(context.env, admin, first.id, {
    title: "旧页一",
    text: "旧页一的第二版"
  })
  await savePage(context.env, admin, first.id, {
    title: "旧页一改名",
    text: "旧页一的第三版"
  })
  await savePage(context.env, admin, first.id, {
    title: "旧页一改名",
    text: "旧页一的第四版"
  })
  const second = await createPage(context.env, admin, {
    title: "旧页二",
    text: "旧页二的初版",
    extra: [
      {
        type: "image",
        attrs: {
          src: "/api/files/pages/22222222-2222-2222-2222-222222222222.png",
          alt: "老图",
          title: null,
          originalSrc: null,
          confluenceImg: false
        }
      }
    ]
  })
  return { context, admin, first, second }
}

describe("存量迁移：仓库里的旧版本行逐行压成 gzip", () => {
  it("账本登记 schema_v2；每页条数与元数据逐项一致；抽查老版本查看与回滚正常", async () => {
    const { context, admin, first, second } = await legacyDatabase()
    const before = legacyRows(context.db)
    // 旧页一 4 条（创建 + 3 次保存），旧页二 1 条。
    expect(countByPage(before)).toEqual({ [first.id]: 4, [second.id]: 1 })
    expect(before.every((row) => row.content_json !== "")).toBe(true)
    const beforePages = pagesSnapshot(context.db)

    // 老版本先按改前的读法看一遍（旧形态：直接读三列）。
    const beforeDetails = new Map<string, RevisionDetail>()
    for (const pageId of [first.id, second.id]) {
      for (const revision of await listRevisions(context.env, admin, pageId)) {
        const res = await getRevision(context.env, admin, pageId, revision.id)
        expect(res.status).toBe(200)
        beforeDetails.set(revision.id, (await res.json()) as RevisionDetail)
      }
    }

    // 走升级通道（管理面按钮调的就是它）。
    const result = await runSetup(context.env)
    if (!result.success) throw new Error(result.error)
    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v2", status: "applied" },
      // 这个库在退回「v2 之前」时仍保留已应用的 schema_v3（邮箱验证码表还在）。
      { name: "schema_v3", status: "skipped" },
      { name: "schema_v4", status: "skipped" }
    ])

    const after = revisionRows(context.db)
    // 条数与元数据一项都没变。
    expect(countByPage(after)).toEqual(countByPage(before))
    expect(metadata(after)).toEqual(metadata(before))

    for (const row of after) {
      const legacy = before.find((item) => item.id === row.id)
      if (!legacy) throw new Error("row lost")
      expect(row.gzip_type).toBe("blob")
      expect((row.gzip_length ?? 0) > 0).toBe(true)
      // 三列旧文本清空，正文只存在于 gzip 里，且解压后与原文逐字节相同。
      expect(row.content_json).toBe("")
      expect(row.content_html).toBe("")
      expect(row.content_text).toBe("")
      expect(await gunzipText(row.content_gzip)).toBe(legacy.content_json)
    }

    // 页面行（pages 表）一字未动。
    expect(pagesSnapshot(context.db)).toEqual(beforePages)

    // 迁移后每个版本的 JSON 都与迁移前逐字节一致。
    for (const pageId of [first.id, second.id]) {
      for (const revision of await listRevisions(context.env, admin, pageId)) {
        const res = await getRevision(context.env, admin, pageId, revision.id)
        expect(res.status).toBe(200)
        const detail = (await res.json()) as RevisionDetail
        expect(detail.contentJson).toBe(
          beforeDetails.get(revision.id)?.contentJson
        )
      }
    }
    // 纯文本页：查看结果与迁移前逐字段一致（HTML/纯文本由同一份 JSON 重渲染）。
    for (const revision of await listRevisions(context.env, admin, first.id)) {
      const res = await getRevision(context.env, admin, first.id, revision.id)
      expect((await res.json()) as RevisionDetail).toEqual(
        beforeDetails.get(revision.id)
      )
    }
    // 含图片的页：以 JSON 为唯一真源，重渲染出的 HTML 反而比当初客户端提交的更完整
    // （那条老 HTML 漏了图，JSON 里有）——查看与回滚拿到的都是完整的这一份。
    const secondRevision = (
      await listRevisions(context.env, admin, second.id)
    )[0]
    const secondDetail = (await (
      await getRevision(context.env, admin, second.id, secondRevision.id)
    ).json()) as RevisionDetail
    expect(secondDetail.contentHtml).toContain(
      'src="/api/files/pages/22222222-2222-2222-2222-222222222222.png"'
    )
    expect(secondDetail.contentText).toBe("旧页二的初版")
    const samples = (await listRevisions(context.env, admin, first.id))
      .slice(1, 4)
      .map((revision) => revision.id)
    expect(samples).toHaveLength(3)
    for (const revisionId of samples) {
      const res = await getRevision(context.env, admin, first.id, revisionId)
      expect(res.status).toBe(200)
      expect((await res.json()) as RevisionDetail).toEqual(
        beforeDetails.get(revisionId)
      )
    }

    // 回滚老版本：写回页面并新增一条版本（新版本照旧是 gzip 形态）。
    const restored = await restoreRevision(
      context.env,
      admin,
      first.id,
      samples[0]
    )
    expect(restored.status).toBe(200)
    expect(
      ((await restored.json()) as { contentText: string }).contentText
    ).toBe(beforeDetails.get(samples[0])?.contentText)
    expect(revisionRows(context.db, first.id).length).toBe(5)
  })

  it("幂等：再跑一次 setup 全部 skipped，已转换的行一个字节都不变", async () => {
    const { context } = await legacyDatabase()
    await runSetup(context.env)
    const converted = revisionRows(context.db)

    const again = await runSetup(context.env)
    if (!again.success) throw new Error(again.error)
    expect(again.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v2", status: "skipped" },
      { name: "schema_v3", status: "skipped" },
      { name: "schema_v4", status: "skipped" }
    ])

    const rows = revisionRows(context.db)
    expect(rows.map((row) => row.id)).toEqual(converted.map((row) => row.id))
    for (const [index, row] of rows.entries()) {
      const previous = converted[index]
      expect(Array.from(row.content_gzip ?? [])).toEqual(
        Array.from(previous.content_gzip ?? [])
      )
      expect(row.content_json).toBe("")
    }
  })

  it("续跑与 id 大小无关：比已转换行更小的 id 只要还是旧形态就照样被捞出来", async () => {
    const { context } = await legacyDatabase()
    // 先挑 id 最大的那行转换（模拟上一轮跑到一半就被打断）。
    const rows = legacyRows(context.db)
    const biggest = rows[rows.length - 1]
    if (!biggest) throw new Error("no legacy rows")
    // 列由迁移先补（模拟「上一轮已跑到补列这一步、数据转换只做了一点」）。
    await context.env.DB.prepare(
      "ALTER TABLE ciki_page_revisions ADD COLUMN content_gzip BLOB"
    ).run()
    await backfillRevisionStatement(
      context.env.DB,
      "ciki_",
      biggest.id,
      await gzipText(biggest.content_json)
    ).run()

    // 下一轮从「当前仍未转换的前 N 行」开始取：比已转换行 id 更小的旧行必须出现，
    // 用 id 游标（>`上一个 id`）的写法会把这些行跳过。
    const batch = await listLegacyRevisionsBatch(context.env.DB, "ciki_", 10)
    const ids = batch.map((row) => row.id)
    expect(ids).not.toContain(biggest.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.every((id) => id < biggest.id)).toBe(true)
  })

  it("可中断续跑：已转换的行不动，剩下的行一次补齐", async () => {
    const { context } = await legacyDatabase()
    const before = legacyRows(context.db)
    // 先手工转换一行（模拟上一轮跑到一半被打断：列已补、账本还没记）。
    const preConverted = before[0]
    const preGzip = await gzipText(preConverted.content_json)
    await context.env.DB.prepare(
      "ALTER TABLE ciki_page_revisions ADD COLUMN content_gzip BLOB"
    ).run()
    await backfillRevisionStatement(
      context.env.DB,
      "ciki_",
      preConverted.id,
      preGzip
    ).run()

    const result = await runSetup(context.env)
    if (!result.success) throw new Error(result.error)
    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v2", status: "applied" },
      // 这个库在退回「v2 之前」时仍保留已应用的 schema_v3（邮箱验证码表还在）。
      { name: "schema_v3", status: "skipped" },
      { name: "schema_v4", status: "skipped" }
    ])

    const rows = revisionRows(context.db)
    expect(rows).toHaveLength(before.length)
    for (const row of rows) {
      expect(row.gzip_type).toBe("blob")
      const legacy = before.find((item) => item.id === row.id)
      if (!legacy) throw new Error("row lost")
      expect(await gunzipText(row.content_gzip)).toBe(legacy.content_json)
      expect(row.content_json).toBe("")
    }
    // 预先转换的那一行不被二次覆盖。
    const untouched = rows.find((row) => row.id === preConverted.id)
    expect(Array.from(untouched?.content_gzip ?? [])).toEqual(
      Array.from(preGzip)
    )
    expect(await gunzipText(untouched?.content_gzip)).toBe(
      preConverted.content_json
    )
  })
})
