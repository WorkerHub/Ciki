import { currentLanguage } from "@/i18n"
import type { PageNode } from "@/lib/api"
import { intlLocale } from "@/lib/language"

/** 页面树在 UI 里的扁平视图：只含当前展开的层级。 */
export interface TreeRow {
  id: number
  title: string
  parentId: number | null
  depth: number
  sortOrder: number
  hasChildren: boolean
  /** 全部子页数（含未展开的），拖拽嵌套时用它能落到子列表真正的末尾。 */
  childCount: number
}

export interface DropTarget {
  parentId: number | null
  /** 落在同级里的第几位（0 基）。 */
  sortOrder: number
}

/** 拖动中的落点预览：缩进深度决定线画多右，before/after 决定画在哪一行的边上。 */
export interface DropPreview {
  /** 落点层级（0 = 根级）。 */
  depth: number
  beforeId?: number
  afterId?: number
}

export const INDENT_WIDTH = 18

export function sortSiblings(nodes: PageNode[]): PageNode[] {
  // 排序口径跟随界面语言（规格 §2.11）：中文 zh-CN、英文 en-US。
  const locale = intlLocale(currentLanguage())
  return [...nodes].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, locale)
  )
}

export function flattenVisible(
  nodes: PageNode[],
  expanded: Set<number>
): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (list: PageNode[], depth: number, parentId: number | null) => {
    sortSiblings(list).forEach((node) => {
      rows.push({
        id: node.id,
        title: node.title,
        parentId,
        depth,
        sortOrder: node.sortOrder,
        hasChildren: node.children.length > 0,
        childCount: node.children.length
      })
      if (node.children.length && expanded.has(node.id))
        walk(node.children, depth + 1, node.id)
    })
  }
  walk(nodes, 0, null)
  return rows
}

/** 整棵树全部展开后的扁平视图（对话框里列父页面选项用）。 */
export function flattenAll(nodes: PageNode[]): TreeRow[] {
  const expanded = new Set<number>()
  const collect = (list: PageNode[]) => {
    for (const node of list) {
      if (!node.children.length) continue
      expanded.add(node.id)
      collect(node.children)
    }
  }
  collect(nodes)
  return flattenVisible(nodes, expanded)
}

/** 剪掉指定页面及其全部后代（避免把页面挂到自己或自己的子孙下面）。 */
export function withoutSubtree(nodes: PageNode[], id: number): PageNode[] {
  return nodes
    .filter((node) => node.id !== id)
    .map((node) =>
      node.children.length
        ? { ...node, children: withoutSubtree(node.children, id) }
        : node
    )
}

export function findNode(nodes: PageNode[], id: number): PageNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const hit = findNode(node.children, id)
    if (hit) return hit
  }
  return null
}

/** 面包屑：从根到目标页的整条链路。 */
export function findPath(nodes: PageNode[], id: number): PageNode[] {
  for (const node of nodes) {
    if (node.id === id) return [node]
    const childPath = findPath(node.children, id)
    if (childPath.length) return [node, ...childPath]
  }
  return []
}

export function siblingsOf(
  nodes: PageNode[],
  parentId: number | null
): PageNode[] {
  if (!parentId) return sortSiblings(nodes)
  const parent = findNode(nodes, parentId)
  return parent ? sortSiblings(parent.children) : []
}

/** 树的第一页（首页跳转用）：深度优先取第一个页面。 */
export function firstPageId(nodes: PageNode[]): number | null {
  const first = sortSiblings(nodes)[0]
  if (!first) return null
  return first.id
}

/** 整棵树的页面总数（空间设置里做「有页面不可删」的判断）。 */
export function countNodes(nodes: PageNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0)
}

/**
 * 拖拽落点投影：行的水平位移换算成缩进层级，再折算成目标父页与同级下标。
 * 与 dnd-kit 官方的 sortable tree 思路一致：只能落到 over 行的同层或下一层。
 */
