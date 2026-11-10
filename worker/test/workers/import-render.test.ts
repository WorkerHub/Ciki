/**
 * 导入渲染路径在 **workerd** 里的回归护栏（Node 侧的完整用例仍是 `test/import.test.ts`）。
 *
 * 为什么需要：CI 全绿也不代表线上能跑。#32 的线上报错就发生在 Node 条件下绿着的时候——
 * `contentJson` → HTML 的渲染在 Node 与 Workers 下模块解析、可用 API 都不同
 * （`@tiptap/html` 的两个入口、happy-dom 的 `Window` 需要 vm 上下文）。这里把
 * 「同一份 TipTap JSON 在 Worker 运行时里渲染成什么」钉死，Node 侧用例保持原样。
 *
 * 断言与 `test/import.test.ts` 的保真/安全口径对齐，但用例自带内容，不依赖
 * `test/support/*`（那套是 Node 专用的 D1/R2 替身）。
 */
import { describe, expect, it } from "vitest"
import { normalizeImportedContent } from "../../src/lib/page-input"

/** 覆盖 §5 保真项：代码语言、表格列宽、任务勾选、坏链、外链图。 */
function sampleDoc() {
  return {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: "导入标题" }]
      },
      { type: "paragraph", content: [{ type: "text", text: "导入正文" }] },
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
          confluenceImg: false
        }
      }
    ]
  }
}

describe("导入渲染：在 Worker 运行时里跑", () => {
  it("确实运行在 workerd 而不是 Node", () => {
    // 防止配置哪天被改回 Node 后这组用例仍然「绿」——那就等于没测。
    expect(navigator.userAgent).toContain("Cloudflare-Workers")
  })

  it("渲染保真：代码语言、表格列宽、任务勾选态都保留", () => {
    const doc = sampleDoc()
    const result = normalizeImportedContent({
      title: "  导入页  ",
      contentJson: JSON.stringify(doc)
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.title).toBe("导入页")
    // 原样落库的 TipTap JSON；HTML 是服务端渲染 + 消毒的结果。
    expect(result.value.contentJson).toBe(JSON.stringify(doc))
    expect(result.value.contentHtml).toContain('<code class="language-sql">')
    expect(result.value.contentHtml).toContain('<col width="120">')
    expect(result.value.contentHtml).toContain('<col width="80">')
    expect(result.value.contentHtml).toContain('data-checked="true"')
    expect(result.value.contentHtml).toContain('data-type="taskItem"')
    expect(result.value.contentHtml).toContain('class="tableWrapper"')
  })

  it("消毒为准：坏链被剥、外链图降级为未转存、contentText 来自消毒后 HTML", () => {
    const result = normalizeImportedContent({
      title: "导入页",
      contentJson: JSON.stringify(sampleDoc())
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.contentHtml).not.toContain("javascript:")
    expect(result.value.contentHtml).not.toContain("<script")
    expect(result.value.contentHtml).toContain(
      'data-original-src="https://confluence.example/download/a.png"'
    )
    expect(result.value.contentHtml).toContain('data-confluence-img="true"')
    expect(result.value.contentText).toContain("导入正文")
    expect(result.value.contentText).not.toContain("<")
  })

  it("代码块折叠态：三态在 Worker 运行时里同样落在 pre[data-collapsed] 上", () => {
    // 与 test/code-block-collapse.test.ts 同一口径，但跑在 workerd：这条标记要过
    // 真实的 happy-dom + xss 打包路径（#32 的教训：Node 下绿不等于线上绿）。
    const render = (attrs: Record<string, unknown>) =>
      normalizeImportedContent({
        title: "折叠",
        contentJson: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "codeBlock",
              attrs,
              content: [{ type: "text", text: "line 1\nline 2" }]
            }
          ]
        })
      })

    const folded = render({ language: "js", collapsed: true })
    expect(folded.ok).toBe(true)
    if (!folded.ok) return
    expect(folded.value.contentHtml).toContain(
      '<pre data-collapsed="true"><code class="language-js">'
    )

    const expanded = render({ language: "js", collapsed: false })
    expect(expanded.ok).toBe(true)
    if (!expanded.ok) return
    expect(expanded.value.contentHtml).toContain('<pre data-collapsed="false">')

    const unstated = render({ language: "js" })
    expect(unstated.ok).toBe(true)
    if (!unstated.ok) return
    expect(unstated.value.contentHtml).not.toContain("data-collapsed")
    expect(unstated.value.contentHtml).toContain(
      '<pre><code class="language-js">'
    )

    const broken = render({ language: "js", collapsed: "true" })
    expect(broken.ok).toBe(false)
    if (broken.ok) return
    expect(broken.code).toBe("INVALID_CONTENT_JSON")
  })

  it("渲染不了的 contentJson 按契约报 INVALID_CONTENT_JSON", () => {
    const result = normalizeImportedContent({
      title: "坏内容",
      contentJson: { type: "doc", content: [{ type: "iframe" }] }
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("INVALID_CONTENT_JSON")
  })
})
