/**
 * 表格列宽：把 <colgroup> 的列宽换算成 TipTap 单元格的 colwidth。
 *
 * 为什么要多这一步：Confluence 粘贴出来的是 `<col style="width: 40%">`，而 TipTap 的
 * 表格 schema 只认单元格上的 `colwidth`（px 数组），`<col>` 在解析时会被丢掉，列宽比例
 * 也就没了。服务端消毒白名单保留 col/colgroup、不保留 td[colwidth]，所以读态（contentHtml）
 * 也要在渲染前用同一个函数还原一次 —— 粘贴时与读态走同一条换算，表现才一致。
 */

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
  const groups = Array.from(table.querySelectorAll("colgroup"))
  for (const group of groups) {
    const cols = Array.from(group.querySelectorAll("col"))
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

/**
 * 给首个表格行的单元格写 `colwidth="w1,w2,…"`（按 colspan 分摊），
 * 其余内容原样返回。没有可用 colgroup 的表格不动。
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
    const firstRow = table.querySelector("tr")
    if (!firstRow) return
    const cells = Array.from(firstRow.children).filter(
      (cell) => cell.tagName === "TD" || cell.tagName === "TH"
    )
    if (!cells.length) return
    const columnCount = cells.reduce(
      (sum, cell) =>
        sum + (Number.parseInt(cell.getAttribute("colspan") || "1", 10) || 1),
      0
    )
    if (columnCount <= 0) return
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
