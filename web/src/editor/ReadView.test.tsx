import { render, screen, waitFor } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { ReadView } from "@/editor/ReadView"
import { extractToc } from "@/lib/toc"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"

const html = [
  "<h2>2. 配置表</h2>",
  '<pre><code class="language-sql">select 1;</code></pre>',
  '<table><colgroup><col style="width: 120px;"><col style="width: 240px;"></colgroup>',
  "<tbody><tr><th>环境</th><th>值</th></tr><tr><td>生产</td><td>3000ms</td></tr></tbody></table>",
  '<p><img alt="架构图" data-original-src="https://confluence.example.com/download/attachments/1/arch.png" data-confluence-img="true"></p>'
].join("")

describe("阅读态渲染（与编辑态共用同一套扩展）", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  it("代码块显示语言角标与复制按钮", async () => {
    render(<ReadView html={html} />)
    expect(await screen.findByText("SQL")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "复制代码" })).toBeInTheDocument()
  })

  it("未转存图片渲染成占位，并保留原始链接", async () => {
    render(<ReadView html={html} />)
    expect(await screen.findByText("未转存的图片")).toBeInTheDocument()
    const link = screen.getByRole("link", { name: /download\/attachments/ })
    expect(link).toHaveAttribute(
      "href",
      "https://confluence.example.com/download/attachments/1/arch.png"
    )
    // 阅读态不提供上传按钮，替换动作在编辑页完成
    expect(screen.queryByRole("button", { name: "上传替换" })).toBeNull()
  })

  it("原地址是危险协议时只显示纯文本、不给链接", async () => {
    render(
      <ReadView
        html={
          '<p><img alt="x" data-original-src="javascript:alert(1)" data-confluence-img="true"></p>'
        }
      />
    )
    expect(await screen.findByText("未转存的图片")).toBeInTheDocument()
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByText("javascript:alert(1)")).toBeInTheDocument()
  })

  it("本站图片直接显示", async () => {
    render(
      <ReadView html={'<p><img src="/api/files/abc.png" alt="示意图"></p>'} />
    )
    const image = await screen.findByRole("img", { name: "示意图" })
    expect(image).toHaveAttribute("src", "/api/files/abc.png")
  })

  it("表格列宽从 colgroup 还原到单元格 colwidth", async () => {
    render(<ReadView html={html} />)
    const table = await screen.findByRole("table")
    // TipTap 渲染自己的 colgroup（px 宽度来自 colwidth），表格不再撑满行宽
    expect(table.querySelectorAll("col").length).toBe(2)
    expect(table.querySelector("col")?.getAttribute("style")).toContain("120px")
  })
})

/**
 * 颜色支持批次：入库的 contentHtml 只带 data 载具（消毒层剥掉所有 style），
 * 读态必须由扩展还原成真实内联样式 —— 这是「保存后阅读一致」的服务端形态证据。
 */
describe("阅读态颜色（入库形态 → 渲染）", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  const stored = [
    '<p><span data-text-color="#de350b">红色警告</span><mark data-color="#ffe58f">高亮</mark></p>',
    '<table><tbody><tr><th data-cell-bg="#f4f5f7">环境</th><td data-cell-bg="#fffae6">生产</td></tr></tbody></table>'
  ].join("")

  it("文字颜色渲染成内联 color", async () => {
    const { container } = render(<ReadView html={stored} />)
    await screen.findByText("红色警告")
    const span = container.querySelector("span[data-text-color]")
    expect(span).not.toBeNull()
    expect((span as HTMLElement).style.color).toBe("rgb(222, 53, 11)")
  })

  it("高亮渲染成内联背景色", async () => {
    const { container } = render(<ReadView html={stored} />)
    await screen.findByText("高亮")
    const mark = container.querySelector("mark[data-color]")
    expect(mark).not.toBeNull()
    expect((mark as HTMLElement).style.backgroundColor).toBe(
      "rgb(255, 229, 143)"
    )
  })

  it("单元格底色渲染成内联背景色（表头与数据格都算）", async () => {
    const { container } = render(<ReadView html={stored} />)
    await screen.findByRole("table")
    const header = container.querySelector("th[data-cell-bg]")
    const cell = container.querySelector("td[data-cell-bg]")
    expect((header as HTMLElement).style.backgroundColor).toBe(
      "rgb(244, 245, 247)"
    )
    expect((cell as HTMLElement).style.backgroundColor).toBe(
      "rgb(255, 250, 230)"
    )
  })

  it("没有颜色载具的内容不产生任何颜色样式", async () => {
    const { container } = render(<ReadView html={"<p>纯文字</p>"} />)
    await screen.findByText("纯文字")
    expect(container.querySelector("[data-text-color]")).toBeNull()
    expect(container.querySelector("mark")).toBeNull()
    expect(container.querySelector("[data-cell-bg]")).toBeNull()
  })
})

