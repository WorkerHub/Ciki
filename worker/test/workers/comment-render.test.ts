/**
 * 评论渲染路径在 **workerd** 里的回归护栏（Node 侧的完整用例是
 * `test/comment-render.test.ts` 与 `test/comments.test.ts`）。
 *
 * 与 `import-render.test.ts` 同一个理由：`marked` 是新增依赖，它的 ESM 入口与
 * sanitize 链在 Node 与 Workers 下的模块解析环境不同；线上跑的是 workerd，所以把
 * 「Markdown → HTML → 白名单净化」这条链在真实运行时里钉一遍，避免 Node 全绿、
 * 线上才炸。用例自带内容，不依赖 `test/support/*`（那套是 Node 专用的 D1/R2 替身）。
 */
import { describe, expect, it } from "vitest"
import { normalizeCommentBody } from "../../src/lib/comment-input"
import { renderCommentHtml } from "../../src/lib/comment-render"

describe("workerd：评论 Markdown 渲染与净化", () => {
  it("结构、代码语言标注与 https 图片照常渲出", () => {
    const html = renderCommentHtml(
      [
        "## 小节",
        "",
        "- 一",
        "",
        "```ts",
        "const a: number = 1",
        "```",
        "",
        "![图](https://cdn.example.com/a.png)"
      ].join("\n")
    )
    expect(html).toContain("<h2>小节</h2>")
    expect(html).toContain("<li>一</li>")
    expect(html).toContain('class="language-ts"')
    expect(html).toContain('src="https://cdn.example.com/a.png"')
  })

  it("script、事件属性、javascript: 链接与 http 图片都被净化", () => {
    const html = renderCommentHtml(
      [
        "正文<script>alert(1)</script>",
        "",
        '<img src="x" onerror="alert(1)">',
        "",
        "[坏链](javascript:alert(1))",
        "",
        "![明文](http://cdn.example.com/a.png)"
      ].join("\n")
    )
    expect(html).not.toContain("<script")
    expect(html).not.toContain("alert(1)")
    expect(html).not.toContain("onerror")
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("http://cdn.example.com")
    expect(html).toContain("正文")
  })

  it("发表路径的归一口径在 workerd 下一致：CRLF 归一、空正文拒绝", () => {
    const ok = normalizeCommentBody("第一行\r\n第二行")
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.value.bodyMd).toBe("第一行\n第二行")
      expect(ok.value.html).toContain("<br>")
    }

    const empty = normalizeCommentBody("   \n  ")
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.code).toBe("COMMENT_EMPTY")
  })
})
