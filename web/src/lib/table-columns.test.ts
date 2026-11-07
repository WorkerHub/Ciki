import { describe, expect, it } from "vitest"
import {
  applyColWidthsFromColgroup,
  parseColWidth,
  resolveColumnWidths
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
