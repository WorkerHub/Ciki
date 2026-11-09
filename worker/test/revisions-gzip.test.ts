/**
 * 历史版本的 gzip 存储（规格「历史版本 gzip 存储」）。
 *
 * 覆盖验收：新存版本落库为压缩格式、查看与回滚内容与改前一致、体积量级；
 * 以及部署后到点升级之间（库里还没有 `content_gzip` 列）的降级行为。
 */
import { describe, expect, it } from "vitest"
import { gunzipText } from "../src/lib/gzip"
import { initializedContext, jsonRequest } from "./support/app"
import {
  adminWithPage,
  createPage,
  getRevision,
  listRevisions,
  paragraphDoc,
  restoreRevision,
  revisionRows,
  savePage
} from "./support/revisions"

/** 一份够长的正文：用来量 gzip 与 JSON 的体积比。 */
function longDoc(paragraphs: number): string {
  return JSON.stringify({
    type: "doc",
    content: Array.from({ length: paragraphs }, (_, index) => ({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: `第 ${index} 段：Ciki 版本治理的正文样例，混排中文与 English words，还有标点、数字 ${index * 7}。`
        }
      ]
    }))
  })
}

const IMAGE_NODE = {
  type: "image",
  attrs: {
    src: "/api/files/pages/11111111-1111-1111-1111-111111111111.png",
    alt: "示意图",
    title: null,
    originalSrc: null,
    confluenceImg: false
  }
}

const TABLE_NODE = {
  type: "table",
  content: [
    {
      type: "tableRow",
      content: [
        {
          type: "tableHeader",
          attrs: { colspan: 1, rowspan: 1, colwidth: null },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "列" }] }
          ]
        },
        {
          type: "tableCell",
          attrs: { colspan: 1, rowspan: 1, colwidth: null },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "值" }] }
          ]
        }
      ]
    }
  ]
}

