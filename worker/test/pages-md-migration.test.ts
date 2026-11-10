/**
 * `schema_v4` 存量回填演练：用真实 SQLite（测试替身 node:sqlite）走一遍线上将要走的
 * 那条升级通道——先造「升级前」的库（没有 `content_md` 列、账本里没有 `schema_v4`），
 * 用当时的写路径存几页，再跑一次 setup 让迁移执行，逐项核对：
 *
 * - 升级前：保存不因缺列失败，读路径（页面详情 / 只读接口）按需现生成，不报错也不回空；
 * - 升级后：账本登记 `schema_v4`，每页（含软删页、空正文页）都被回填；
 * - 幂等：再跑一次 setup 全部 skipped，MD 一个字节都不变；
 * - 可中断续跑：把一部分行置回待办、删掉账本记录，下一轮只补这些行。
 */
import { describe, expect, it } from "vitest"
import { resetContentMdColumnCache } from "../src/db/queries/pages"
import { runSetup } from "../src/lib/setup"
import { derivePageMarkdown } from "../src/lib/tiptap-markdown"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  request,
  type TestContext
} from "./support/app"

const RICH_DOC = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "回填小标题" }]
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "回填正文" }]
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "要点" }] }
          ]
        }
      ]
    },
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              attrs: { colspan: 2, rowspan: 1 },
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "合并头" }]
                }
              ]
            }
          ]
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              attrs: { colspan: 1, rowspan: 1 },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "甲" }] }
              ]
            },
            {
              type: "tableCell",
              attrs: { colspan: 1, rowspan: 1 },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "乙" }] }
              ]
            }
          ]
        }
      ]
    }
  ]
}

const RICH_JSON = JSON.stringify(RICH_DOC)
const RICH_MD = derivePageMarkdown(RICH_JSON, "回填正文")

/** 复现「部署了代码、管理员还没点升级」的库：列被去掉、账本里没有 schema_v4。 */
function simulatePreUpgrade(context: TestContext): void {
  context.db.exec("ALTER TABLE ciki_pages DROP COLUMN content_md")
  context.db.exec(
    "DELETE FROM _ciki_schema_migrations WHERE name = 'schema_v4'"
  )
  resetContentMdColumnCache()
}

function pageColumns(context: TestContext): string[] {
  return (
    context.db.db.prepare("PRAGMA table_info(ciki_pages)").all() as Array<{
      name: string
    }>
  ).map((column) => column.name)
}

function tableNames(context: TestContext): string[] {
  return (
    context.db.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name)
}

interface MarkdownRow {
  id: string
  title: string
  content_md: string | null
  updated_at: string
}

interface PageSnapshot {
  id: string
  title: string
  content_json: string
  content_html: string
  content_text: string
  updated_at: string
}

/** 升级只需要新增 `content_md`：除它以外的列必须一字不动。 */
function pageSnapshot(context: TestContext): PageSnapshot[] {
  return context.db.db
    .prepare(
      "SELECT id, title, content_json, content_html, content_text, updated_at FROM ciki_pages ORDER BY id"
    )
    .all() as PageSnapshot[]
}

function markdownRows(context: TestContext): MarkdownRow[] {
  return context.db.db
    .prepare(
      "SELECT id, title, content_md, updated_at FROM ciki_pages ORDER BY id"
    )
    .all() as MarkdownRow[]
}

function savePage(
  env: TestContext["env"],
  cookie: string,
  input: {
    title: string
    contentJson?: string
    contentHtml?: string
    contentText?: string
  }
) {
  return jsonRequest(
    env,
    "POST",
    "/api/pages",
    {
      title: input.title,
      parentId: null,
      contentJson: input.contentJson ?? RICH_JSON,
      contentHtml: input.contentHtml ?? "<p>回填正文</p>",
      contentText: input.contentText ?? "回填正文"
    },
    cookie
  )
}

/** 升级前存几页（含一页待删、一页空正文），返回各自的 id。 */
async function seedPreUpgradePages(context: TestContext) {
  const admin = await adminSession(context.env)
  const rich = await savePage(context.env, admin, { title: "存量富文本页" })
  const plain = await savePage(context.env, admin, {
    title: "存量纯文本页",
    contentJson: JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "纯文本正文" }] }
      ]
    }),
    contentHtml: "<p>纯文本正文</p>",
    contentText: "纯文本正文"
  })
  const empty = await savePage(context.env, admin, {
    title: "空正文页",
    contentJson: JSON.stringify({ type: "doc" }),
    contentHtml: "",
    contentText: ""
  })
  const trashed = await savePage(context.env, admin, { title: "回收站里的页" })
  const richId = ((await rich.json()) as { id: string }).id
  const plainId = ((await plain.json()) as { id: string }).id
  const emptyId = ((await empty.json()) as { id: string }).id
  const trashedId = ((await trashed.json()) as { id: string }).id

  const deleted = await jsonRequest(
    context.env,
    "DELETE",
    `/api/pages/${trashedId}`,
    undefined,
    admin
  )
  expect(deleted.status).toBe(200)

  return { admin, richId, plainId, emptyId, trashedId }
}

