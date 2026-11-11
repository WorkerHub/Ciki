import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52
])

async function issueToken(
  env: Parameters<typeof adminSession>[0],
  cookie: string
): Promise<string> {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/me/import-token",
    undefined,
    cookie
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { token: string }).token
}

async function importRequest(
  env: Parameters<typeof request>[0],
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`
  }
  if (body !== undefined) headers["content-type"] = "application/json"
  return request(env, path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

/** 一份能覆盖 §5 保真项的内容：标题、代码、表格列宽、任务勾选、坏链、外链图。 */
function sampleDoc(text = "导入正文") {
  return {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: "导入标题" }]
      },
      { type: "paragraph", content: [{ type: "text", text }] },
      {
        type: "codeBlock",
        attrs: { language: "sql" },
        content: [{ type: "text", text: "select 1" }]
      },
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                attrs: { colspan: 1, rowspan: 1, colwidth: [120] },
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "列A" }]
                  }
                ]
              },
              {
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 1, colwidth: [80] },
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "列B" }]
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: true },
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "已勾选" }]
              }
            ]
          }
        ]
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "坏链",
            marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }]
          }
        ]
      },
      {
        type: "image",
        attrs: {
          src: "https://confluence.example/download/a.png",
          alt: "外链",
          title: null,
          originalSrc: null,
          confluenceImg: false,
          width: 360
        }
      },
      {
        type: "image",
        attrs: {
          src: "/api/files/0f3c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b.png",
          alt: "脏宽度",
          title: null,
          width: "50%"
        }
      },
      {
        type: "image",
        attrs: {
          src: "/api/files/1f3c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b.png",
          alt: "布尔宽度",
          title: null,
          width: true
        }
      }
    ]
  }
}

interface PageDetail {
  id: number
  parentId: number | null
  title: string
  contentJson: string
  contentHtml: string
  contentText: string
  updatedAt: string
}

describe("导入接口：令牌鉴权与四个端点", () => {
  it("GET /api/import/parents 返回 {id,title,parentId} 摘要（不含正文）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const token = await issueToken(env, admin)

    const created = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        title: "首页",
        parentId: null,
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>首页</p>",
        contentText: "首页"
      },
      admin
    )
    expect(created.status).toBe(201)
    const page = (await created.json()) as PageDetail

    const res = await importRequest(env, token, "GET", "/api/import/parents")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { id: page.id, title: "首页", parentId: null }
    ])
  })

  it("导入新建：服务端按编辑器 schema 渲染后过同一支消毒管线，contentText 由 HTML 生成", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const token = await issueToken(env, admin)
    const doc = sampleDoc()

    const res = await importRequest(env, token, "POST", "/api/import/pages", {
      title: "导入页",
      parentId: null,
      contentJson: JSON.stringify(doc),
      conflict: "create_copy"
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { pageId: number; url: string }
    expect(Number.isInteger(body.pageId)).toBe(true)
    expect(body.pageId).toBeGreaterThan(0)
    expect(body.url).toBe(`/p/${body.pageId}`)

    const page = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${body.pageId}?format=json`,
        undefined,
        admin
      )
    ).json()) as PageDetail
    // 原样落库的 TipTap JSON（编辑态用它，读自内容桶），HTML 是服务端渲染 + 消毒的结果。
    expect(page.contentJson).toBe(JSON.stringify(doc))
    expect(page.title).toBe("导入页")

    // 保真：代码语言、表格列宽、任务勾选态都保留。
    expect(page.contentHtml).toContain('<code class="language-sql">')
    expect(page.contentHtml).toContain('<col width="120">')
    expect(page.contentHtml).toContain('<col width="80">')
    expect(page.contentHtml).toContain('data-checked="true"')
    expect(page.contentHtml).toContain('data-type="taskItem"')
    expect(page.contentHtml).toContain('class="tableWrapper"')

    // 安全：消毒为准——坏链 href 被剥、外链图降级为「未转存」。
    expect(page.contentHtml).not.toContain("javascript:")
    expect(page.contentHtml).not.toContain("<script")
    expect(page.contentHtml).toContain(
      'data-original-src="https://confluence.example/download/a.png"'
    )
    expect(page.contentHtml).toContain('data-confluence-img="true"')
    // 宽度口径与 web 一致：正整数像素原样落成 width 属性，非整数（"50%"）、
    // 布尔值（true 不得被 Number() 强转成 1）都不输出
    expect(page.contentHtml).toContain('width="360"')
    expect(page.contentHtml).not.toContain("50%")
    expect(page.contentHtml).not.toContain('width="1"')
    // 布尔宽度那张图整段不带 width 属性（否则 true 会被序列化成宽度）
    const booleanImg =
      /<img[^>]*alt="布尔宽度"[^>]*>/.exec(page.contentHtml)?.[0] ?? ""
    expect(booleanImg).toContain('alt="布尔宽度"')
    expect(booleanImg).not.toContain("width=")

    // contentText 是纯文本（搜索与摘要用），来自消毒后的 HTML。
    expect(page.contentText).toContain("导入正文")
    expect(page.contentText).not.toContain("<")

    // 与正常保存同路径：新建即一条 revision，且能被搜索到。
    const revisions = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${body.pageId}/revisions`,
        undefined,
        admin
      )
    ).json()) as Array<{ id: string }>
    expect(revisions).toHaveLength(1)

    const search = (await (
      await jsonRequest(env, "GET", "/api/search?q=导入标题", undefined, admin)
    ).json()) as { results: Array<{ pageId: string }> }
    expect(search.results.map((row) => row.pageId)).toContain(body.pageId)
  })

  it("颜色：文字颜色/高亮/单元格底色落成 data 载具，非法色值被丢弃", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const token = await issueToken(env, admin)

    const colorDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "红色",
              marks: [{ type: "textStyle", attrs: { color: "#de350b" } }]
            },
            {
              type: "text",
              text: "高亮",
              marks: [{ type: "highlight", attrs: { color: "#ffe58f" } }]
            },
            {
              type: "text",
              text: "坏色",
              marks: [{ type: "textStyle", attrs: { color: "red" } }]
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
                  attrs: {
                    colspan: 1,
                    rowspan: 1,
                    backgroundColor: "#f4f5f7"
                  },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "表头" }]
                    }
                  ]
                },
                {
                  type: "tableCell",
                  attrs: {
                    colspan: 1,
                    rowspan: 1,
                    backgroundColor: "rgb(255, 250, 230)"
                  },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "格" }]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }

    const res = await importRequest(env, token, "POST", "/api/import/pages", {
      title: "彩色导入",
      contentJson: colorDoc,
      conflict: "create_copy"
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { pageId: string }

    const page = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${body.pageId}`,
        undefined,
        admin
      )
    ).json()) as PageDetail

    // 合法色值：落成与编辑器/粘贴完全同形的 data 载具，且没有任何内联 style。
    expect(page.contentHtml).toContain('data-text-color="#de350b"')
    expect(page.contentHtml).toContain('data-color="#ffe58f"')
    expect(page.contentHtml).toContain('data-cell-bg="#f4f5f7"')
    expect(page.contentHtml).not.toContain("style=")
    // 非法色值（命名色 / rgb()）不是契约形态：载具被丢，文字保留。
    expect(page.contentHtml).toContain("坏色")
    expect(page.contentHtml).not.toContain("rgb(")
    // 正文纯文本不受影响。
    expect(page.contentText).toContain("红色")
    expect(page.contentText).toContain("坏色")
  })

  it("check 命中同名页；conflict=update 覆盖并追加 revision，create_copy 另建一页", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const token = await issueToken(env, admin)

    const first = await importRequest(env, token, "POST", "/api/import/pages", {
      title: "同名页",
      parentId: null,
      contentJson: JSON.stringify(sampleDoc("第一版")),
      conflict: "update"
    })
    expect(first.status).toBe(201)
    const { pageId } = (await first.json()) as { pageId: string }

    const check = await importRequest(env, token, "POST", "/api/import/check", {
      title: "同名页"
    })
    expect(check.status).toBe(200)
    expect(await check.json()).toEqual({ exists: true, pageId })

    const missing = await importRequest(
      env,
      token,
      "POST",
      "/api/import/check",
      { title: "查无此页" }
    )
    expect(await missing.json()).toEqual({ exists: false })

    // contentJson 也接受对象形式（插件侧直接传 JSON 对象，不必先 stringify）。
    const update = await importRequest(
      env,
      token,
      "POST",
      "/api/import/pages",
      {
        title: "同名页",
        parentId: null,
        contentJson: sampleDoc("第二版内容"),
        conflict: "update"
      }
    )
    expect(update.status).toBe(200)
    expect(await update.json()).toEqual({ pageId, url: `/p/${pageId}` })

    const page = (await (
      await jsonRequest(env, "GET", `/api/pages/${pageId}`, undefined, admin)
    ).json()) as PageDetail
    expect(page.contentText).toContain("第二版内容")
    const revisions = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${pageId}/revisions`,
        undefined,
        admin
      )
    ).json()) as Array<{ id: string }>
    expect(revisions).toHaveLength(2)

    // 旧文本随保存同步出索引。
    const stale = (await (
      await jsonRequest(env, "GET", "/api/search?q=第一版", undefined, admin)
    ).json()) as { results: Array<{ pageId: string }> }
    expect(stale.results).toHaveLength(0)

    const copy = await importRequest(env, token, "POST", "/api/import/pages", {
      title: "同名页",
      parentId: null,
      contentJson: sampleDoc("副本内容"),
      conflict: "create_copy"
    })
    expect(copy.status).toBe(201)
    const copied = (await copy.json()) as { pageId: string }
    expect(copied.pageId).not.toBe(pageId)

    const tree = (await (
      await jsonRequest(env, "GET", "/api/pages", undefined, admin)
    ).json()) as Array<{ id: string; title: string }>
    expect(tree.filter((row) => row.title === "同名页")).toHaveLength(2)
  })

  it("导入同一页两次：第二次无改动，不新增 revision、updatedAt 不变", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const token = await issueToken(env, admin)

    const body = {
      title: "幂等导入页",
      parentId: null,
      contentJson: JSON.stringify(sampleDoc("同一份内容")),
      conflict: "update"
    }
    const first = await importRequest(
      env,
      token,
      "POST",
      "/api/import/pages",
      body
    )
    expect(first.status).toBe(201)
    const { pageId } = (await first.json()) as { pageId: string }

    const before = (await (
      await jsonRequest(env, "GET", `/api/pages/${pageId}`, undefined, admin)
    ).json()) as PageDetail

    const second = await importRequest(
      env,
      token,
      "POST",
      "/api/import/pages",
      body
    )
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ pageId, url: `/p/${pageId}` })

    const after = (await (
      await jsonRequest(env, "GET", `/api/pages/${pageId}`, undefined, admin)
    ).json()) as PageDetail
    expect(after.contentText).toBe(before.contentText)
    expect(after.updatedAt).toBe(before.updatedAt)
    const revisions = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${pageId}/revisions`,
        undefined,
        admin
      )
    ).json()) as Array<{ id: string }>
    expect(revisions).toHaveLength(1)

    // 内容真改了仍照旧追加：同一页换个字再导入。
    const changed = await importRequest(
      env,
      token,
      "POST",
      "/api/import/pages",
      { ...body, contentJson: JSON.stringify(sampleDoc("同一份内容!")) }
    )
    expect(changed.status).toBe(200)
    const changedRevisions = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${pageId}/revisions`,
        undefined,
        admin
      )
    ).json()) as Array<{ id: string }>
    expect(changedRevisions).toHaveLength(2)
  })

  it("子页导入：parentId 生效；父页已软删 409 PARENT_DELETED", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const token = await issueToken(env, admin)

    const parent = (await (
      await jsonRequest(
        env,
        "POST",
        "/api/pages",
        {
          title: "父页",
          parentId: null,
          contentJson: JSON.stringify({ type: "doc" }),
          contentHtml: "<p>父</p>",
          contentText: "父"
        },
        admin
      )
    ).json()) as PageDetail

    const child = await importRequest(env, token, "POST", "/api/import/pages", {
      title: "子页",
      parentId: parent.id,
      contentJson: JSON.stringify({ type: "doc" }),
      conflict: "update"
    })
    expect(child.status).toBe(201)
    const childPage = (await child.json()) as { pageId: number }

    const parents = (await (
      await importRequest(env, token, "GET", "/api/import/parents")
    ).json()) as Array<{ id: number; title: string; parentId: number | null }>
    expect(parents).toContainEqual({
      id: childPage.pageId,
      title: "子页",
      parentId: parent.id
    })

    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${parent.id}`,
      undefined,
      admin
    )
    const blocked = await importRequest(
      env,
      token,
      "POST",
      "/api/import/pages",
      {
        title: "孤儿页",
        parentId: parent.id,
        contentJson: JSON.stringify({ type: "doc" }),
        conflict: "update"
      }
    )
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({ code: "PARENT_DELETED" })
  })

  it('parentId 空串按根页处理：不会写出 parent_id="" 的游离页', async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const token = await issueToken(env, admin)

    const res = await importRequest(env, token, "POST", "/api/import/pages", {
      title: "空串父页",
      parentId: "",
      contentJson: JSON.stringify({ type: "doc" }),
      conflict: "update"
    })
    expect(res.status).toBe(201)
    const { pageId } = (await res.json()) as { pageId: number }

    const row = db.db
      .prepare("SELECT parent_id FROM ciki_pages WHERE id = ?")
      .get(pageId) as { parent_id: number | null }
    expect(row.parent_id).toBeNull()

    const parents = (await (
      await importRequest(env, token, "GET", "/api/import/parents")
    ).json()) as Array<{ id: number; title: string; parentId: number | null }>
    expect(parents).toContainEqual({
      id: pageId,
      title: "空串父页",
      parentId: null
    })

    // 空白串同理，不等于任何真实 id。
    const blank = await importRequest(env, token, "POST", "/api/import/check", {
      title: "空串父页",
      parentId: "  "
    })
    expect(blank.status).toBe(200)
    expect(await blank.json()).toEqual({ exists: true, pageId })
  })

  it("限流响应的 retryAfter 是当前窗口剩余秒数（不是固定 300）", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await issueToken(env, admin)
    const now = Math.floor(Date.now() / 1000)

    // 第 20 次失败落在窗口第 290 秒：应只回 ~10 秒，而不是整窗 300 秒。
    db.db
      .prepare(
        "INSERT INTO ciki_auth_counters (key, action, account, ip, count, window_start, locked_until, updated_at) VALUES (?, 'import_auth_fail', '', 'unknown', 19, ?, NULL, ?)"
      )
      .run("import_auth_fail::unknown", now - 290, now)

    const res = await importRequest(env, "wrong", "GET", "/api/import/parents")
    expect(res.status).toBe(429)
    const body = (await res.json()) as { retryAfter: number }
    expect(body.retryAfter).toBeGreaterThanOrEqual(1)
    expect(body.retryAfter).toBeLessThanOrEqual(11)
  })

  it("POST /api/import/files 复用 /api/files 的校验与 R2 口径：只收图片、返回 {url}", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)
    const token = await issueToken(env, admin)

    const form = new FormData()
    form.append("file", new File([PNG], "a.png", { type: "image/png" }))
    const res = await request(env, "/api/import/files", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { key: string; url: string }
    expect(body.url).toBe(`/api/files/${body.key}`)
    expect(body.key).toMatch(/^imports\/[0-9a-f-]{36}\.png$/)
    expect(r2.store.has(body.key)).toBe(true)
    // 落盘归属是令牌对应的用户（会话用户这里同样可用）。
    expect(r2.store.get(body.key)?.customMetadata?.uploaderId).toBeTruthy()

    const svgForm = new FormData()
    svgForm.append(
      "file",
      new File(["<svg xmlns='http://www.w3.org/2000/svg'></svg>"], "a.svg", {
        type: "image/svg+xml"
      })
    )
    const svg = await request(env, "/api/import/files", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: svgForm
    })
    expect(svg.status).toBe(400)
  })

  it("参数与内容校验：conflict/标题/parentId 400，schema 不符 400 INVALID_CONTENT_JSON，超限 413", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const token = await issueToken(env, admin)

    const base = {
      title: "校验页",
      parentId: null,
      contentJson: JSON.stringify({ type: "doc" }),
      conflict: "update"
    }

    const badConflict = await importRequest(
      env,
      token,
      "POST",
      "/api/import/pages",
      { ...base, conflict: "merge" }
    )
    expect(badConflict.status).toBe(400)

    const noTitle = await importRequest(
      env,
      token,
      "POST",
      "/api/import/pages",
      {
        ...base,
        title: "  "
      }
    )
    expect(noTitle.status).toBe(400)

    // 形状不合法（非整数）→ 400；形状合法但不存在的父页 → 404。
    const badParent = await importRequest(
      env,
      token,
      "POST",
      "/api/import/pages",
      { ...base, parentId: "abc" }
    )
    expect(badParent.status).toBe(400)

    const missingParent = await importRequest(
      env,
      token,
      "POST",
      "/api/import/pages",
      { ...base, parentId: 424_242 }
    )
    expect(missingParent.status).toBe(404)

    // check 与保存同一口径：标题按纯文本规范化后必须 1–255 字符。
    const tooLongCheck = await importRequest(
      env,
      token,
      "POST",
      "/api/import/check",
      { title: "长".repeat(256) }
    )
    expect(tooLongCheck.status).toBe(400)
    expect(await tooLongCheck.json()).toEqual({
      error: "Title must be 1-255 characters"
    })
    const maxLengthCheck = await importRequest(
      env,
      token,
      "POST",
      "/api/import/check",
      { title: "长".repeat(255) }
    )
    expect(maxLengthCheck.status).toBe(200)
    expect(await maxLengthCheck.json()).toEqual({ exists: false })
    const emptyCheck = await importRequest(
      env,
      token,
      "POST",
      "/api/import/check",
      { title: "   " }
    )
    expect(emptyCheck.status).toBe(400)

    const badJson = await importRequest(
      env,
      token,
      "POST",
      "/api/import/pages",
      {
        ...base,
        contentJson: "{not json"
      }
    )
    expect(badJson.status).toBe(400)
    expect(await badJson.json()).toMatchObject({ code: "INVALID_CONTENT_JSON" })

    const unknownNode = await importRequest(
      env,
      token,
      "POST",
      "/api/import/pages",
      {
        ...base,
        contentJson: JSON.stringify({
          type: "doc",
          content: [{ type: "iframe" }]
        })
      }
    )
    expect(unknownNode.status).toBe(400)
    expect(await unknownNode.json()).toMatchObject({
      code: "INVALID_CONTENT_JSON"
    })

    const unknownAttr = await importRequest(
      env,
      token,
      "POST",
      "/api/import/pages",
      {
        ...base,
        contentJson: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              attrs: { onclick: "alert(1)" },
              content: [{ type: "text", text: "x" }]
            }
          ]
        })
      }
    )
    expect(unknownAttr.status).toBe(400)
    expect(await unknownAttr.json()).toMatchObject({
      code: "INVALID_CONTENT_JSON"
    })

    const huge = await importRequest(env, token, "POST", "/api/import/pages", {
      ...base,
      contentJson: JSON.stringify({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "x".repeat(800_001) }]
          }
        ]
      })
    })
    expect(huge.status).toBe(413)
    expect(await huge.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" })
  })

  it("调用额度按用户限流：import 计数到 3000 后 429（窗口内）", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const token = await issueToken(env, admin)

    const user = db.db
      .prepare("SELECT id FROM ciki_users WHERE email = ?")
      .get("admin@example.com") as { id: string }
    const now = Math.floor(Date.now() / 1000)
    db.db
      .prepare(
        "INSERT INTO ciki_auth_counters (key, action, account, ip, count, window_start, locked_until, updated_at) VALUES (?, 'import', ?, '', 3000, ?, NULL, ?)"
      )
      .run(`import:${user.id}:`, user.id, now, now)

    const res = await importRequest(env, token, "GET", "/api/import/parents")
    expect(res.status).toBe(429)
    const limited = (await res.json()) as { code: string; retryAfter: number }
    expect(limited.code).toBe("RATE_LIMITED")
    // 刚开的窗口：剩余时间应接近整窗，而不是写死或超出窗口。
    expect(limited.retryAfter).toBeGreaterThanOrEqual(290)
    expect(limited.retryAfter).toBeLessThanOrEqual(300)

    // 计数窗口过期后自动恢复。
    db.db
      .prepare("UPDATE ciki_auth_counters SET window_start = ? WHERE key = ?")
      .run(now - 301, `import:${user.id}:`)
    const recovered = await importRequest(
      env,
      token,
      "GET",
      "/api/import/parents"
    )
    expect(recovered.status).toBe(200)
  })

  it("令牌爆破按 IP 限流：连续失败 20 次后 429，此后正确令牌也被挡（5 分钟窗口）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const token = await issueToken(env, admin)

    for (let attempt = 1; attempt <= 19; attempt++) {
      const res = await importRequest(
        env,
        "wrong-token",
        "GET",
        "/api/import/parents"
      )
      expect(res.status).toBe(401)
    }
    const twentieth = await importRequest(
      env,
      "wrong-token",
      "GET",
      "/api/import/parents"
    )
    expect(twentieth.status).toBe(429)
    expect(await twentieth.json()).toMatchObject({ code: "RATE_LIMITED" })

    const blocked = await importRequest(
      env,
      token,
      "GET",
      "/api/import/parents"
    )
    expect(blocked.status).toBe(429)
  })
})

