/**
 * 服务端把 TipTap JSON 序列化成 Markdown（规格一期的「MD 派生件」）。
 *
 * **派生方向只有一个**：TipTap JSON 是真源，MD 是给它拍的一张平面照。任何路径都不许
 * 拿 MD 反写正文，所以这里不做「MD → JSON」的方向，也不追求往返无损：颜色/高亮/
 * 下划线按规格丢弃，合并单元格按网格展开，未知节点降级成它的子节点文字。
 *
 * 实现方式是直接走节点树（`parseTiptapDoc`，与 HTML 渲染同一份 schema 校验与同一棵
 * ProseMirror 树），不经 HTML 再转 MD：仓库里没有能表达这些规格的转换依赖，经 HTML
 * 转一道反而要多写一遍 DOM 解析，还多一处与 `renderTiptapHtml` 口径不一致的风险。
 *
 * 三层出口，调用方按「能不能失败」挑：
 * - {@link serializeTiptapMarkdown}：严格版，JSON 不合法就抛 `TiptapRenderError`；
 * - {@link derivePageMarkdown}：**永不抛错**，派生不出来就退回纯文本——读路径与迁移
 *   回填用它，保证「content_md 为空时按需现生成」既不会 500 也不会回空文档；
 * - {@link resolvePageMarkdown}：读路径的取值口径（库里有就用，没有就现生成）。
 */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { parseTiptapDoc } from "./tiptap-html"

/**
 * 图片绝对地址的站点前缀（规格：图片写「本站完整 URL + 现行 /api/files/... 路径」）。
 *
 * 取固定常量而不是请求的 origin：保存、迁移回填、按需生成三条路径里只有保存有请求，
 * 按 origin 生成会让同一页在不同入口产出不同的库值，回填与直读也对不上。站点只有
 * 这一个对外地址，规格也点名了它。
 */
export const CIKI_MD_ORIGIN = "https://ciki.oneboy.app"

/** 列表每层缩进（GFM 里 2 空格即可，且不会被误当成代码块）。 */
const INDENT = "  "

function isList(node: ProseMirrorNode): boolean {
  const name = node.type.name
  return name === "bulletList" || name === "orderedList" || name === "taskList"
}

function children(node: ProseMirrorNode): ProseMirrorNode[] {
  const out: ProseMirrorNode[] = []
  node.forEach((child) => {
    out.push(child)
  })
  return out
}

/** 一段文本里最长的连续 `ch` 串长度（围栏要长过它）。 */
function longestRun(text: string, ch: string): number {
  let longest = 0
  let current = 0
  for (const char of text) {
    if (char === ch) {
      current += 1
      longest = Math.max(longest, current)
    } else {
      current = 0
    }
  }
  return longest
}

function hasMark(node: ProseMirrorNode, name: string): boolean {
  return node.marks.some((mark) => mark.type.name === name)
}

/** 链接地址（link 标记的 `href`）；非字符串一律当空。 */
function linkHref(node: ProseMirrorNode): string {
  const mark = node.marks.find((entry) => entry.type.name === "link")
  const value = mark?.attrs.href
  return typeof value === "string" ? value : ""
}

/** 行内代码：内容里有反引号就加长围栏（GFM 口径），否则被内容自己截断。 */
function inlineCode(text: string): string {
  const fence = "`".repeat(longestRun(text, "`") + 1)
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : ""
  return `${fence}${pad}${text}${pad}${fence}`
}

/**
 * 一个文本节点套上它的标记，自内向外：行内代码 → 删除线 → 斜体 → 粗体 → 链接。
 * 颜色（`textStyle`）、高亮、下划线按规格丢弃，只留文字。
 */
function withMarks(node: ProseMirrorNode, text: string): string {
  let value = text
  if (hasMark(node, "code")) value = inlineCode(value)
  if (hasMark(node, "strike")) value = `~~${value}~~`
  if (hasMark(node, "italic")) value = `*${value}*`
  if (hasMark(node, "bold")) value = `**${value}**`
  if (hasMark(node, "link")) value = `[${value}](${linkHref(node)})`
  return value
}

function imageSrc(node: ProseMirrorNode): string {
  const src = typeof node.attrs.src === "string" ? node.attrs.src.trim() : ""
  const original =
    typeof node.attrs.originalSrc === "string"
      ? node.attrs.originalSrc.trim()
      : ""
  // 未转存的外链图只有 data-original-src（粘贴/导入时的占位），它是这张图唯一的地址。
  const raw = src || original
  if (!raw) return ""
  return raw.startsWith("/") ? `${CIKI_MD_ORIGIN}${raw}` : raw
}

