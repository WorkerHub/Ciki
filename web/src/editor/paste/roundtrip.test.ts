import { Editor } from "@tiptap/core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createExtensions } from "@/editor/extensions"
import { analyzeHtml } from "@/editor/paste/analyze"
import { cleanConfluenceHtml } from "@/editor/paste/cleaner"
import {
  SAMPLE_COLOR_HTML,
  SAMPLE_CONFLUENCE_HTML,
  SAMPLE_SH_TABLE_HTML
} from "@/editor/paste/samples"
import { applyColWidthsFromColgroup } from "@/lib/table-columns"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"

/**
 * 清洗后 → TipTap 回读的结构守恒 —— 从小样 v0.4 的 test/roundtrip.test.mjs
 * 原样移植（11 条断言）。这里用的是产品侧真实的扩展集，回读结果即产品的解析结果。
 */
describe("清洗后 TipTap 回读（小样 v0.4 断言）", () => {
  let editor: Editor

  const load = (html: string) => {
    editor.commands.setContent(
      applyColWidthsFromColgroup(cleanConfluenceHtml(html))
    )
    return analyzeHtml(editor.getHTML())
  }

  beforeAll(() => {
    installTiptapJsdomShims()
    const host = document.createElement("div")
    document.body.appendChild(host)
    editor = new Editor({
      element: host,
      extensions: createExtensions("edit"),
      content: applyColWidthsFromColgroup(
        cleanConfluenceHtml(SAMPLE_CONFLUENCE_HTML)
      )
    })
  })

  afterAll(() => {
    editor?.destroy()
  })

  it("标题总数一致", () => {
    const before = analyzeHtml(cleanConfluenceHtml(SAMPLE_CONFLUENCE_HTML))
    const after = analyzeHtml(editor.getHTML())
    expect(after.headings.total).toBe(before.headings.total)
  })

  it("代码块数量 + 语言一致", () => {
    const before = analyzeHtml(cleanConfluenceHtml(SAMPLE_CONFLUENCE_HTML))
    const after = analyzeHtml(editor.getHTML())
    expect(after.codeBlocks.length).toBe(before.codeBlocks.length)
    before.codeBlocks.forEach((block, index) => {
      expect(after.codeBlocks[index]?.lang).toBe(block.lang)
    })
  })

  it("表格数量一致", () => {
    const before = analyzeHtml(cleanConfluenceHtml(SAMPLE_CONFLUENCE_HTML))
    const after = analyzeHtml(editor.getHTML())
    expect(after.tables.length).toBe(before.tables.length)
  })

  it("合并单元格一致", () => {
    const before = analyzeHtml(cleanConfluenceHtml(SAMPLE_CONFLUENCE_HTML))
    const after = analyzeHtml(editor.getHTML())
    expect(after.mergedCells).toBe(before.mergedCells)
  })

  it("任务项一致", () => {
    const before = analyzeHtml(cleanConfluenceHtml(SAMPLE_CONFLUENCE_HTML))
    const after = analyzeHtml(editor.getHTML())
    expect(after.taskItems).toBe(before.taskItems)
  })

  it("链接一致", () => {
    const before = analyzeHtml(cleanConfluenceHtml(SAMPLE_CONFLUENCE_HTML))
    const after = analyzeHtml(editor.getHTML())
    expect(after.links).toBe(before.links)
  })

  it("图片一致", () => {
    const before = analyzeHtml(cleanConfluenceHtml(SAMPLE_CONFLUENCE_HTML))
    const after = analyzeHtml(editor.getHTML())
    expect(after.images.length).toBe(before.images.length)
  })

  it("列表深度一致", () => {
    const before = analyzeHtml(cleanConfluenceHtml(SAMPLE_CONFLUENCE_HTML))
    const after = analyzeHtml(editor.getHTML())
    expect(after.maxListDepth).toBe(before.maxListDepth)
  })

  it("行号列样本回读：代码块 = 1 且语言 sql", () => {
    const after = load(SAMPLE_SH_TABLE_HTML)
    expect(after.codeBlocks).toHaveLength(1)
    expect(after.codeBlocks[0]?.lang).toBe("sql")
  })

  it("行号列样本回读：无表格", () => {
    const after = load(SAMPLE_SH_TABLE_HTML)
    expect(after.tables).toHaveLength(0)
  })

  it("行号列样本回读：行内代码 = 0", () => {
    const after = load(SAMPLE_SH_TABLE_HTML)
    expect(after.inlineCode).toBe(0)
  })

  it("外链图片回读后保留未转存标记，且不把外链写回 src", () => {
    load(SAMPLE_CONFLUENCE_HTML)
    const html = editor.getHTML()
    expect(html).toContain("data-original-src")
    expect(html).toContain('data-confluence-img="true"')
    expect(html).not.toMatch(/<img[^>]*\ssrc=/)
  })
})

/**
 * 颜色支持批次：清洗后的颜色载具必须能被产品侧真实扩展集读回模型，
 * 并在序列化时保持契约形态（data 属性 + 小写 #rrggbb）。
 */
describe("颜色载具的 TipTap 回读（编辑态扩展集）", () => {
  let editor: Editor

  beforeAll(() => {
    installTiptapJsdomShims()
    const host = document.createElement("div")
    document.body.appendChild(host)
    editor = new Editor({ element: host, extensions: createExtensions("edit") })
  })

  afterAll(() => {
    editor?.destroy()
  })

  const load = (html: string) => {
    editor.commands.setContent(html)
    return editor
  }

  it("文字颜色读回 textStyle.color（hex）", () => {
    load('<p><span data-text-color="#de350b">红</span></p>')
    const marks = editor.getJSON().content?.[0]?.content?.[0]?.marks ?? []
    expect(marks).toEqual([{ type: "textStyle", attrs: { color: "#de350b" } }])
    expect(editor.getHTML()).toContain('data-text-color="#de350b"')
  })

  it("高亮读回 highlight.color（hex）", () => {
    load('<p><mark data-color="#ffe58f">亮</mark></p>')
    const marks = editor.getJSON().content?.[0]?.content?.[0]?.marks ?? []
    expect(marks).toEqual([{ type: "highlight", attrs: { color: "#ffe58f" } }])
    expect(editor.getHTML()).toContain('data-color="#ffe58f"')
  })

  it("单元格底色读回 tableCell / tableHeader 的 backgroundColor", () => {
    load(
      '<table><tbody><tr><th data-cell-bg="#f4f5f7">H</th><td data-cell-bg="#fffae6">C</td></tr></tbody></table>'
    )
    const row = editor.getJSON().content?.[0]?.content?.[0]?.content ?? []
    expect(row[0]?.attrs?.backgroundColor).toBe("#f4f5f7")
    expect(row[1]?.attrs?.backgroundColor).toBe("#fffae6")
    const html = editor.getHTML()
    expect(html).toContain('data-cell-bg="#f4f5f7"')
    expect(html).toContain('data-cell-bg="#fffae6"')
  })

  it("Confluence 颜色样本整页回读：三样颜色都在", () => {
    load(applyColWidthsFromColgroup(cleanConfluenceHtml(SAMPLE_COLOR_HTML)))
    const stats = analyzeHtml(editor.getHTML())
    expect(stats.textColors).toBeGreaterThanOrEqual(3)
    expect(stats.highlights).toBe(1)
    expect(stats.cellBackgrounds).toBe(4)
  })
})
