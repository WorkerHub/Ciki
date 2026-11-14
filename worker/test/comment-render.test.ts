/**
 * 评论渲染与净化（规格「页尾评论」§三）：
 * - Markdown → HTML 用现成的 marked，渲染结果必须过站内同一份白名单（sanitizeCommentHtml）；
 * - XSS 夹具（script、事件属性、javascript: 链接）全被净化；
 * - 图片口径：站内 `/api/files/…` 与 `https:` 外链直接保留，其它来源剥除 src。
 */
import { describe, expect, it } from "vitest"
import { renderCommentHtml } from "../src/lib/comment-render"

const UUID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"

describe("评论 Markdown 渲染：结构与代码块", () => {
  it("标题、列表、引用、链接、围栏代码按 GFM 渲染", () => {
    const html = renderCommentHtml(
      [
        "## 小节",
        "",
        "- 一",
        "- 二",
        "",
        "> 引用一句",
        "",
        "```js",
        "const a = 1",
        "```",
        "",
        "[站内链接](/pages/1)"
      ].join("\n")
    )

    expect(html).toContain("<h2>小节</h2>")
    expect(html).toContain("<ul>")
    expect(html).toContain("<li>一</li>")
    expect(html).toContain("<blockquote>")
    expect(html).toContain('<pre><code class="language-js">')
    expect(html).toContain("const a = 1")
    expect(html).toContain('<a href="/pages/1">站内链接</a>')
  })

  it("代码围栏的语言标注保留（与正文代码块同一个 class 口径），非法 class 被剥", () => {
    const html = renderCommentHtml(
      [
        "```ts",
        "const a: number = 1",
        "```",
        "",
        '<pre><code class="evil">x</code></pre>'
      ].join("\n")
    )
    expect(html).toContain('class="language-ts"')
    expect(html).not.toContain('class="evil"')
  })

  it("单个换行也算换行（breaks: true），空正文是空串", () => {
    expect(renderCommentHtml("第一行\n第二行")).toContain("<br>")
    expect(renderCommentHtml("")).toBe("")
  })
})

describe("评论渲染：XSS 夹具全被净化", () => {
  it("剥除 script 正文、内联事件与 javascript: 链接", () => {
    const html = renderCommentHtml(
      [
        "正文<script>alert(1)</script>",
        "",
        '<img src="x" onerror="alert(1)">',
        "",
        '<p onclick="steal()">点我</p>',
        "",
        "[恶意链接](javascript:alert(1))"
      ].join("\n")
    )

    expect(html).not.toContain("<script")
    expect(html).not.toContain("alert(1)")
    expect(html).not.toContain("onerror")
    expect(html).not.toContain("onclick")
    expect(html).not.toContain("javascript:")
    expect(html).toContain("正文")
    expect(html).toContain("点我")
  })

  it("原始 HTML 混写只留白名单内的标签与属性", () => {
    const html = renderCommentHtml(
      '<h2 style="color:red" id="x">标题</h2><iframe src="https://evil"></iframe><form></form>'
    )
    expect(html).toContain("<h2>标题</h2>")
    expect(html).not.toContain("style")
    expect(html).not.toContain("id=")
    expect(html).not.toContain("iframe")
    expect(html).not.toContain("form")
  })
})

describe("评论渲染：图片口径", () => {
  it("站内 /api/files 与 https 外链原样保留", () => {
    const html = renderCommentHtml(
      `![站内](/api/files/pages/${UUID}.png)\n\n![外链](https://cdn.example.com/a.png)`
    )
    expect(html).toContain(`src="/api/files/pages/${UUID}.png"`)
    expect(html).toContain('src="https://cdn.example.com/a.png"')
    // 评论区不写「未转存」占位属性。
    expect(html).not.toContain("data-confluence-img")
  })

  it("http、data: 与 javascript: 来源一律剥除 src", () => {
    const html = renderCommentHtml(
      [
        "![明文](http://cdn.example.com/a.png)",
        "",
        "![内联](data:image/png;base64,AAAA)",
        "",
        "![脚本](javascript:alert(1))"
      ].join("\n")
    )
    expect(html).not.toContain("http://cdn.example.com")
    expect(html).not.toContain("data:image")
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("src=")
  })
})
