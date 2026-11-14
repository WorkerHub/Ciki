/**
 * 表格列宽：把 <colgroup> 的列宽换算成 TipTap 单元格的 colwidth。
 *
 * 为什么要多这一步：Confluence 粘贴出来的是 `<col style="width: 40%">`，而 TipTap 的
 * 表格 schema 只认单元格上的 `colwidth`（px 数组），`<col>` 在解析时会被丢掉，列宽比例
 * 也就没了。服务端消毒白名单保留 col/colgroup、不保留 td[colwidth]，所以读态（contentHtml）
 * 也要在渲染前用同一个函数还原一次 —— 粘贴时与读态走同一条换算，表现才一致。
 *
 * 单列表格是例外（口径：列数=1 的表格唯一列占满正文宽）：列宽对它一律不生效，
 * 换算时把该表自己的 colgroup 整块去掉、也不写 colwidth。
 *
 * 为什么「不写 colwidth」不够：`@tiptap/extension-table` 的 `parseColwidth` 在单元格
 * 没有 colwidth 属性时会回落到同列 `<col width>`。只要 colgroup 还在，粘贴的
 * `insertContent` 与读态的 `setContent` 就会把 76px 重新拣回来，表格依旧被钉成窄条。
 */

import type { JSONContent } from "@tiptap/core"

const DEFAULT_BASE_WIDTH = 900

export interface ColWidth {
  kind: "percent" | "px"
  value: number
}

export function parseColWidth(raw: string | null): ColWidth | null {
  if (!raw) return null
  const value = raw.trim()
  const percent = value.match(/^([\d.]+)%$/)
  if (percent) return { kind: "percent", value: Number.parseFloat(percent[1]) }
  const pixels = value.match(/^([\d.]+)px$/)
  if (pixels) return { kind: "px", value: Number.parseFloat(pixels[1]) }
  return null
}

/**
 * 把一行的列宽（可能混着 % 与 px）落成像素数组。
 * 百分比按 baseWidth 折算；缺宽度的列用已知列的平均宽度补齐，避免整表丢比例。
 */
export function resolveColumnWidths(
  raws: (string | null)[],
  baseWidth = DEFAULT_BASE_WIDTH
): number[] | null {
  const resolved = raws.map((raw) => {
    const parsed = parseColWidth(raw)
    if (!parsed) return null
    return parsed.kind === "percent"
      ? Math.round((parsed.value / 100) * baseWidth)
      : Math.round(parsed.value)
  })
  const known = resolved.filter(
    (value): value is number => value !== null && value > 0
  )
  if (!known.length) return null
  const fallback = Math.max(
    1,
    Math.round(known.reduce((sum, value) => sum + value, 0) / known.length)
  )
  return resolved.map((value) => (value && value > 0 ? value : fallback))
}

function readColgroupWidths(
  table: Element,
  columnCount: number,
  baseWidth: number
): number[] | null {
  // 只认自己的直系列定义：嵌套表格的 colgroup 不能算到外层头上
  const groups = Array.from(table.querySelectorAll(":scope > colgroup"))
  for (const group of groups) {
    const cols = Array.from(group.querySelectorAll(":scope > col"))
    if (cols.length !== columnCount) continue
    const raws = cols.map((col) => {
      const width = col.getAttribute("width")
      if (width) return width
      const style = col.getAttribute("style") || ""
      const match = style.match(/width\s*:\s*([\d.]+\s*(?:px|%))/i)
      return match ? match[1].replace(/\s+/g, "") : null
    })
    const widths = resolveColumnWidths(raws, baseWidth)
    if (widths) return widths
  }
  return null
}

/** 这张表格自己的行（不含嵌套表格的行）。 */
function ownRows(table: Element): Element[] {
  return Array.from(
    table.querySelectorAll(
      ":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr"
    )
  )
}

function cellsOf(row: Element): Element[] {
  return Array.from(row.children).filter(
    (cell) => cell.tagName === "TD" || cell.tagName === "TH"
  )
}

