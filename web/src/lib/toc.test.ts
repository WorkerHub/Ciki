import { describe, expect, it } from "vitest"
import { extractToc } from "@/lib/toc"

/** 正文 HTML 片段（与 worker 下发的 contentHtml 同形态：顶层块平铺）。 */
function html(...parts: string[]): string {
  return parts.join("")
}

describe("索引提取（extractToc）", () => {
  it("按文档顺序取 1–3 级的层级与文字，id 位置式生成", () => {
    const content = html(
      "<h1>支付服务部署</h1>",
      "<p>正文段落不算标题</p>",
      "<h2>配置表</h2>",
      "<h3>端口与超时</h3>"
    )

    expect(extractToc(content)).toEqual([
      { id: "heading-1", level: 1, text: "支付服务部署" },
      { id: "heading-2", level: 2, text: "配置表" },
      { id: "heading-3", level: 3, text: "端口与超时" }
    ])
  })

  it("标题文字拼接全部行内标记（加粗/行内代码/链接里的文字都算）", () => {
    const content = html(
      `<h2>配置<strong>表</strong>：<code>生产环境</code><a href="https://example.com">文档</a></h2>`,
      "<h2>第二个标题</h2>"
    )

    expect(extractToc(content)[0].text).toBe("配置表：生产环境文档")
  })

  it("空标题（无文字或只有空白）跳过，不影响后面的顺序 id", () => {
    const content = html(
      "<h1></h1>",
      "<h2>   </h2>",
      "<h2>真正的第一节</h2>",
      "<h3>真正的第二节</h3>"
    )

    expect(extractToc(content)).toEqual([
      { id: "heading-1", level: 2, text: "真正的第一节" },
      { id: "heading-2", level: 3, text: "真正的第二节" }
    ])
  })

  it("不足 2 条有效标题时返回空（整篇不显示索引）", () => {
    expect(extractToc("")).toEqual([])
    expect(extractToc("<p>没有标题</p>")).toEqual([])
    expect(extractToc("<h2>只有一个标题</h2>")).toEqual([])
  })

  it("同名标题按顺序各自拿到 id", () => {
    const content = html("<h1>部署</h1>", "<h2>部署</h2>", "<h1>部署</h1>")

    expect(extractToc(content).map((item) => item.id)).toEqual([
      "heading-1",
      "heading-2",
      "heading-3"
    ])
    expect(extractToc(content).map((item) => item.text)).toEqual([
      "部署",
      "部署",
      "部署"
    ])
  })

  it("只收 1–3 级：4–6 级一律跳过", () => {
    const content = html(
      "<h4>四级</h4>",
      "<h5>五级</h5>",
      "<h6>六级</h6>",
      "<h2>二级甲</h2>",
      "<h2>二级乙</h2>"
    )

    expect(extractToc(content).map((item) => item.text)).toEqual([
      "二级甲",
      "二级乙"
    ])
  })

  it("只认顶层块：引用块、列表、表格里的标题都不算", () => {
    const content = html(
      '<pre><code class="language-markdown"># 这不是标题</code></pre>',
      "<blockquote><h2>引用里的标题</h2></blockquote>",
      "<ul><li><h2>列表里的标题</h2></li></ul>",
      "<table><tbody><tr><td><h3>单元格标题</h3></td></tr></tbody></table>",
      "<h2>顶层甲</h2>",
      "<h2>顶层乙</h2>"
    )

    expect(extractToc(content).map((item) => item.text)).toEqual([
      "顶层甲",
      "顶层乙"
    ])
  })
})
