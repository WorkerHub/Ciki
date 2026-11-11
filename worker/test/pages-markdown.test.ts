/**
 * 保存路径的 MD 落库（规格一期 §一.2）：`content_md` 与 html/纯文本同批写入，
 * 编辑再存同步更新，无改动保存不重写，回滚也经同一路径重新生成。
 *
 * 派生规则本身由 `test/tiptap-markdown.test.ts` 的夹具逐字节钉死，这里只验证
 * 「写路径把派生件送到了该去的地方」以及各入口的一致性。
 */
import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  request
} from "./support/app"
import type { SqliteD1 } from "./support/sqlite-d1"

interface PageDetail {
  id: string
  title: string
  contentJson: string
  contentHtml: string
  contentText: string
  contentMd: string
  updatedAt: string
}

interface RevisionSummary {
  id: string
  title: string
  createdAt: string
}

const RICH_DOC = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "小节" }]
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "正文" },
        { type: "text", text: "带粗体", marks: [{ type: "bold" }] }
      ]
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "要点一" }] }
          ]
        },
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "要点二" }] },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "子要点" }]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    {
      type: "codeBlock",
      attrs: { language: "js" },
      content: [{ type: "text", text: "let a = 1" }]
    },
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              attrs: { colspan: 1, rowspan: 1 },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "头" }] }
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
                { type: "paragraph", content: [{ type: "text", text: "值" }] }
              ]
            }
          ]
        }
      ]
    },
    {
      type: "image",
      attrs: { src: "/api/files/pages/x.png", alt: "图" }
    }
  ]
}

/** 期望 MD：与 `test/fixtures/markdown/` 同一套规则。 */
const RICH_MD = [
  "## 小节",
  "",
  "正文**带粗体**",
  "",
  "- 要点一",
  "- 要点二",
  "  - 子要点",
  "",
  "```js",
  "let a = 1",
  "```",
  "",
  "| 头 |",
  "| --- |",
  "| 值 |",
  "",
  "![图](https://ciki.oneboy.app/api/files/pages/x.png)"
].join("\n")

async function createRichPage(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  json: unknown = RICH_DOC
): Promise<PageDetail> {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/pages",
    {
      title: "带 MD 的页面",
      parentId: null,
      contentJson: JSON.stringify(json),
      contentHtml: "<p>正文</p>",
      contentText: "正文"
    },
    cookie
  )
  expect(res.status).toBe(201)
  return (await res.json()) as PageDetail
}

function pageRow(db: SqliteD1, id: string): { content_md: string | null } {
  return db.db
    .prepare("SELECT content_md FROM ciki_pages WHERE id = ?")
    .get(id) as { content_md: string | null }
}

function revisionCount(db: SqliteD1, pageId: string): number {
  const row = db.db
    .prepare(
      "SELECT COUNT(*) AS count FROM ciki_page_revisions WHERE page_id = ?"
    )
    .get(pageId) as { count: number }
  return row.count
}

