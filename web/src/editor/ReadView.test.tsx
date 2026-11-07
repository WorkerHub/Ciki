import { render, screen } from "@testing-library/react"
import { beforeAll, describe, expect, it } from "vitest"
import { ReadView } from "@/editor/ReadView"
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
