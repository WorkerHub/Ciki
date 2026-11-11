import { describe, expect, it } from "vitest"
import type { PageNode } from "@/lib/api"
import {
  countNodes,
  findNode,
  findPath,
  firstPageId,
  flattenVisible,
  needsRenumber,
  projectDrop,
  siblingsOf
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

  it("拖拽：不移动水平位置时保持原层级，插到目标之前", () => {
    const rows = flattenVisible(tree, new Set([1]))
    expect(projectDrop(rows, 5, 1, 0)).toEqual({
      parentId: null,
      sortOrder: 0
    })
  })

  it("拖拽：向右缩进一格后挂到目标页下面", () => {
    const rows = flattenVisible(tree, new Set([1]))
    const target = projectDrop(rows, 4, 2, 0)
    expect(target).toEqual({ parentId: 1, sortOrder: 0 })
  })

  it("拖拽：不能落到自己的子树里", () => {
    const rows = flattenVisible(tree, new Set([1]))
    expect(projectDrop(rows, 1, 2, 0)).toBeNull()
    expect(projectDrop(rows, 1, 1, 0)).toBeNull()
  })

  it("拖拽：向下移动时插到目标行之后（A 拖到 C 上 → 落到最后一位）", () => {
    const rows = flattenVisible(tree, new Set())
    expect(projectDrop(rows, 1, 5, 0)).toEqual({
      parentId: null,
      sortOrder: 2
    })
  })

  it("拖拽：向上移动时插到目标行之前", () => {
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

  it("拖拽：跨父级向上时插到目标之前", () => {
    const rows = flattenVisible(tree, new Set([1]))
    expect(projectDrop(rows, 5, 2, 0)).toEqual({
      parentId: 1,
      sortOrder: 0
    })
  })

  it("拖拽：跨父级向下时插到目标之后（子页拖到根层末尾）", () => {
    const rows = flattenVisible(tree, new Set([1]))
    expect(projectDrop(rows, 2, 5, 0)).toEqual({
      parentId: null,
      sortOrder: 3
    })
  })

  it("统计整棵树的页面数（含全部子孙）", () => {
    expect(countNodes([])).toBe(0)
    expect(countNodes(tree)).toBe(5)
  })

  it("同级 sortOrder 不连续或重名时提示需要重排", () => {
    expect(needsRenumber([node(9, "P", 0), node(10, "Q", 1)])).toBe(false)
    expect(needsRenumber([node(9, "P", 0), node(10, "Q", 5)])).toBe(true)
  })
})