export function projectDrop(
  rows: TreeRow[],
  activeId: number,
  overId: number,
  dragOffsetX: number,
  indentWidth = INDENT_WIDTH
): DropTarget | null {
  if (activeId === overId) return null
  const overIndex = rows.findIndex((row) => row.id === overId)
  const activeIndex = rows.findIndex((row) => row.id === activeId)
  if (overIndex < 0 || activeIndex < 0) return null
  const activeRow = rows[activeIndex]
  const overRow = rows[overIndex]

  // 不能落到自己的子树里（拖动整棵子树时，active 的所有后代都应被忽略）。
  let activeSubtreeEnd = activeIndex + 1
  while (
    activeSubtreeEnd < rows.length &&
    rows[activeSubtreeEnd].depth > activeRow.depth
  ) {
    activeSubtreeEnd += 1
  }
  if (overIndex > activeIndex && overIndex < activeSubtreeEnd) return null

  const dragDepth = Math.round(dragOffsetX / indentWidth)
  // 层级只夹在 over 行所在层与它的下一层之间：右拖一档 = 嵌到 over 行下面。
  const projectedDepth = Math.max(
    0,
    Math.min(overRow.depth + dragDepth, overRow.depth + 1)
  )

  // 深一档：over 行本身就是父页，落进它子列表的末尾（childCount 含未展开的子页）。
  if (projectedDepth > overRow.depth) {
    return { parentId: overRow.id, sortOrder: overRow.childCount }
  }

  const parentId = overRow.parentId
  const siblings = rows.filter(
    (row) => row.parentId === parentId && row.id !== activeId
  )
  const position = siblings.findIndex((row) => row.id === overRow.id)
  if (position < 0) return null

  // 往下拖时插到目标行之后：否则「拖到某个兄弟上」永远落在它前面，
  // 同级最后一位也就永远达不到（契约里 sortOrder 是插入下标，允许等于列表长度）。
  const movingDown = overIndex > activeIndex
  return { parentId, sortOrder: movingDown ? position + 1 : position }
}

/** `DragEndEvent` 里我们真正用到的那几个字段（测试不必伪造整个事件对象）。 */
export interface DragEndLike {
  active: { id: unknown }
  over: { id: unknown } | null
  delta: { x: number }
}

/**
 * 松手时的落点：位移只从事件上取。
 * `onDragMove` 里写进 React state 的那份是「最近一次已提交渲染」的值，
 * dnd-kit 在 pointerup 时调用的还是旧闭包，常常读到 0（横向位移丢失）。
 */
export function dropFromDragEnd(
  rows: TreeRow[],
  event: DragEndLike
): DropTarget | null {
  if (!event.over) return null
  return projectDrop(
    rows,
    Number(event.active.id),
    Number(event.over.id),
    event.delta.x
  )
}

/** 把落点换算成「画在哪一行、缩进多少」，拖动过程中据此显示层级预览。 */
export function dropPreview(
  rows: TreeRow[],
  activeId: number,
  target: DropTarget | null
): DropPreview | null {
  if (!target) return null
  const parent =
    target.parentId === null
      ? null
      : (rows.find((row) => row.id === target.parentId) ?? null)
  if (target.parentId !== null && !parent) return null
  const depth = parent ? parent.depth + 1 : 0
  const siblings = rows.filter(
    (row) => row.parentId === target.parentId && row.id !== activeId
  )
  const next = siblings[target.sortOrder]
  if (next) return { depth, beforeId: next.id }
  const last = siblings[siblings.length - 1]
  if (last) return { depth, afterId: last.id }
  // 该层还没有别的页面：线画在父页行之后（父页折叠时也表示「作为它的子页」）。
  return parent ? { depth, afterId: parent.id } : null
}

/** 同级出现重复（或乱序）的 sortOrder 时需要客户端校正一次。 */
export function needsRenumber(siblings: PageNode[]): boolean {
  const sorted = sortSiblings(siblings)
  return sorted.some((node, index) => node.sortOrder !== index)
}
