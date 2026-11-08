import type { PageNode } from "@/lib/api"

/** 页面树在 UI 里的扁平视图：只含当前展开的层级。 */
export interface TreeRow {
  id: string
  title: string
  parentId: string | null
  depth: number
  sortOrder: number
  hasChildren: boolean
}

export interface DropTarget {
  parentId: string | null
  /** 落在同级里的第几位（0 基）。 */
  sortOrder: number
}

export const INDENT_WIDTH = 18

export function sortSiblings(nodes: PageNode[]): PageNode[] {
  return [...nodes].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, "zh-CN")
  )
}

export function flattenVisible(
  nodes: PageNode[],
  expanded: Set<string>
): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (list: PageNode[], depth: number, parentId: string | null) => {
    sortSiblings(list).forEach((node) => {
      rows.push({
        id: node.id,
        title: node.title,
        parentId,
        depth,
        sortOrder: node.sortOrder,
        hasChildren: node.children.length > 0
      })
      if (node.children.length && expanded.has(node.id))
        walk(node.children, depth + 1, node.id)
    })
  }
  walk(nodes, 0, null)
  return rows
}

export function findNode(nodes: PageNode[], id: string): PageNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const hit = findNode(node.children, id)
    if (hit) return hit
  }
  return null
}

/** 面包屑：从根到目标页的整条链路。 */
export function findPath(nodes: PageNode[], id: string): PageNode[] {
  for (const node of nodes) {
    if (node.id === id) return [node]
    const childPath = findPath(node.children, id)
    if (childPath.length) return [node, ...childPath]
  }
  return []
}

export function siblingsOf(
  nodes: PageNode[],
  parentId: string | null
): PageNode[] {
  if (!parentId) return sortSiblings(nodes)
  const parent = findNode(nodes, parentId)
  return parent ? sortSiblings(parent.children) : []
}

/** 树的第一页（首页跳转用）：深度优先取第一个页面。 */
export function firstPageId(nodes: PageNode[]): string | null {
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
  activeId: string,
  overId: string,
  dragOffsetX: number,
  indentWidth = INDENT_WIDTH
): DropTarget | null {
  if (activeId === overId) return null
  const overIndex = rows.findIndex((row) => row.id === overId)
  const activeIndex = rows.findIndex((row) => row.id === activeId)
  if (overIndex < 0 || activeIndex < 0) return null
  const overRow = rows[overIndex]
  const dragDepth = Math.round(dragOffsetX / indentWidth)
  const projectedDepth = Math.max(
    0,
    Math.min(overRow.depth + dragDepth, overRow.depth + 1)
  )

  // 不能落到自己的子树里（拖动整棵子树时，active 的所有后代都应被忽略）。
  const activeRow = rows[activeIndex]
  let activeSubtreeEnd = activeIndex + 1
  while (
    activeSubtreeEnd < rows.length &&
    rows[activeSubtreeEnd].depth > activeRow.depth
  ) {
    activeSubtreeEnd += 1
  }
  if (overIndex > activeIndex && overIndex < activeSubtreeEnd) return null

  let parentId: string | null = null
  if (projectedDepth > 0) {
    for (let index = overIndex - 1; index >= 0; index -= 1) {
      const row = rows[index]
      if (row.depth === projectedDepth - 1) {
        // 不能把页面挂到自己的子孙下面
        if (row.id === activeId) return null
        parentId = row.id
        break
      }
      if (row.depth < projectedDepth - 1) return null
    }
    if (!parentId) return null
  }

  // 目标父级下，over 行所属的那一层祖先（同父级的兄弟）决定插入位置。
  let anchorIndex = overIndex
  while (anchorIndex > 0 && rows[anchorIndex].parentId !== parentId) {
    anchorIndex -= 1
  }
  const anchor = rows[anchorIndex]
  if (!anchor || anchor.parentId !== parentId) return null

  const siblings = rows.filter(
    (row) => row.parentId === parentId && row.id !== activeId
  )
  const position = siblings.findIndex((row) => row.id === anchor.id)
  if (position < 0) return null

  // 往下拖时插到目标行之后：否则「拖到某个兄弟上」永远落在它前面，
  // 同级最后一位也就永远达不到（契约里 sortOrder 是插入下标，允许等于列表长度）。
  const movingDown = overIndex > activeIndex
  return { parentId, sortOrder: movingDown ? position + 1 : position }
}

/** 同级出现重复（或乱序）的 sortOrder 时需要客户端校正一次。 */
export function needsRenumber(siblings: PageNode[]): boolean {
  const sorted = sortSiblings(siblings)
  return sorted.some((node, index) => node.sortOrder !== index)
}
