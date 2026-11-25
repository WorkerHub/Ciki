import { describe, expect, it } from "vitest"
import type { PageNode } from "@/lib/api"
import {
  countNodes,
  dropFromDragEnd,
  dropPreview,
  findNode,
  findPath,
  firstPageId,
  flattenAll,
  flattenVisible,
  needsRenumber,
  placeNodeInTree,
  projectDrop,
  pruneNodeFromTree,
  siblingsOf,
  withoutSubtree
} from "@/lib/tree"

function node(
  id: number,
  title: string,
  sortOrder: number,
  children: PageNode[] = [],
  parentId: number | null = null
): PageNode {
  return {
    id,
    title,
    sortOrder,
    parentId,
    updatedAt: "2026-11-07T00:00:00.000Z",
    children
  }
}

const tree: PageNode[] = [
  node(1, "A", 0, [node(2, "A1", 0, [], 1), node(3, "A2", 1, [], 1)]),
  node(4, "B", 1),
  node(5, "C", 2)
]

describe("页面树工具", () => {
  it("只展开已展开父页的子级", () => {
    const collapsed = flattenVisible(tree, new Set())
    expect(collapsed.map((row) => row.id)).toEqual([1, 4, 5])
    const expanded = flattenVisible(tree, new Set([1]))
    expect(expanded.map((row) => row.id)).toEqual([1, 2, 3, 4, 5])
    expect(expanded.find((row) => row.id === 2)?.depth).toBe(1)
  })

  it("按 sortOrder 排序，标题作稳定兜底", () => {
    const shuffled = [node(6, "X", 2), node(7, "Y", 0), node(8, "Z", 1)]
    expect(flattenVisible(shuffled, new Set()).map((row) => row.id)).toEqual([
      7, 8, 6
    ])
  })

  it("面包屑给出从根到目标的链路", () => {
    expect(findPath(tree, 3).map((item) => item.id)).toEqual([1, 3])
    expect(findPath(tree, 99)).toEqual([])
  })

  it("首页取第一棵树的第一页", () => {
    expect(firstPageId(tree)).toBe(1)
    expect(firstPageId([])).toBeNull()
  })

  it("同级列表按父页取", () => {
    expect(siblingsOf(tree, 1).map((item) => item.id)).toEqual([2, 3])
    expect(siblingsOf(tree, null).map((item) => item.id)).toEqual([1, 4, 5])
    expect(findNode(tree, 3)?.title).toBe("A2")
  })

  it("首屏行带上子页总数（含未展开的），拖拽嵌套据此落到末尾", () => {
    const rows = flattenVisible(tree, new Set())
    expect(rows.find((row) => row.id === 1)?.childCount).toBe(2)
    expect(rows.find((row) => row.id === 4)?.childCount).toBe(0)
  })

  it("整棵树展平：父页在前、子页紧跟、缩进层级正确", () => {
    expect(flattenAll(tree).map((row) => [row.id, row.depth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 1],
      [4, 0],
      [5, 0]
    ])
  })

  it("剪掉指定页面与它的全部后代，父子链路不变", () => {
    const pruned = withoutSubtree(tree, 1)
    expect(pruned.map((node) => node.id)).toEqual([4, 5])
    expect(withoutSubtree(tree, 2).map((node) => node.id)).toEqual([1, 4, 5])
    expect(
      findNode(withoutSubtree(tree, 2), 1)?.children.map((n) => n.id)
    ).toEqual([3])
  })

  it("拖拽：向下移动时插到目标行之后（A 拖到 C 上 → 落到同级最后一位）", () => {
    const rows = flattenVisible(tree, new Set())
    expect(projectDrop(rows, 1, 5, 0)).toEqual({
      parentId: null,
      sortOrder: 2
    })
  })

  it("拖拽：向上移动时插到目标行之前（C 拖到 A 上 → 插在同级第一位）", () => {
    const rows = flattenVisible(tree, new Set())
    expect(projectDrop(rows, 5, 1, 0)).toEqual({
      parentId: null,
      sortOrder: 0
    })
  })

  it("拖拽：向下移动一格（B → C）落点紧随目标", () => {
    const rows = flattenVisible(tree, new Set())
    expect(projectDrop(rows, 4, 5, 0)).toEqual({
      parentId: null,
      sortOrder: 2
    })
  })

  it("拖拽：子页内部同级向下移动（A1 拖到 A2）", () => {
    const rows = flattenVisible(tree, new Set([1]))
    expect(projectDrop(rows, 2, 3, 0)).toEqual({
      parentId: 1,
      sortOrder: 1
    })
  })

  it("拖拽：去掉横向换层级，横向位移不改变父级或层级", () => {
    const rows = flattenVisible(tree, new Set([1]))
    // 即使右拖 36px，B 悬停在 C 上依然只是同级排序，不嵌入
    expect(projectDrop(rows, 4, 5, 36)).toEqual({
      parentId: null,
      sortOrder: 2
    })
  })

  it("拖拽：只保留同级排序，跨父级悬停返回 null", () => {
    const rows = flattenVisible(tree, new Set([1]))
    // 根级 B 悬停在子页 A1 上：非同级，返回 null
    expect(projectDrop(rows, 4, 2, 0)).toBeNull()
    // 子页 A1 悬停在根级 B 上：非同级，返回 null
    expect(projectDrop(rows, 2, 4, 0)).toBeNull()
  })

  it("拖拽：不能落到自己身上", () => {
    const rows = flattenVisible(tree, new Set([1]))
    expect(projectDrop(rows, 1, 1, 0)).toBeNull()
    expect(projectDrop(rows, 2, 2, 18)).toBeNull()
  })

  it("统计整棵树的页面数（含全部子孙）", () => {
    expect(countNodes([])).toBe(0)
    expect(countNodes(tree)).toBe(5)
  })

  it("拖拽取值：dropFromDragEnd 恒定同级落点", () => {
    const rows = flattenVisible(tree, new Set([1]))
    expect(
      dropFromDragEnd(rows, {
        active: { id: 4 },
        over: { id: 5 },
        delta: { x: 18 }
      })
    ).toEqual({ parentId: null, sortOrder: 2 })
    expect(
      dropFromDragEnd(rows, {
        active: { id: 4 },
        over: { id: 5 },
        delta: { x: 0 }
      })
    ).toEqual({ parentId: null, sortOrder: 2 })
    // 没落在任何行上
    expect(
      dropFromDragEnd(rows, { active: { id: 4 }, over: null, delta: { x: 18 } })
    ).toBeNull()
  })

  it("落点预览：同级往后拖时线画在目标行之后，深度固定为本层", () => {
    const rows = flattenVisible(tree, new Set([1]))
    const target = projectDrop(rows, 4, 5, 0)
    expect(dropPreview(rows, 4, target)).toEqual({ depth: 0, afterId: 5 })
  })

  it("落点预览：同级往前拖时线画在目标行之前，深度固定为本层", () => {
    const rows = flattenVisible(tree, new Set([1]))
    const target = projectDrop(rows, 5, 1, 0)
    expect(dropPreview(rows, 5, target)).toEqual({ depth: 0, beforeId: 1 })
  })

  it("落点预览：没有落点或目标为 null 时不出线", () => {
    const rows = flattenVisible(tree, new Set([1]))
    expect(dropPreview(rows, 1, null)).toBeNull()
    expect(dropPreview(rows, 4, projectDrop(rows, 4, 2, 0))).toBeNull()
  })

  it("本地树落位：同级向下移动更新 sortOrder", () => {
    const updated = placeNodeInTree(tree, 1, null, 2)
    expect(updated.map((n) => [n.id, n.sortOrder])).toEqual([
      [4, 0],
      [5, 1],
      [1, 2]
    ])
    // 子节点结构保持完整
    expect(findNode(updated, 1)?.children.map((n) => n.id)).toEqual([2, 3])
  })

  it("本地树落位：同级向上移动更新 sortOrder", () => {
    const updated = placeNodeInTree(tree, 5, null, 0)
    expect(updated.map((n) => [n.id, n.sortOrder])).toEqual([
      [5, 0],
      [1, 1],
      [4, 2]
    ])
  })

  it("本地树落位：子级同级移动", () => {
    const updated = placeNodeInTree(tree, 2, 1, 1)
    const children = findNode(updated, 1)?.children ?? []
    expect(children.map((n) => [n.id, n.sortOrder])).toEqual([
      [3, 0],
      [2, 1]
    ])
  })

  it("本地树落位：跨父级移动（MovePageDialog 场景）", () => {
    const updated = placeNodeInTree(tree, 2, null, 1)
    expect(updated.map((n) => [n.id, n.sortOrder, n.parentId])).toEqual([
      [1, 0, null],
      [2, 1, null],
      [4, 2, null],
      [5, 3, null]
    ])
    // 原父级剩余子级重新赋 0 起编号
    expect(
      findNode(updated, 1)?.children.map((n) => [n.id, n.sortOrder])
    ).toEqual([[3, 0]])
  })

  it("本地树落位：防环（不能移到自己的子树内）", () => {
    const updated = placeNodeInTree(tree, 1, 2, 0)
    expect(updated).toEqual(tree)
  })

  it("本地树剪枝：从树中移除页面并对原同级重新编号", () => {
    const pruned = pruneNodeFromTree(tree, 4)
    expect(pruned.map((n) => [n.id, n.sortOrder])).toEqual([
      [1, 0],
      [5, 1]
    ])
  })

  it("同级 sortOrder 不连续或重名时提示需要重排", () => {
    expect(needsRenumber([node(9, "P", 0), node(10, "Q", 1)])).toBe(false)
    expect(needsRenumber([node(9, "P", 0), node(10, "Q", 5)])).toBe(true)
  })
})