describe("保存路径：content_md 与正文同批落库", () => {
  it("新建即落库，规则与夹具一致；详情接口的 contentMd 就是库里的值", async () => {
    const context = await initializedContext()
    const { env, db } = context
    const admin = await adminSession(env)

    const page = await createRichPage(env, admin)

    expect(page.contentMd).toBe(RICH_MD)
    expect(pageRow(db, page.id).content_md).toBe(RICH_MD)

    const detail = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${page.id}?format=json`,
        undefined,
        admin
      )
    ).json()) as PageDetail
    expect(detail.contentMd).toBe(RICH_MD)
    // 真源不动：JSON/HTML/纯文本仍是各存各的。
    expect(JSON.parse(detail.contentJson)).toEqual(RICH_DOC)
    expect(detail.contentHtml).toBe("<p>正文</p>")
  })

  it("编辑再存：MD 跟随更新，并追加一条版本（版本表不存 MD）", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createRichPage(env, admin)

    const edited = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "改过的标题" }]
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "改过的正文" }]
        }
      ]
    }
    const res = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      {
        title: "带 MD 的页面",
        contentJson: JSON.stringify(edited),
        contentHtml: "<h1>改过的标题</h1><p>改过的正文</p>",
        contentText: "改过的标题 改过的正文"
      },
      admin
    )
    expect(res.status).toBe(200)
    const saved = (await res.json()) as PageDetail
    expect(saved.contentMd).toBe("# 改过的标题\n\n改过的正文")
    expect(pageRow(db, page.id).content_md).toBe("# 改过的标题\n\n改过的正文")
    expect(revisionCount(db, page.id)).toBe(2)

    // 历史版本只存内容哈希指针（正文本体在内容桶里），没有 markdown 列。
    const columns = (
      db.db.prepare("PRAGMA table_info(ciki_page_revisions)").all() as Array<{
        name: string
      }>
    ).map((column) => column.name)
    expect(columns).toContain("content_hash")
    expect(columns).not.toContain("content_md")
    expect(columns).not.toContain("content_json")
  })

  it("无改动保存：判等口径仍是四项，MD 与版本条数都不动", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createRichPage(env, admin)

    const body = {
      title: "带 MD 的页面",
      contentJson: JSON.stringify(RICH_DOC),
      contentHtml: "<p>正文</p>",
      contentText: "正文"
    }
    const res = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      body,
      admin
    )
    expect(res.status).toBe(200)
    const saved = (await res.json()) as PageDetail
    expect(saved.contentMd).toBe(RICH_MD)
    expect(revisionCount(db, page.id)).toBe(1)
    expect(pageRow(db, page.id).content_md).toBe(RICH_MD)
  })

  it("回滚历史版本：MD 随回滚重新生成（走同一写路径）", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createRichPage(env, admin)

    await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      {
        title: "带 MD 的页面",
        contentJson: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "第二版" }]
            }
          ]
        }),
        contentHtml: "<p>第二版</p>",
        contentText: "第二版"
      },
      admin
    )
    expect(pageRow(db, page.id).content_md).toBe("第二版")

    const revisions = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${page.id}/revisions`,
        undefined,
        admin
      )
    ).json()) as RevisionSummary[]
    const oldest = revisions[revisions.length - 1]
    const restored = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/revisions/${oldest.versionNo}/restore`,
      undefined,
      admin
    )
    expect(restored.status).toBe(200)
    expect(((await restored.json()) as PageDetail).contentMd).toBe(RICH_MD)
    expect(pageRow(db, page.id).content_md).toBe(RICH_MD)
  })

  it("导入覆盖：同一条写路径，MD 按导入的 JSON 重新派生", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createRichPage(env, admin)

    const issued = await jsonRequest(
      env,
      "POST",
      "/api/me/import-token",
      {},
      admin
    )
    expect(issued.status).toBe(200)
    const { token } = (await issued.json()) as { token: string }

    const imported = await request(env, "/api/import/pages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: page.title,
        parentId: null,
        contentJson: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 4 },
              content: [{ type: "text", text: "导入的小标题" }]
            }
          ]
        }),
        conflict: "update"
      })
    })
    expect(imported.status).toBe(200)
    const { pageId } = (await imported.json()) as { pageId: string }
    expect(pageId).toBe(page.id)
    expect(pageRow(db, page.id).content_md).toBe("#### 导入的小标题")
  })

  it("空正文页：contentMd 是空串（不是 null、不报错）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createRichPage(env, admin, { type: "doc" })
    expect(page.contentMd).toBe("")
  })

  it("详情接口的 contentMd 与只读接口的 markdown 逐字节一致（下载只差标题行）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createRichPage(env, admin)

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
    const markdown = ((await read.json()) as { markdown: string }).markdown

    const detail = (await (
      await jsonRequest(env, "GET", `/api/pages/${page.id}`, undefined, admin)
    ).json()) as PageDetail
    expect(markdown).toBe(detail.contentMd)
  })
})