function renderImage(node: ProseMirrorNode): string {
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : ""
  const label = alt.replace(/[[\]]/g, (char) => `\\${char}`)
  return `![${label}](${imageSrc(node)})`
}

/** 行内内容（paragraph / heading / 表格单元格里的文字）拍平成一行。 */
function renderInline(node: ProseMirrorNode): string {
  let out = ""
  node.forEach((child) => {
    if (child.isText) {
      out += withMarks(child, child.text ?? "")
      return
    }
    if (child.type.name === "hardBreak") {
      out += "  \n"
      return
    }
    if (child.type.name === "image") {
      out += renderImage(child)
      return
    }
    // 其余行内节点（理论上没有）按「收文字」处理。
    out += renderInline(child)
  })
  return out
}

function renderCodeBlock(node: ProseMirrorNode): string {
  const code = node.textContent
  const fence = "`".repeat(Math.max(3, longestRun(code, "`") + 1))
  const language =
    typeof node.attrs.language === "string" ? node.attrs.language.trim() : ""
  const body = code === "" || code.endsWith("\n") ? code : `${code}\n`
  return `${fence}${language}\n${body}${fence}`
}

function renderBlockquote(node: ProseMirrorNode): string {
  const inner = renderBlocks(children(node), 0)
  if (inner.length === 0) return ">"
  return inner
    .join("\n\n")
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n")
}

/** 表格单元格里的文字：块级内容压成一行（GFM 单元格不支持换行），管道符转义。 */
function renderCellText(cell: ProseMirrorNode): string {
  const parts: string[] = []
  for (const child of children(cell)) {
    const rendered = renderBlock(child, 0)
    if (rendered !== null && rendered !== "") {
      parts.push(rendered.replace(/\n/g, " "))
    }
  }
  return parts.join(" ").replace(/\|/g, "\\|").trim()
}

/**
 * 表格 → GFM 管道表（规格的降级规则）：
 *
 * - 先按 colspan/rowspan 把单元格铺成网格：锚点格留内容，被合并覆盖的格留空串，
 *   列数取最宽的一行，短行补空——行列按网格展开，内容不丢也不重复；
 * - 表头取原表头行；原表没有表头时，第一行升为表头位（GFM 必须有表头行）；
 * - 表体是其余行。
 */
function renderTable(node: ProseMirrorNode): string {
  const rows = children(node)
  if (rows.length === 0) return ""

  const grid: string[][] = []
  const occupied: boolean[][] = []
  let columns = 0

  rows.forEach((row, rowIndex) => {
    grid[rowIndex] ??= []
    occupied[rowIndex] ??= []
    let column = 0
    row.forEach((cell) => {
      while (occupied[rowIndex][column]) column += 1
      const colspan = Math.max(1, Number(cell.attrs.colspan) || 1)
      const rowspan = Math.max(1, Number(cell.attrs.rowspan) || 1)
      for (let r = 0; r < rowspan; r += 1) {
        const target = rowIndex + r
        grid[target] ??= []
        occupied[target] ??= []
        for (let c = 0; c < colspan; c += 1) {
          occupied[target][column + c] = true
          if (grid[target][column + c] === undefined) {
            grid[target][column + c] =
              r === 0 && c === 0 ? renderCellText(cell) : ""
          }
        }
      }
      column += colspan
    })
    columns = Math.max(columns, occupied[rowIndex].length)
  })

  if (columns === 0) return ""
  const square = grid.map((row) => {
    const line: string[] = []
    for (let index = 0; index < columns; index += 1) {
      line.push(row[index] ?? "")
    }
    return line
  })

  const pipe = (cells: string[]) => `| ${cells.join(" | ")} |`
  const header = square[0]
  const body = square.slice(1)
  return [pipe(header), pipe(header.map(() => "---")), ...body.map(pipe)].join(
    "\n"
  )
}

/**
 * 一张列表（有序/无序/任务）的全部行；嵌套列表按 `depth` 缩进，行自己带缩进前缀，
 * 调用方直接拼。
 */
