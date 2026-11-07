import { Editor } from "@tiptap/core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createExtensions } from "@/editor/extensions"
import { analyzeHtml } from "@/editor/paste/analyze"
import { cleanConfluenceHtml } from "@/editor/paste/cleaner"
import {
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