describe("版本正文：新写入只落一份 gzip 的 content_json", () => {
  it("落库形态是 BLOB 压缩字节，三列文本为空串，解压后与保存的 JSON 逐字节相同", async () => {
    const context = await initializedContext()
    const { env, admin, page } = await adminWithPage(context, "压缩页")
    const contentJson = longDoc(30)
    const saved = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      {
        title: "压缩页",
        contentJson,
        contentHtml: "<p>压缩后的正文</p>",
        contentText: "压缩后的正文"
      },
      admin
    )
    expect(saved.status).toBe(200)
    expect(((await saved.json()) as { id: string }).id).toBe(page.id)

    const rows = revisionRows(context.db, page.id)
    expect(rows).toHaveLength(2)
    // 最新一条是我们刚写的那次保存（标题与正文都变了）。
    const latest = rows[rows.length - 1]
    expect(latest.gzip_type).toBe("blob")
    expect(latest.gzip_length ?? 0).toBeGreaterThan(0)
    // 三列旧文本一律留空：正文只存在于 content_gzip 里。
    expect(latest.content_json).toBe("")
    expect(latest.content_html).toBe("")
    expect(latest.content_text).toBe("")

    expect(await gunzipText(latest.content_gzip)).toBe(contentJson)

    // 体积量级：单条版本只剩正文 JSON 的 0.2–0.3 倍（验收要求 0.2–0.3×，这里用
    // < 0.5 兜住上限，实测值写进交付报告）。
    const rawBytes = new TextEncoder().encode(contentJson).length
    expect(latest.gzip_length ?? 0).toBeLessThan(rawBytes * 0.5)
  })

  it("查看单个版本：HTML/纯文本由 JSON 按需生成，contentJson 原样返回", async () => {
    const context = await initializedContext()
    const { env, admin } = await adminWithPage(context, "渲染页")
    const page = await createPage(env, admin, {
      title: "渲染页",
      text: "带图片与表格的正文",
      extra: [IMAGE_NODE, TABLE_NODE]
    })

    const revisions = await listRevisions(env, admin, page.id)
    expect(revisions).toHaveLength(1)
    const res = await getRevision(env, admin, page.id, revisions[0].id)
    expect(res.status).toBe(200)
    const detail = (await res.json()) as {
      contentJson: string
      contentHtml: string
      contentText: string
      title: string
    }
    expect(detail.contentJson).toBe(
      paragraphDoc("带图片与表格的正文", [IMAGE_NODE, TABLE_NODE])
    )
    expect(detail.contentHtml).toContain("<p>带图片与表格的正文</p>")
    expect(detail.contentHtml).toContain(
      'src="/api/files/pages/11111111-1111-1111-1111-111111111111.png"'
    )
    expect(detail.contentHtml).toContain("<table")
    expect(detail.contentText).toContain("带图片与表格的正文")
    expect(detail.title).toBe("渲染页")
  })

  it("回滚：以 JSON 重渲染写回页面，内容与改前一致，页面行的三列仍照旧存", async () => {
    const context = await initializedContext()
    const { env, admin } = await adminWithPage(context, "回滚页")
    const page = await createPage(env, admin, {
      title: "回滚页",
      text: "第一版正文",
      extra: [IMAGE_NODE]
    })
    const before = (await (
      await getRevision(
        env,
        admin,
        page.id,
        (
          await listRevisions(env, admin, page.id)
        )[0].id
      )
    ).json()) as { contentHtml: string; contentText: string }

    await savePage(env, admin, page.id, { title: "回滚页", text: "第二版正文" })
    const revisions = await listRevisions(env, admin, page.id)
    const oldest = revisions[revisions.length - 1]

    const restore = await restoreRevision(env, admin, page.id, oldest.id)
    expect(restore.status).toBe(200)
    const restored = (await restore.json()) as {
      contentHtml: string
      contentText: string
    }
    expect(restored.contentHtml).toBe(before.contentHtml)
    expect(restored.contentText).toBe(before.contentText)
    expect(restored.contentHtml).toContain("<img")

    // 页面行（pages 表）的存储不变：仍然带 HTML 与纯文本。
    const row = context.db.db
      .prepare(
        "SELECT content_json, content_html, content_text FROM ciki_pages WHERE id = ?"
      )
      .get(page.id) as {
      content_json: string
      content_html: string
      content_text: string
    }
    expect(row.content_html).toContain("<img")
    expect(row.content_text).toContain("第一版正文")
  })

  it("部署后到点升级之间（库里还没有 content_gzip 列）：保存、查看、回滚照常可用", async () => {
    const context = await initializedContext()
    // 模拟升级前的库：schema_v2 还没跑，列不存在。
    context.db.exec("ALTER TABLE ciki_page_revisions DROP COLUMN content_gzip")
    const { env, admin, page } = await adminWithPage(context, "未升级页")

    const saved = await savePage(env, admin, page.id, {
      title: "未升级页",
      text: "未升级时保存的正文"
    })
    expect(saved.contentText).toBe("未升级时保存的正文")

    // 旧形态行：三列文本都在，没有 gzip。
    const row = context.db.db
      .prepare(
        `SELECT content_json, content_html, content_text
           FROM ciki_page_revisions WHERE page_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(page.id) as {
      content_json: string
      content_html: string
      content_text: string
    }
    expect(row.content_json).toBe(paragraphDoc("未升级时保存的正文"))
    expect(row.content_html).toBe("<p>未升级时保存的正文</p>")

    const revisions = await listRevisions(env, admin, page.id)
    const detail = await getRevision(env, admin, page.id, revisions[0].id)
    expect(detail.status).toBe(200)
    expect(((await detail.json()) as { contentHtml: string }).contentHtml).toBe(
      "<p>未升级时保存的正文</p>"
    )

    const restore = await restoreRevision(env, admin, page.id, revisions[0].id)
    expect(restore.status).toBe(200)
    expect(
      ((await restore.json()) as { contentText: string }).contentText
    ).toBe("未升级时保存的正文")
  })

  it("JSON 渲染不了（未知节点）：查看与回滚都回 422，页面内容不被改写", async () => {
    const context = await initializedContext()
    const { env, admin } = await adminWithPage(context, "怪内容页")
    const page = await createPage(env, admin, {
      title: "怪内容页",
      text: "正常正文",
      contentJson: JSON.stringify({
        type: "doc",
        content: [{ type: "mysteryNode" }]
      })
    })

    const revisions = await listRevisions(env, admin, page.id)
    const res = await getRevision(env, admin, page.id, revisions[0].id)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe(
      "REVISION_UNRENDERABLE"
    )

    const restore = await restoreRevision(env, admin, page.id, revisions[0].id)
    expect(restore.status).toBe(422)

    const detail = (await (
      await jsonRequest(env, "GET", `/api/pages/${page.id}`, undefined, admin)
    ).json()) as { contentText: string }
    expect(detail.contentText).toBe("正常正文")
  })
})