describe("导入：空间列表、落点与越权", () => {
  it("按令牌用户可编辑空间列空间；space_id 控制落点，无权空间 403", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const editor = await userSession(env, admin, "importer@example.com")
    const viewer = await userSession(env, admin, "readonly@example.com")

    const spaces = (await (
      await jsonRequest(env, "GET", "/api/spaces", undefined, admin)
    ).json()) as Array<{ id: string; isDefault: boolean }>
    const defaultSpace = spaces.find((row) => row.isDefault)
    if (!defaultSpace) throw new Error("default space missing")

    const createSpace = async (name: string): Promise<string> => {
      const res = await jsonRequest(env, "POST", "/api/spaces", { name }, admin)
      expect(res.status).toBe(201)
      return ((await res.json()) as { id: string }).id
    }
    const editSpace = await createSpace("导入空间")
    const viewSpace = await createSpace("只读空间")

    const me = async (cookie: string) =>
      (await (
        await jsonRequest(env, "GET", "/api/me", undefined, cookie)
      ).json()) as { id: string }
    const addMember = async (spaceId: string, userId: string, role: string) => {
      const res = await jsonRequest(
        env,
        "POST",
        `/api/spaces/${spaceId}/members`,
        { userId, role },
        admin
      )
      expect(res.status).toBe(201)
    }
    await addMember(editSpace, (await me(editor)).id, "editor")
    await addMember(viewSpace, (await me(viewer)).id, "viewer")

    const editorToken = await issueToken(env, editor)
    const viewerToken = await issueToken(env, viewer)

    const editorSpaces = (await (
      await importRequest(env, editorToken, "GET", "/api/import/spaces")
    ).json()) as Array<{ id: string; name: string }>
    expect(editorSpaces.map((row) => row.id)).toEqual([
      defaultSpace.id,
      editSpace
    ])
    expect(editorSpaces[1].name).toBe("导入空间")

    const viewerSpaces = (await (
      await importRequest(env, viewerToken, "GET", "/api/import/spaces")
    ).json()) as Array<{ id: string }>
    expect(viewerSpaces.map((row) => row.id)).toEqual([defaultSpace.id])
    expect(viewerSpaces.map((row) => row.id)).not.toContain(viewSpace)

    const importPage = (
      token: string,
      title: string,
      spaceId?: string,
      parentId: string | null = null
    ) =>
      importRequest(env, token, "POST", "/api/import/pages", {
        title,
        parentId,
        space_id: spaceId,
        contentJson: JSON.stringify({ type: "doc" }),
        conflict: "create_copy"
      })

    const byDefault = await importPage(editorToken, "默认落点")
    expect(byDefault.status).toBe(201)
    const defaultPage = (await byDefault.json()) as { pageId: string }
    const defaultDetail = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${defaultPage.pageId}`,
        undefined,
        admin
      )
    ).json()) as { spaceId: string }
    expect(defaultDetail.spaceId).toBe(defaultSpace.id)

    const inEditSpace = await importPage(editorToken, "B 落点", editSpace)
    expect(inEditSpace.status).toBe(201)
    const editPage = (await inEditSpace.json()) as { pageId: string }
    const editDetail = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${editPage.pageId}`,
        undefined,
        admin
      )
    ).json()) as { spaceId: string }
    expect(editDetail.spaceId).toBe(editSpace)

    const denied = await importPage(editorToken, "越权落点", viewSpace)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ code: "SPACE_FORBIDDEN" })

    // parents 按空间过滤。
    const parents = (await (
      await importRequest(
        env,
        editorToken,
        "GET",
        `/api/import/parents?space_id=${editSpace}`
      )
    ).json()) as Array<{ id: string; title: string }>
    expect(parents.map((row) => row.id)).toEqual([editPage.pageId])
    expect(parents.map((row) => row.title)).not.toContain("默认落点")

    // check 的同名匹配限定在目标空间内。
    const checkOther = await importRequest(
      env,
      editorToken,
      "POST",
      "/api/import/check",
      { title: "默认落点", parentId: null, space_id: editSpace }
    )
    expect(checkOther.status).toBe(200)
    expect(await checkOther.json()).toEqual({ exists: false })

    const checkSame = await importRequest(
      env,
      editorToken,
      "POST",
      "/api/import/check",
      { title: "B 落点", parentId: null, space_id: editSpace }
    )
    expect(await checkSame.json()).toEqual({
      exists: true,
      pageId: editPage.pageId
    })

    // 父页属于另一个空间 → 409。
    const crossParent = await importPage(
      editorToken,
      "跨空间父页",
      editSpace,
      defaultPage.pageId
    )
    expect(crossParent.status).toBe(409)
    expect(await crossParent.json()).toMatchObject({ code: "SPACE_MISMATCH" })

    // 令牌用户看不见的父页按不存在处理：不能借 409 探测别的空间里的页面。
    const hiddenParent = await importPage(
      viewerToken,
      "探测父页",
      undefined,
      editPage.pageId
    )
    expect(hiddenParent.status).toBe(404)
  })
})
