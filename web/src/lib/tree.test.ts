import { describe, expect, it } from "vitest"
import type { PageNode } from "@/lib/api"
import {
  findNode,
  findPath,
  firstPageId,
  flattenVisible,
  needsRenumber,
  projectDrop,
  siblingsOf
} from "@/lib/tree"

function node(
  id: string,
  title: string,
  sortOrder: number,
  children: PageNode[] = [],
  parentId: string | null = null
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
  node("a", "A", 0, [
    node("a1", "A1", 0, [], "a"),
    node("a2", "A2", 1, [], "a")
  ]),
  node("b", "B", 1),
  node("c", "C", 2)
]

describe("页面树工具", () => {
  it("只展开已展开父页的子级", () => {
    const collapsed = flattenVisible(tree, new Set())
    expect(collapsed.map((row) => row.id)).toEqual(["a", "b", "c"])
    const expanded = flattenVisible(tree, new Set(["a"]))
    expect(expanded.map((row) => row.id)).toEqual(["a", "a1", "a2", "b", "c"])
    expect(expanded.find((row) => row.id === "a1")?.depth).toBe(1)
  })

  it("按 sortOrder 排序，标题作稳定兜底", () => {
    const shuffled = [node("x", "X", 2), node("y", "Y", 0), node("z", "Z", 1)]
    expect(flattenVisible(shuffled, new Set()).map((row) => row.id)).toEqual([
      "y",
      "z",
      "x"
    ])
  })

  it("面包屑给出从根到目标的链路", () => {
    expect(findPath(tree, "a2").map((item) => item.id)).toEqual(["a", "a2"])
    expect(findPath(tree, "missing")).toEqual([])
  })

  it("首页取第一棵树的第一页", () => {
    expect(firstPageId(tree)).toBe("a")
    expect(firstPageId([])).toBeNull()
  })

  it("同级列表按父页取", () => {
    expect(siblingsOf(tree, "a").map((item) => item.id)).toEqual(["a1", "a2"])
    expect(siblingsOf(tree, null).map((item) => item.id)).toEqual([
      "a",
      "b",
      "c"
    ])
    expect(findNode(tree, "a2")?.title).toBe("A2")
  })

  it("拖拽：不移动水平位置时保持原层级，插到目标之前", () => {
    const rows = flattenVisible(tree, new Set(["a"]))
    expect(projectDrop(rows, "c", "a", 0)).toEqual({
      parentId: null,
      sortOrder: 0
    })
  })

  it("拖拽：向右缩进一格后挂到目标页下面", () => {
    const rows = flattenVisible(tree, new Set(["a"]))
    const target = projectDrop(rows, "b", "a1", 0)
    expect(target).toEqual({ parentId: "a", sortOrder: 0 })
  })

  it("拖拽：不能落到自己的子树里", () => {
    const rows = flattenVisible(tree, new Set(["a"]))
    expect(projectDrop(rows, "a", "a1", 0)).toBeNull()
    expect(projectDrop(rows, "a", "a", 0)).toBeNull()
  })

  it("拖拽：向下移动时插到目标行之后（A 拖到 C 上 → 落到最后一位）", () => {
    const rows = flattenVisible(tree, new Set())
    expect(projectDrop(rows, "a", "c", 0)).toEqual({
      parentId: null,
      sortOrder: 2
    })
  })

  it("拖拽：向上移动时插到目标行之前", () => {
    const rows = flattenVisible(tree, new Set())
    expect(projectDrop(rows, "c", "a", 0)).toEqual({
      parentId: null,
      sortOrder: 0
    })
  })

  it("拖拽：向下移动一格（B → C）落点紧随目标", () => {
    const rows = flattenVisible(tree, new Set())
    expect(projectDrop(rows, "b", "c", 0)).toEqual({
      parentId: null,
      sortOrder: 2
    })
  })

  it("拖拽：跨父级向上时插到目标之前", () => {
    const rows = flattenVisible(tree, new Set(["a"]))
    expect(projectDrop(rows, "c", "a1", 0)).toEqual({
      parentId: "a",
      sortOrder: 0
    })
  })

  it("拖拽：跨父级向下时插到目标之后（子页拖到根层末尾）", () => {
    const rows = flattenVisible(tree, new Set(["a"]))
    expect(projectDrop(rows, "a1", "c", 0)).toEqual({
      parentId: null,
      sortOrder: 3
    })
  })

  it("同级 sortOrder 不连续或重名时提示需要重排", () => {
    expect(needsRenumber([node("p", "P", 0), node("q", "Q", 1)])).toBe(false)
    expect(needsRenumber([node("p", "P", 0), node("q", "Q", 5)])).toBe(true)
  })
})
