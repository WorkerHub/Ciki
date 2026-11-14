/**
 * 单列表格（1 行 1 列表格套代码）：服务端渲染不写列宽。
 *
 * 口径（用户定版）：列数=1 的表格唯一列占满正文宽，存储的 colwidth 对它不生效。
 * 服务端这一层负责让新保存/新导入的 contentHtml 不再带单列列宽 —— 只删单元格 colwidth
 * 没用，TipTap 读态会把 `colgroup > col[width]` 当回落值拣回去（窄条就是这么来的）。
 */
import { describe, expect, it } from "vitest"
import { normalizeImportedContent } from "../src/lib/page-input"

const PARAM_LINES = [
  "-Xms512m",
  "-Xmx2g",
  "-XX:MaxMetaspaceSize=256m",
  "-XX:+UseG1GC",
  "-XX:InitiatingHeapOccupancyPercent=45",
  "-XX:ParallelGCThreads=4"
]

function cell(colwidth: number[] | null, colspan = 1, text = "参数") {
  return {
    type: "tableCell",
    attrs: { colspan, rowspan: 1, colwidth },
    content: [{ type: "paragraph", content: [{ type: "text", text }] }]
  }
}

function tableDoc(cells: unknown[][], codeLines?: string[]) {
  const row = {
    type: "tableRow",
    content: [
      ...cells[0],
      ...(codeLines
        ? [
            {
              type: "tableCell",
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [
                {
                  type: "codeBlock",
                  attrs: { language: "java" },
                  content: [{ type: "text", text: codeLines.join("\n") }]
                }
              ]
            }
          ]
        : [])
    ]
  }
  return {
    type: "doc",
    content: [{ type: "table", attrs: {}, content: [row] }]
  }
}

function render(doc: unknown): string {
  const result = normalizeImportedContent({
    title: "单列表格",
    contentJson: doc
  })
  if (!result.ok) throw new Error(result.error)
  return result.value.contentHtml
}

describe("单列表格不计列宽", () => {
  it("单列表格即使 contentJson 带 colwidth，contentHtml 也不带列宽", () => {
    const cellWithCode = {
      type: "tableCell",
      attrs: { colspan: 1, rowspan: 1, colwidth: [76] },
      content: [
        {
          type: "codeBlock",
          attrs: { language: "java" },
          content: [{ type: "text", text: PARAM_LINES.join("\n") }]
        }
      ]
    }
    const doc = {
      type: "doc",
      content: [
        {
          type: "table",
          attrs: {},
          content: [{ type: "tableRow", content: [cellWithCode] }]
        }
      ]
    }
    const html = render(doc)
    expect(html).toContain("<table")
    expect(html).not.toContain("<colgroup")
    expect(html).not.toContain("width")
    // 代码正文逐行完整，没被拆
    expect(html).toContain(PARAM_LINES.join("\n"))
  })

  it("没有列宽的单列表格同样不生成 colgroup", () => {
    const html = render(tableDoc([[cell(null)]]))
    expect(html).toContain("<table")
    expect(html).not.toContain("<colgroup")
  })

  it("多列表格的列宽保真不变", () => {
    const html = render(tableDoc([[cell([120]), cell([200])]]))
    expect(html).toContain("<colgroup")
    expect(html).toContain('width="120"')
    expect(html).toContain('width="200"')
  })

  it("colspan=2 的单单元格表格算两列，列宽照旧", () => {
    const html = render(tableDoc([[cell([120, 200], 2, "合计")]]))
    expect(html).toContain("<colgroup")
    expect(html).toContain('width="120"')
  })
})
