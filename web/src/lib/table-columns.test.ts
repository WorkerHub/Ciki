import { describe, expect, it } from "vitest"
import {
  applyColWidthsFromColgroup,
  parseColWidth,
  resolveColumnWidths,
  stripSingleColumnColwidths
} from "@/lib/table-columns"

const table = (colgroup: string, rows: string) =>
  `<table><colgroup>${colgroup}</colgroup><tbody>${rows}</tbody></table>`

describe("列宽换算", () => {
  it("解析百分比与像素", () => {
    expect(parseColWidth("40%")).toEqual({ kind: "percent", value: 40 })
    expect(parseColWidth("120px")).toEqual({ kind: "px", value: 120 })
    expect(parseColWidth("auto")).toBeNull()
  })

  it("百分比按 900px 基准折算", () => {
    expect(resolveColumnWidths(["40%", "20%", "20%", "20%"])).toEqual([
      360, 180, 180, 180
    ])
  })

  it("像素原样保留，缺宽度的列用均值补齐", () => {
    expect(resolveColumnWidths(["120px", null, "200px"])).toEqual([
      120, 160, 200
    ])
  })

  it("完全没有宽度时返回 null（不动表格）", () => {
    expect(resolveColumnWidths([null, null])).toBeNull()
  })
})

describe("colgroup → 单元格 colwidth", () => {
  it("按首行 colgroup 写 colwidth（百分比）", () => {
    const html = applyColWidthsFromColgroup(
      table(
        '<col width="40%"><col width="30%"><col width="30%">',
        "<tr><th>环境</th><th>配置</th><th>值</th></tr>"
      )
    )
    // colwidth 是「每个单元格自己的列宽」，跨列时才是一段
    expect(html).toContain('colwidth="360"')
    expect(html).toContain('colwidth="270"')
  })

  it("尊重 colspan：跨列单元格拿到一段宽度", () => {
    const html = applyColWidthsFromColgroup(
      table(
        '<col width="100px"><col width="200px"><col width="300px">',
        '<tr><th colspan="3">总览</th></tr><tr><td>a</td><td>b</td><td>c</td></tr>'
      )
    )
    expect(html).toContain('colwidth="100,200,300"')
  })

  it("列数与首行不一致的 colgroup 会被跳过，改用下一个匹配的", () => {
    const html = applyColWidthsFromColgroup(
      "<table>" +
        '<colgroup><col width="10%"><col width="10%"><col width="10%"><col width="70%"></colgroup>' +
        '<colgroup><col width="120px"><col width="200px"><col width="200px"></colgroup>' +
        "<tbody><tr><th>a</th><th>b</th><th>c</th></tr></tbody></table>"
    )
    expect(html).toContain('colwidth="120"')
    expect(html).toContain('colwidth="200"')
  })

  it("读态的服务端 HTML（col 用 style 写 px）同样能还原", () => {
    const html = applyColWidthsFromColgroup(
      table(
        '<col style="width: 120px"><col style="width: 240px">',
        "<tr><th>a</th><th>b</th></tr>"
      )
    )
    expect(html).toContain('colwidth="120"')
    expect(html).toContain('colwidth="240"')
  })

  it("没有 colgroup 的表格原样返回", () => {
    const source = "<table><tbody><tr><th>a</th></tr></tbody></table>"
    expect(applyColWidthsFromColgroup(source)).toBe(source)
  })
})

/**
 * 单列表格（1 行 1 列表格套代码）：列宽一律不生效。
 *
 * 只「不写 colwidth」不够——@tiptap/extension-table 的 parseColwidth 在单元格没有
 * colwidth 时会回落到 `colgroup > col[width]`，所以 colgroup 必须整块去掉。
 */
