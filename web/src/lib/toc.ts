/**
 * 阅读页右侧索引（TOC）：数据从详情已下发的 `contentHtml` 同步解析，
 * 不新增接口、不读 R2——正文 HTML 本来就在阅读热路径上。
 *
 * 锚点 id 按收录顺序位置式生成（heading-1、heading-2…），所以同名标题
 * 各跳各的，不依赖标题文字。内容改版后 id 随顺序变化是可接受的取舍。
 */

export interface TocItem {
  /** 位置式锚点：heading-1、heading-2 …（同名标题不碰撞）。 */
  id: string
  /** 标题层级，只收录 1–3 级。 */
  level: number
  /** 标题的纯文字：该标题节点全部后代文本的拼接。 */
  text: string
}

/** 少于这个条数整篇不显示索引，布局与现状完全一致。 */
export const TOC_MIN_ITEMS = 2

/**
 * 顶层标题选择器：正文根元素（TipTap 的 .ProseMirror，或解析 HTML 后的 body）
 * 的直接子节点才对应文档顶层块，代码块/引用块/表格里的标题不该拿到锚点。
 */
export const TOP_LEVEL_HEADINGS = ":scope > h1, :scope > h2, :scope > h3"

/**
 * 从正文 HTML 提取 1–3 级顶层标题；不足 2 条（含空串 / 无标题）返回空数组，
 * 调用方据此完全不渲染索引轨。
 *
 * 空标题按 `textContent.trim()` 跳过——与 `ReadView` 补锚点 id 的判据完全一致，
 * 否则空标题会抢走 heading-1、把后面的锚点整体顶偏一位。
 */
export function extractToc(contentHtml: string): TocItem[] {
  if (!contentHtml.trim()) return []
  const body = new DOMParser().parseFromString(contentHtml, "text/html").body

  const items: TocItem[] = []
  for (const heading of body.querySelectorAll<HTMLElement>(
    TOP_LEVEL_HEADINGS
  )) {
    const text = heading.textContent?.trim() ?? ""
    if (!text) continue
    const level = Number(heading.tagName.slice(1))
    if (!Number.isInteger(level) || level < 1 || level > 3) continue
    items.push({ id: `heading-${items.length + 1}`, level, text })
  }

  return items.length >= TOC_MIN_ITEMS ? items : []
}