/**
 * 给首个表格行的单元格写 `colwidth="w1,w2,…"`（按 colspan 分摊），
 * 其余内容原样返回。没有可用 colgroup 的表格不动。
 *
 * 单列表格（列数=1）反过来：删掉自己的 colgroup、清掉自己单元格上的 colwidth，
 * 一个宽度都不写——唯一列由 CSS 撑满正文宽，渲染完全忽略存储的列宽。
 */
export function applyColWidthsFromColgroup(
  html: string,
  baseWidth = DEFAULT_BASE_WIDTH
): string {
  if (!html || typeof DOMParser === "undefined" || !html.includes("<table"))
    return html
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><body><div id="__root">${html}</div></body></html>`,
    "text/html"
  )
  const root = doc.getElementById("__root")
  if (!root) return html

  root.querySelectorAll("table").forEach((table) => {
    const firstRow = ownRows(table)[0]
    if (!firstRow) return
    const cells = cellsOf(firstRow)
    if (!cells.length) return
    const columnCount = cells.reduce(
      (sum, cell) =>
        sum + (Number.parseInt(cell.getAttribute("colspan") || "1", 10) || 1),
      0
    )
    if (columnCount <= 0) return
    if (columnCount === 1) {
      // 单列表格：删掉自己的 colgroup（parseColwidth 的回落源），再清掉自己单元格上
      // 已有的 colwidth。只处理直系，内层表格的列宽由内层自己判定。
      table.querySelectorAll(":scope > colgroup").forEach((group) => {
        group.remove()
      })
      ownRows(table).forEach((row) => {
        cellsOf(row).forEach((cell) => {
          cell.removeAttribute("colwidth")
        })
      })
      return
    }
    const widths = readColgroupWidths(table, columnCount, baseWidth)
    if (!widths) return
    let cursor = 0
    cells.forEach((cell) => {
      const colspan =
        Number.parseInt(cell.getAttribute("colspan") || "1", 10) || 1
      const slice = widths.slice(cursor, cursor + colspan)
      cursor += colspan
      if (slice.length === colspan)
        cell.setAttribute("colwidth", slice.join(","))
    })
  })

  return root.innerHTML.trim()
}

/** 一行单元格的 colspan 合计 = 这一行的列数（合并单元格按展开后的列算）。 */
function rowColumnCount(row: JSONContent | undefined): number {
  const cells = (row?.content ?? []).filter(
    (node) => node.type === "tableCell" || node.type === "tableHeader"
  )
  return cells.reduce(
    (sum, cell) => sum + (Number(cell.attrs?.colspan ?? 1) || 1),
    0
  )
}

function stripColwidth(node: JSONContent): JSONContent {
  const next: JSONContent = { ...node }
  if (next.content) next.content = next.content.map(stripColwidth)
  if (next.type !== "table") return next

  // 列数按首行算（与 HTML 侧同一判据）；colspan=2 的单单元格表格算两列，不动
  if (rowColumnCount(next.content?.[0]) === 1 && next.content) {
    next.content = next.content.map((row) => ({
      ...row,
      content: row.content?.map((cell) => {
        if (!cell.attrs || !("colwidth" in cell.attrs)) return cell
        const attrs = { ...cell.attrs }
        delete attrs.colwidth
        return { ...cell, attrs }
      })
    }))
  }
  return next
}

/**
 * 编辑态用的归一：JSON 里单列表格（列数=1）不保留任何 colwidth。
 *
 * 存量的 contentJson 里带着 `colwidth: [76]`，编辑器载入时若原样保留，Table 的 NodeView
 * 会把表格宽度写死成 76px；保存时再归一一次，保证落库的 JSON 永远不带单列列宽
 * （列宽手柄拖出来的值也在这里丢掉，渲染口径由 CSS 兜底成全宽）。
 */
export function stripSingleColumnColwidths(doc: JSONContent): JSONContent {
  return stripColwidth(doc)
}
