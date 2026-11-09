import { describe, expect, it } from "vitest"
import { extractToc } from "@/lib/toc"

/** 构造 TipTap 文档形态的 contentJson（只写测试关心到的字段）。 */
function doc(...content: unknown[]): string {
  return JSON.stringify({ type: "doc", content })
}

function heading(level: number | string, ...texts: string[]) {
  return {
    type: "heading",
    attrs: { level },
    content: texts.map((text) => ({ type: "text", text }))
  }
}

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] }
}

describe("索引提取（extractToc）", () => {
  it("按文档顺序取 1–3 级的层级与文字，id 位置式生成", () => {
    const json = doc(
      heading(1, "支付服务部署"),
      paragraph("正文段落不算标题"),
      heading(2, "配置表"),
      heading(3, "端口与超时")
    )

    expect(extractToc(json)).toEqual([
      { id: "heading-1", level: 1, text: "支付服务部署" },
      { id: "heading-2", level: 2, text: "配置表" },
      { id: "heading-3", level: 3, text: "端口与超时" }
    ])
  })

  it("标题文字拼接全部行内标记（加粗/行内代码/链接里的文字都算）", () => {
    const json = doc(
      {
        type: "heading",
        attrs: { level: 2 },
        content: [
          { type: "text", text: "配置" },
          { type: "text", text: "表", marks: [{ type: "bold" }] },
          { type: "text", text: "：", marks: [{ type: "code" }] },
          {
            type: "text",
            text: "生产环境",
            marks: [{ type: "link", attrs: { href: "https://example.com" } }]
          }
        ]
      },
      heading(2, "第二个标题")
    )

    expect(extractToc(json)[0].text).toBe("配置表：生产环境")
  })

  it("空标题（无文字或只有空白）跳过，不影响后面的顺序 id", () => {
    const json = doc(
      { type: "heading", attrs: { level: 1 }, content: [] },
      heading(2, "   "),
      heading(2, "真正的第一节"),
      heading(3, "真正的第二节")
    )

    expect(extractToc(json)).toEqual([
      { id: "heading-1", level: 2, text: "真正的第一节" },
      { id: "heading-2", level: 3, text: "真正的第二节" }
    ])
  })

  it("不足 2 条有效标题时返回空（整篇不显示索引）", () => {
    expect(extractToc(doc())).toEqual([])
    expect(extractToc(doc(paragraph("没有标题")))).toEqual([])
    expect(extractToc(doc(heading(2, "只有一个标题")))).toEqual([])
  })

  it("同名标题按顺序各自拿到 id", () => {
    const json = doc(heading(1, "部署"), heading(2, "部署"), heading(1, "部署"))

    expect(extractToc(json).map((item) => item.id)).toEqual([
      "heading-1",
      "heading-2",
      "heading-3"
    ])
    expect(extractToc(json).map((item) => item.text)).toEqual([
      "部署",
      "部署",
      "部署"
    ])
  })

  it("只收 1–3 级：4–6 级与缺失/越界 level 一律跳过", () => {
    const json = doc(
      heading(4, "四级"),
      heading(5, "五级"),
      heading(6, "六级"),
      {
        type: "heading",
        attrs: {},
        content: [{ type: "text", text: "无层级" }]
      },
      heading(0, "零级"),
      heading(2, "二级甲"),
      heading(2, "二级乙")
    )

    expect(extractToc(json).map((item) => item.text)).toEqual([
      "二级甲",
      "二级乙"
    ])
  })

  it("只认顶层块：代码块文本与引用块里的标题都不算", () => {
    const json = doc(
      {
        type: "codeBlock",
        attrs: { language: "markdown" },
        content: [{ type: "text", text: "# 这不是标题" }]
      },
      {
        type: "blockquote",
        content: [heading(2, "引用里的标题")]
      },
      heading(2, "顶层甲"),
      heading(2, "顶层乙")
    )

    expect(extractToc(json).map((item) => item.text)).toEqual([
      "顶层甲",
      "顶层乙"
    ])
  })

  it("空串、非法 JSON、缺 content 的文档返回空数组", () => {
    expect(extractToc("")).toEqual([])
    expect(extractToc("   ")).toEqual([])
    expect(extractToc("{")).toEqual([])
    expect(extractToc("{}")).toEqual([])
    expect(extractToc("null")).toEqual([])
    expect(extractToc(doc(heading(2, "甲"), heading(2, "乙")))).toHaveLength(2)
  })
})
