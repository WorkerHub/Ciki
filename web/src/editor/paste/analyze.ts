/**
 * 粘贴结构统计 —— 从小样移植，仅用于测试断言与交付自检（不进业务渲染路径）。
 * 统计口径与小样 v0.4 完全一致，保证移植后的断言可比。
 */

export interface CodeBlockStat {
  lang: string
  lines: number
}

export interface TableStat {
  rows: number
  cells: number
  headerCells: number
  headerTextCells: number
  mergedCells: number
}

export interface ImageStat {
  src: string
  confluence: boolean
}

export interface HtmlStats {
  headings: { total: number; byLevel: Record<string, number> }
  paragraphs: number
  codeBlocks: CodeBlockStat[]
  inlineCode: number
  tables: TableStat[]
  mergedCells: number
  links: number
  images: ImageStat[]
  taskItems: number
  taskChecked: number
  listItems: number
  maxListDepth: number
  blockquotes: number
  hrs: number
  unknownTags: string[]
}

function parseFragment(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><body><div id="__root">${html}</div></body></html>`,
    "text/html"
  )
  const root = doc.getElementById("__root")
  if (!root) throw new Error("统计：无法解析 HTML")
  return root
}

export function analyzeHtml(html: string): HtmlStats {
  const stats: HtmlStats = {
    headings: { total: 0, byLevel: {} },
    paragraphs: 0,
    codeBlocks: [],
    inlineCode: 0,
    tables: [],
    mergedCells: 0,
    links: 0,
    images: [],
    taskItems: 0,
    taskChecked: 0,
    listItems: 0,
    maxListDepth: 0,
    blockquotes: 0,
    hrs: 0,
    unknownTags: []
  }
  if (!html?.trim()) return stats
  const root = parseFragment(html)
  const allowed = new Set([
    "P",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "PRE",
    "CODE",
    "TABLE",
    "THEAD",
    "TBODY",
    "TFOOT",
    "TR",
    "TD",
    "TH",
    "UL",
    "OL",
    "LI",
    "BLOCKQUOTE",
    "HR",
    "BR",
    "IMG",
    "A",
    "STRONG",
    "B",
    "EM",
    "I",
    "U",
    "S",
    "DEL",
    "STRIKE",
    "SUB",
    "SUP",
    "SPAN",
    "DIV",
    "COLGROUP",
    "COL",
    "LABEL",
    "INPUT"
  ])
  const seenUnknown = new Set<string>()
  root.querySelectorAll("*").forEach((el) => {
    if (!allowed.has(el.tagName) && !seenUnknown.has(el.tagName)) {
      seenUnknown.add(el.tagName)
      stats.unknownTags.push(el.tagName)
    }
  })
  for (let level = 1; level <= 6; level += 1) {
    const count = root.querySelectorAll(`h${level}`).length
    if (count) {
      stats.headings.byLevel[`h${level}`] = count
      stats.headings.total += count
    }
  }
  stats.paragraphs = root.querySelectorAll("p").length
  root.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code")
    const cls = code?.getAttribute("class") ?? ""
    const match = cls.match(/language-([\w+#-]+)/)
    stats.codeBlocks.push({
      lang: match ? match[1] : "(无语言)",
      lines: ((pre.textContent ?? "").match(/\n/g) || []).length + 1
    })
  })
  stats.inlineCode = Array.from(root.querySelectorAll("code")).filter(
    (code) => !code.closest("pre")
  ).length
  root.querySelectorAll("table").forEach((table) => {
    const cells = table.querySelectorAll("td,th")
    let merged = 0
    cells.forEach((cell) => {
      const colspan = Number.parseInt(cell.getAttribute("colspan") || "1", 10)
      const rowspan = Number.parseInt(cell.getAttribute("rowspan") || "1", 10)
      if (colspan > 1 || rowspan > 1) merged += 1
    })
    stats.mergedCells += merged
    const headers = table.querySelectorAll("th")
    const headerTextCells = Array.from(headers).filter(
      (th) => (th.textContent ?? "").trim().length > 0
    ).length
    stats.tables.push({
      rows: table.querySelectorAll("tr").length,
      cells: cells.length,
      headerCells: headers.length,
      headerTextCells,
      mergedCells: merged
    })
  })
  stats.links = root.querySelectorAll("a[href]").length
  root.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") || ""
    stats.images.push({
      src,
      confluence:
        img.hasAttribute("data-confluence-img") ||
        /\/download\/attachments\//.test(src)
    })
  })
  root.querySelectorAll("li").forEach((li) => {
    stats.listItems += 1
    if (
      li.getAttribute("data-type") === "taskItem" ||
      li.closest('ul[data-type="taskList"]')
    ) {
      stats.taskItems += 1
      if (li.getAttribute("data-checked") === "true") stats.taskChecked += 1
    }
    let depth = 0
    let node: Element | null = li.parentElement
    while (node && node !== root) {
      if (node.tagName === "UL" || node.tagName === "OL") depth += 1
      node = node.parentElement
    }
    if (depth > stats.maxListDepth) stats.maxListDepth = depth
  })
  stats.blockquotes = root.querySelectorAll("blockquote").length
  stats.hrs = root.querySelectorAll("hr").length
  return stats
}

/** 交付自检用的一行摘要（不含正文）。 */
export function summarizeHtml(stats: HtmlStats): string {
  const headings =
    Object.entries(stats.headings.byLevel)
      .map(([tag, count]) => `${tag}×${count}`)
      .join(" ") || "无"
  const codes =
    stats.codeBlocks.map((c) => `${c.lang}/${c.lines}行`).join(", ") || "无"
  const tables =
    stats.tables
      .map(
        (t) =>
          `${t.rows}行/${t.cells}格/表头${t.headerTextCells}/${t.headerCells}/合并${t.mergedCells}`
      )
      .join(", ") || "无"
  return [
    `标题 ${stats.headings.total}（${headings}）`,
    `段落 ${stats.paragraphs} 行内代码 ${stats.inlineCode}`,
    `代码块 ${stats.codeBlocks.length}（${codes}）`,
    `表格 ${stats.tables.length}（${tables}）`,
    `列表项 ${stats.listItems} 最大深度 ${stats.maxListDepth} 任务项 ${stats.taskItems}（已勾 ${stats.taskChecked}）`,
    `链接 ${stats.links} 引用块 ${stats.blockquotes} 分割线 ${stats.hrs}`,
    `图片 ${stats.images.length}`,
    stats.unknownTags.length
      ? `未知标签 ${stats.unknownTags.join(",")}`
      : "未知标签 无"
  ].join(" ｜ ")
}
