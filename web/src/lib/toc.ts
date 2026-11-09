/**
 * 阅读页右侧索引（TOC）：数据从详情已下发的 contentJson 同步提取，
 * 不新增接口、不改存储——标题的文字与层级本来就都在 JSON 里。
 *
 * 锚点 id 按收录顺序位置式生成（heading-1、heading-2…），所以同名标题
 * 各跳各的，不依赖标题文字。内容改版后 id 随顺序变化是可接受的取舍。
 */

export interface TocItem {
  /** 位置式锚点：heading-1、heading-2 …（同名标题不碰撞）。 */
  id: string
  /** 标题层级，只收录 1–3 级。 */
  level: number
  /** 标题的纯文字：该标题节点全部后代 text 节点的拼接。 */
  text: string
}

/** 少于这个条数整篇不显示索引，布局与现状完全一致。 */
export const TOC_MIN_ITEMS = 2

/**
 * 顶层标题选择器：正文根元素（TipTap 的 .ProseMirror）的直接子节点才对应
 * doc.content 的顶层块，代码块/引用块里的标题不该拿到锚点。
 */
export const TOP_LEVEL_HEADINGS = ":scope > h1, :scope > h2, :scope > h3"

interface JsonNode {
  type?: string
  text?: string
  attrs?: { level?: unknown }
  content?: JsonNode[]
}

/** 拼接节点全部后代的文字（行内加粗/代码/链接的文字都算标题的一部分）。 */
function collectText(node: JsonNode): string {
  if (typeof node.text === "string") return node.text
  if (!Array.isArray(node.content)) return ""
  return node.content.map(collectText).join("")
}

/**
 * 从 contentJson 提取 1–3 级标题；不足 2 条（含非法 JSON / 空文档）返回空数组，
 * 调用方据此完全不渲染索引轨。
 */
export function extractToc(contentJson: string): TocItem[] {
  if (!contentJson.trim()) return []

  let doc: JsonNode
  try {
    doc = JSON.parse(contentJson) as JsonNode
  } catch {
    return []
  }
  if (!doc || !Array.isArray(doc.content)) return []

  const items: TocItem[] = []
  for (const node of doc.content) {
    if (node?.type !== "heading") continue
    const level = Number(node.attrs?.level)
    if (!Number.isInteger(level) || level < 1 || level > 3) continue
    const text = collectText(node).trim()
    if (!text) continue
    items.push({ id: `heading-${items.length + 1}`, level, text })
  }

  return items.length >= TOC_MIN_ITEMS ? items : []
}