/**
 * 索引轨的锚点：id 由 contentJson 提取、位置式生成，渲染就绪后按文档顺序
 * 补到顶层标题上——这里验「提取计数 = 实赋 id 的标题数」在代表性文档上一致。
 */
describe("标题锚点（索引轨用）", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  const contentJson = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "部署" }]
      },
      {
        type: "codeBlock",
        content: [{ type: "text", text: "# 不是标题" }]
      },
      // 空标题：提取时跳过，DOM 里仍会渲染出一个空 h2
      { type: "heading", attrs: { level: 2 }, content: [] },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "部署" }]
      },
      {
        type: "heading",
        attrs: { level: 3 },
        content: [
          { type: "text", text: "配置" },
          { type: "text", text: "表", marks: [{ type: "bold" }] }
        ]
      }
    ]
  })
  const contentHtml = [
    "<h2>部署</h2>",
    '<pre><code class="language-markdown"># 不是标题</code></pre>',
    "<h2></h2>",
    "<h2>部署</h2>",
    "<h3>配置<strong>表</strong></h3>"
  ].join("")

  it("按提取结果给顶层标题补 id，并把正文根元素交回调用方", async () => {
    const items = extractToc(contentJson)
    const onReady = vi.fn()
    render(
      <ReadView
        html={contentHtml}
        headingIds={items.map((item) => item.id)}
        onReady={onReady}
      />
    )

    await screen.findAllByRole("heading")
    await waitFor(() => expect(onReady).toHaveBeenCalled())

    const root = onReady.mock.calls[0][0] as HTMLElement
    const allHeadings = Array.from(
      root.querySelectorAll(":scope > h1, :scope > h2, :scope > h3")
    )
    const headings = allHeadings.filter((heading) =>
      Boolean(heading.textContent?.trim())
    )
    // 空标题没抢走锚点：带 id 的标题数与提取条数一致
    expect(allHeadings).toHaveLength(items.length + 1)
    expect(headings).toHaveLength(items.length)
    expect(
      root.querySelectorAll(":scope > h1[id], :scope > h2[id], :scope > h3[id]")
    ).toHaveLength(items.length)
    expect(headings.map((heading) => heading.id)).toEqual(
      items.map((item) => item.id)
    )
    expect(headings.map((heading) => heading.textContent)).toEqual(
      items.map((item) => item.text)
    )
  })

  it("空标题在文档开头时不占用 heading-1，后面的标题不错位", async () => {
    const json = JSON.stringify({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [] },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "甲" }]
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "乙" }]
        }
      ]
    })
    const items = extractToc(json)
    const onReady = vi.fn()
    render(
      <ReadView
        html={"<h2></h2><h2>甲</h2><h2>乙</h2>"}
        headingIds={items.map((item) => item.id)}
        onReady={onReady}
      />
    )

    await screen.findByText("甲")
    await waitFor(() => expect(onReady).toHaveBeenCalled())
    const root = onReady.mock.calls[0][0] as HTMLElement
    const [empty, first, second] = Array.from(
      root.querySelectorAll<HTMLElement>(":scope > h2")
    )
    expect(empty).not.toHaveAttribute("id")
    expect(first).toHaveAttribute("id", "heading-1")
    expect(second).toHaveAttribute("id", "heading-2")
  })

  it("传了更多 id 时只补给真实存在的标题，不多不少", async () => {
    const onReady = vi.fn()
    render(
      <ReadView
        html={"<h2>唯一标题</h2>"}
        headingIds={["heading-1", "heading-2"]}
        onReady={onReady}
      />
    )

    const heading = await screen.findByRole("heading", { level: 2 })
    await waitFor(() => expect(onReady).toHaveBeenCalled())
    expect(heading).toHaveAttribute("id", "heading-1")
    expect(document.getElementById("heading-2")).toBeNull()
  })

  it("不传 headingIds 时不加锚点（版本预览不受影响）", async () => {
    const { container } = render(<ReadView html={contentHtml} />)
    await screen.findAllByRole("heading")
    expect(container.querySelectorAll("h1[id], h2[id], h3[id]")).toHaveLength(0)
  })
})