describe("schema_v4：content_md 列与存量回填", () => {
  it("升级前：保存不因缺列失败；详情与只读接口按需现生成，不报错也不回空", async () => {
    const context = await initializedContext()
    simulatePreUpgrade(context)
    expect(pageColumns(context)).not.toContain("content_md")

    const { env } = context
    const admin = await adminSession(env)
    const created = await savePage(env, admin, { title: "升级前保存的页" })
    expect(created.status).toBe(201)
    const page = (await created.json()) as { id: string; contentMd: string }
    // 派生件照常返回（现生成），只是还没落库。
    expect(page.contentMd).toBe(RICH_MD)

    const detail = (await (
      await jsonRequest(env, "GET", `/api/pages/${page.id}`, undefined, admin)
    ).json()) as { contentMd: string }
    expect(detail.contentMd).toBe(RICH_MD)

    // 只读接口同样现生成（读接口不依赖升级是否已跑）。
    const issued = await jsonRequest(
      env,
      "POST",
      "/api/me/read-token",
      {},
      admin
    )
    expect(issued.status).toBe(200)
    const { token } = (await issued.json()) as { token: string }
    const read = await request(env, `/api/read/pages/${page.id}`, {
      headers: { authorization: `Bearer ${token}` }
    })
    expect(read.status).toBe(200)
    expect(((await read.json()) as { markdown: string }).markdown).toBe(RICH_MD)
  })

  it("升级后：账本登记 schema_v4，所有页面（含软删、空正文）都被回填且元数据不动", async () => {
    const context = await initializedContext()
    simulatePreUpgrade(context)
    const seeded = await seedPreUpgradePages(context)
    const before = pageSnapshot(context)

    const result = await runSetup(context.env)
    expect(result.success).toBe(true)
    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v2", status: "skipped" },
      { name: "schema_v3", status: "skipped" },
      { name: "schema_v4", status: "applied" }
    ])

    expect(pageColumns(context)).toContain("content_md")
    expect(tableNames(context)).toContain("ciki_read_tokens")

    // 除 content_md 外一字未改（`updated_at` 也不动：回填是纯派生，不是一次编辑）。
    expect(pageSnapshot(context)).toEqual(before)

    const after = markdownRows(context)
    expect(after).toHaveLength(before.length)
    for (const row of after) {
      expect(row.content_md).not.toBeNull()
    }
    const byId = new Map(after.map((row) => [row.id, row]))
    expect(byId.get(seeded.richId)?.content_md).toBe(RICH_MD)
    expect(byId.get(seeded.plainId)?.content_md).toBe("纯文本正文")
    // 空正文页：回填成空串（不是 null），从此离开待办集。
    expect(byId.get(seeded.emptyId)?.content_md).toBe("")
    // 软删页也回填：恢复后立刻可读。
    expect(byId.get(seeded.trashedId)?.content_md).toBe(RICH_MD)

    // 抽 3 页核对「接口取到的 markdown 与页面内容一致」。
    const issued = await jsonRequest(
      context.env,
      "POST",
      "/api/me/read-token",
      {},
      seeded.admin
    )
    const { token } = (await issued.json()) as { token: string }
    for (const [id, expected] of [
      [seeded.richId, RICH_MD],
      [seeded.plainId, "纯文本正文"],
      [seeded.emptyId, ""]
    ] as const) {
      const res = await request(context.env, `/api/read/pages/${id}`, {
        headers: { authorization: `Bearer ${token}` }
      })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { markdown: string }).markdown).toBe(
        expected
      )
    }

    // 幂等：再跑一次 setup 全部 skipped，MD 与 updated_at 都不动。
    const again = await runSetup(context.env)
    expect(again.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v2", status: "skipped" },
      { name: "schema_v3", status: "skipped" },
      { name: "schema_v4", status: "skipped" }
    ])
    expect(markdownRows(context)).toEqual(after)
  })

  it("可中断续跑：只补回待办的行，已回填的一个字节都不动", async () => {
    const context = await initializedContext()
    const seeded = await seedPreUpgradePages(context)
    const baseline = markdownRows(context)

    // 模拟一批没跑完：抽两行置回待办，并抹掉账本记录（= 上次 prepare 抛错）。
    context.db.exec(
      `UPDATE ciki_pages SET content_md = NULL WHERE id IN ('${seeded.richId}', '${seeded.emptyId}')`
    )
    context.db.exec(
      "DELETE FROM _ciki_schema_migrations WHERE name = 'schema_v4'"
    )

    const result = await runSetup(context.env)
    expect(result.success).toBe(true)
    expect(result.migrations[result.migrations.length - 1]).toEqual({
      name: "schema_v4",
      status: "applied"
    })

    const after = markdownRows(context)
    // 全部行都回到基线值（剩下的行不被二次写入，值逐字节相同）。
    expect(after).toEqual(baseline)
    expect(after.find((row) => row.id === seeded.richId)?.content_md).toBe(
      RICH_MD
    )
  })

  it("坏 JSON 的历史行也回填（退回纯文本），不会让整轮迁移失败", async () => {
    const context = await initializedContext()
    await runSetup(context.env)
    // 直接写一行脏数据（历史遗留的非法 JSON），并把它的 MD 置回待办。
    const now = new Date().toISOString()
    context.db.exec(
      `INSERT INTO ciki_pages (id, space_id, parent_id, title, sort_order, content_json, content_html, content_text, content_md, created_by, updated_by, created_at, updated_at, deleted_at)
       VALUES ('broken-page', 'space-default', NULL, '坏页', 0, '{不是 JSON', '<p>兜底正文</p>', '兜底正文', NULL, 'u', 'u', '${now}', '${now}', NULL)`
    )
    context.db.exec(
      "DELETE FROM _ciki_schema_migrations WHERE name = 'schema_v4'"
    )

    const result = await runSetup(context.env)
    expect(result.success).toBe(true)
    const row = markdownRows(context).find(
      (entry) => entry.id === "broken-page"
    )
    // 派生版永不抛错：退回已消毒的纯文本，而不是让迁移整单卡死。
    expect(row?.content_md).toBe("兜底正文")
  })
})