function renderList(node: ProseMirrorNode, depth: number): string {
  const indent = INDENT.repeat(depth)
  const itemIndent = INDENT.repeat(depth + 1)
  const kind = node.type.name
  const start = Number(node.attrs.start) || 1
  const lines: string[] = []

  children(node).forEach((item, index) => {
    if (item.type.name !== "listItem" && item.type.name !== "taskItem") {
      // 理论上不会出现；按块降级，不丢内容。
      const rendered = renderBlock(item, depth)
      if (rendered)
        lines.push(`${indent}${rendered.replace(/\n/g, `\n${indent}`)}`)
      return
    }

    let marker = "- "
    if (kind === "orderedList") marker = `${start + index}. `
    if (item.type.name === "taskItem") {
      marker = item.attrs.checked ? "- [x] " : "- [ ] "
    }

    const blocks = children(item)
    let head = false
    for (const block of blocks) {
      if (!head && !isList(block)) {
        const rendered = renderBlock(block, depth + 1)
        lines.push(
          `${indent}${marker}${(rendered ?? "").replace(/\n/g, `\n${itemIndent}`)}`
        )
        head = true
        continue
      }
      const rendered = renderBlock(block, depth + 1)
      if (rendered === null || rendered === "") continue
      if (!head) {
        // 项里第一个块就是嵌套列表：占位一个空项，避免整段被吞掉。
        lines.push(`${indent}${marker}`.trimEnd())
        head = true
      }
      const prefix = isList(block) ? "" : itemIndent
      lines.push(
        rendered
          .split("\n")
          .map((line) => (line === "" ? "" : `${prefix}${line}`))
          .join("\n")
      )
    }
    if (!head) lines.push(`${indent}${marker}`.trimEnd())
  })

  return lines.join("\n")
}

/** 单个块级节点 → MD 文本（列表自带缩进；null 表示这个节点不产出内容）。 */
function renderBlock(node: ProseMirrorNode, depth: number): string | null {
  switch (node.type.name) {
    case "paragraph": {
      const text = renderInline(node)
      return text === "" ? null : text
    }
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs.level) || 1, 1), 6)
      const text = renderInline(node)
      return text === "" ? null : `${"#".repeat(level)} ${text}`
    }
    case "codeBlock":
      return renderCodeBlock(node)
    case "blockquote":
      return renderBlockquote(node)
    case "horizontalRule":
      return "---"
    case "image":
      return renderImage(node)
    case "table":
      return renderTable(node)
    case "bulletList":
    case "orderedList":
    case "taskList":
      return renderList(node, depth)
    default: {
      // 未知块级节点：降级为它的子节点内容（规格的「只留文字」兜底）。
      if (node.isText) return withMarks(node, node.text ?? "")
      const inner = renderBlocks(children(node), depth)
      return inner.length === 0 ? null : inner.join("\n\n")
    }
  }
}

function renderBlocks(nodes: ProseMirrorNode[], depth: number): string[] {
  const out: string[] = []
  for (const node of nodes) {
    const rendered = renderBlock(node, depth)
    if (rendered !== null && rendered.trim() !== "") out.push(rendered)
  }
  return out
}

/**
 * TipTap JSON → Markdown。JSON 不合法（未知节点/属性、根不是 doc）时抛
 * `TiptapRenderError`，与 `renderTiptapHtml` 同一口径。
 *
 * 输出不带标题行（`content_md` 只有正文，下载时由调用方补 `# 标题`），也不带结尾换行。
 */
export function serializeTiptapMarkdown(json: unknown): string {
  return renderBlocks(children(parseTiptapDoc(json)), 0).join("\n\n")
}

/**
 * 页面正文的 MD 派生：**永不抛错**。
 *
 * 读路径与迁移回填都靠它——规格要求「content_md 为空时按需现生成，不许报错或返回
 * 空文档」。JSON 是空串、解析不了、或按当前 schema 渲染不了（历史脏数据）时，退回
 * 已经消毒过的纯文本（`content_text`），至少内容还在，也不让一次坏数据拖垮整轮迁移。
 */
export function derivePageMarkdown(
  contentJson: string,
  contentText: string
): string {
  if (!contentJson) return contentText
  try {
    return serializeTiptapMarkdown(JSON.parse(contentJson))
  } catch {
    return contentText
  }
}

export interface MarkdownSource {
  /** `pages.content_md`；列还不存在或尚未回填时为 null / undefined / 空串。 */
  content_md?: string | null
  content_json: string
  content_text: string
}

/** 读路径取值口径：库里有 `content_md` 就用它，没有就按需现生成。 */
export function resolvePageMarkdown(row: MarkdownSource): string {
  if (row.content_md) return row.content_md
  return derivePageMarkdown(row.content_json, row.content_text)
}