describe("单列表格：不写列宽", () => {
  it("1×1 表格的 colgroup 被整块去掉、一个 colwidth 都不写", () => {
    const html = applyColWidthsFromColgroup(
      '<table><colgroup><col style="width: 76.0px;"></colgroup>' +
        "<tbody><tr><td><pre><code>-Xmx2g</code></pre></td></tr></tbody></table>"
    )
    expect(html).not.toContain("<colgroup")
    expect(html).not.toContain("colwidth")
    // 内容原样保留
    expect(html).toContain("-Xmx2g")
  })

  it("多行单列表格同样不写列宽", () => {
    const html = applyColWidthsFromColgroup(
      '<table><colgroup><col width="76"></colgroup><tbody>' +
        "<tr><td>a</td></tr><tr><td>b</td></tr></tbody></table>"
    )
    expect(html).not.toContain("<colgroup")
    expect(html).not.toContain("colwidth")
  })

  it("单元格上残留的 colwidth 会被清掉", () => {
    const html = applyColWidthsFromColgroup(
      '<table><tbody><tr><td colwidth="76">a</td></tr></tbody></table>'
    )
    expect(html).not.toContain("colwidth")
  })

  it("colspan=2 的单单元格表格算两列，照旧写列宽", () => {
    const html = applyColWidthsFromColgroup(
      '<table><colgroup><col width="120px"><col width="200px"></colgroup>' +
        '<tbody><tr><td colspan="2">合计</td></tr></tbody></table>'
    )
    expect(html).toContain('colwidth="120,200"')
  })

  it("嵌套表格各算各的：外层照写列宽，内层单列表格不写", () => {
    const html = applyColWidthsFromColgroup(
      '<table><colgroup><col width="120px"><col width="300px"></colgroup><tbody><tr>' +
        "<td>a</td><td>" +
        '<table><colgroup><col width="76px"></colgroup>' +
        "<tbody><tr><td><pre><code>-Xmx2g</code></pre></td></tr></tbody></table>" +
        "</td></tr></tbody></table>"
    )
    expect(html).toContain('colwidth="120"')
    expect(html).toContain('colwidth="300"')
    // 只剩外层那一个 colgroup，且没有 76px
    expect(html.match(/<colgroup/g)).toHaveLength(1)
    expect(html).not.toContain('width="76px"')
  })

  it("内层表格的 colgroup 不会被算到外层头上（只认直系）", () => {
    // 外层没有 colgroup；内层有一个与外层列数相同的 colgroup：旧口径会把它捡走
    const html = applyColWidthsFromColgroup(
      "<table><tbody><tr><td>a</td><td>b" +
        '<table><colgroup><col width="120px"><col width="200px"></colgroup>' +
        "<tbody><tr><td>c</td><td>d</td></tr></tbody></table>" +
        "</td></tr></tbody></table>"
    )
    const outer = html.slice(0, html.indexOf("<table", 1))
    expect(outer).not.toContain("colwidth")
  })
})

describe("stripSingleColumnColwidths（编辑态 JSON 归一）", () => {
  const cell = (colwidth: number[] | null, text = "a", colspan = 1) => ({
    type: "tableCell",
    attrs: { colspan, rowspan: 1, colwidth },
    content: [{ type: "paragraph", content: [{ type: "text", text }] }]
  })

  const doc = (table: unknown) => ({
    type: "doc",
    content: [table]
  })

  const table = (rows: unknown[]) => ({
    type: "table",
    attrs: {},
    content: rows.map((cells) => ({ type: "tableRow", content: cells }))
  })

  it("单列表格剥掉 colwidth，其余属性保留", () => {
    const next = stripSingleColumnColwidths(doc(table([[cell([76])]])) as never)
    const attrs = next.content?.[0]?.content?.[0]?.content?.[0]?.attrs
    expect(attrs).toEqual({ colspan: 1, rowspan: 1 })
    expect(attrs).not.toHaveProperty("colwidth")
  })

  it("多列表格原样（列宽逐个保留）", () => {
    const next = stripSingleColumnColwidths(
      doc(table([[cell([120]), cell([200])]])) as never
    )
    const cells = next.content?.[0]?.content?.[0]?.content ?? []
    expect(cells[0]?.attrs?.colwidth).toEqual([120])
    expect(cells[1]?.attrs?.colwidth).toEqual([200])
  })

  it("colspan=2 的单单元格表格不当单列", () => {
    const next = stripSingleColumnColwidths(
      doc(table([[cell([120, 200], "合计", 2)]])) as never
    )
    const attrs = next.content?.[0]?.content?.[0]?.content?.[0]?.attrs
    expect(attrs?.colwidth).toEqual([120, 200])
  })

  it("嵌套在单列表格里的内层表格各自判定", () => {
    const inner = table([[cell([76], "inner")]])
    const outerCell = {
      type: "tableCell",
      attrs: { colspan: 1, rowspan: 1, colwidth: [76] },
      content: [inner]
    }
    const next = stripSingleColumnColwidths(doc(table([[outerCell]])) as never)
    const outerAttrs = next.content?.[0]?.content?.[0]?.content?.[0]?.attrs
    const innerAttrs =
      next.content?.[0]?.content?.[0]?.content?.[0]?.content?.[0]?.content?.[0]
        ?.content?.[0]?.attrs
    expect(outerAttrs).toEqual({ colspan: 1, rowspan: 1 })
    expect(innerAttrs).toEqual({ colspan: 1, rowspan: 1 })
  })

  it("不改动入参（载入时不能污染页面原始 JSON）", () => {
    const source = doc(table([[cell([76])]])) as never
    const before = JSON.stringify(source)
    stripSingleColumnColwidths(source)
    expect(JSON.stringify(source)).toBe(before)
  })
})
