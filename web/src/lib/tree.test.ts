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
  projectDrop,
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

  it("拖拽：不移动水平位置时保持原层级，插到目标之前", () => {
    const rows = flattenVisible(tree, new Set([1]))
    expect(projectDrop(rows, 5, 1, 0)).toEqual({
      parentId: null,
      sortOrder: 0
    })
  })

  it("拖拽：不横拖落在子页行上 = 与它同级（仍挂在它父页下）", () => {
    const rows = flattenVisible(tree, new Set([1]))
    const target = projectDrop(rows, 4, 2, 0)
    expect(target).toEqual({ parentId: 1, sortOrder: 0 })
  })

  it("拖拽：根级页右拖一档，嵌到最上面那行（同级第一行）下面", () => {
    const rows = flattenVisible(tree, new Set([1]))
    // 悬停在 A 上：A 就是父页，落进它子列表末尾（A 已有 A1、A2 两页）
    expect(projectDrop(rows, 4, 1, 18)).toEqual({ parentId: 1, sortOrder: 2 })
  })

  it("拖拽：右拖一档落在子页行上，父页是该子页自己而不是它的前一个同级", () => {
    const rows = flattenVisible(tree, new Set([1]))
    // 悬停在 A2（A 的第二个子页）上：拖 C 右拖一档 → 成为 A2 的子页
    expect(projectDrop(rows, 5, 3, 18)).toEqual({ parentId: 3, sortOrder: 0 })
    // 同一次悬停在 A2 上，不横拖则是 A2 的同级（仍是 A 的子页，排在 A2 之前）
    expect(projectDrop(rows, 5, 3, 0)).toEqual({ parentId: 1, sortOrder: 1 })
  })

  it("拖拽：嵌套目标带折叠子页时，下标取全部子页数（落到末尾）", () => {
    // A 未展开（rows 里没有 A1/A2），childCount 仍是 2
    const rows = flattenVisible(tree, new Set())
    expect(projectDrop(rows, 4, 1, 18)).toEqual({ parentId: 1, sortOrder: 2 })
  })

  it("拖拽：左拖一档把子页升回上一层（A1 升到根级）", () => {
    const rows = flattenVisible(tree, new Set([1]))
    expect(projectDrop(rows, 2, 1, -18)).toEqual({
      parentId: null,
      sortOrder: 0
    })
    // 继续往左拖不再升层：夹在 over 行所在层
    expect(projectDrop(rows, 2, 1, -54)).toEqual({
      parentId: null,
      sortOrder: 0
    })
  })

  it("拖拽：右拖两档以上仍只嵌一层（夹在 over 行下一层）", () => {
    const rows = flattenVisible(tree, new Set([1]))
    expect(projectDrop(rows, 4, 1, 36)).toEqual({ parentId: 1, sortOrder: 2 })
  })

  it("拖拽：不能把自己的子页当成父页（防环）", () => {
    const rows = flattenVisible(tree, new Set([1]))
    expect(projectDrop(rows, 1, 2, 18)).toBeNull()
    expect(projectDrop(rows, 1, 2, 0)).toBeNull()
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

  it("拖拽取值：落点只用事件上的累计位移，不读外部状态", () => {
    const rows = flattenVisible(tree, new Set([1]))
    // 右拖 18px：嵌到悬停行下面
    expect(
      dropFromDragEnd(rows, {
        active: { id: 4 },
        over: { id: 1 },
        delta: { x: 18 }
      })
    ).toEqual({ parentId: 1, sortOrder: 2 })
    // 没横拖：保持同级
    expect(
      dropFromDragEnd(rows, {
        active: { id: 4 },
        over: { id: 1 },
        delta: { x: 0 }
      })
    ).toEqual({ parentId: null, sortOrder: 0 })
    // 没落在任何行上：不移动
    expect(
      dropFromDragEnd(rows, { active: { id: 4 }, over: null, delta: { x: 18 } })
    ).toBeNull()
  })

  it("落点预览：嵌进已有子页的页面时，线画在它最后一个子页之后", () => {
    const rows = flattenVisible(tree, new Set([1]))
    const target = projectDrop(rows, 4, 1, 18)
    expect(dropPreview(rows, 4, target)).toEqual({ depth: 1, afterId: 3 })
  })

  it("落点预览：目标页还没有子页时，线画在目标页之后并缩进一层", () => {
    const rows = flattenVisible(tree, new Set())
    const target = projectDrop(rows, 1, 4, 18)
    expect(dropPreview(rows, 1, target)).toEqual({ depth: 1, afterId: 4 })
  })

  it("落点预览：同级往前拖时线画在目标行之前，层级就是该层", () => {
    const rows = flattenVisible(tree, new Set([1]))
    const target = projectDrop(rows, 5, 3, 0)
    expect(dropPreview(rows, 5, target)).toEqual({ depth: 1, beforeId: 3 })
  })

  it("落点预览：没有落点（拖到自己身上 / 自己子树内）时不出线", () => {
    const rows = flattenVisible(tree, new Set([1]))
    expect(dropPreview(rows, 1, projectDrop(rows, 1, 1, 18))).toBeNull()
    expect(dropPreview(rows, 1, projectDrop(rows, 1, 2, 18))).toBeNull()
  })

  it("同级 sortOrder 不连续或重名时提示需要重排", () => {
    expect(needsRenumber([node(9, "P", 0), node(10, "Q", 1)])).toBe(false)
    expect(needsRenumber([node(9, "P", 0), node(10, "Q", 5)])).toBe(true)
  })
})
