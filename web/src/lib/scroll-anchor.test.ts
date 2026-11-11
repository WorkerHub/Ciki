import { describe, expect, it } from "vitest"
import {
  captureScrollAnchor,
  readScrollAnchor,
  rememberScrollAnchor,
  restoreScrollAnchor,
  takeScrollAnchor
} from "@/lib/scroll-anchor"
import { box } from "@/test/scroll-layout"

/**
 * jsdom 没有布局：每个块的位置由用例直接给（不用 scroll-layout 的随滚动桩，
 * 这里要固定几何验算式本身）。容器顶边在 0、视口高 600，判定线 = 0 + 24。
 */
function makeScene(tops: number[], scrollTop = 0) {
  const scroller = document.createElement("div")
  scroller.style.overflowY = "auto"
  scroller.getBoundingClientRect = () => box(0, 600)
  scroller.scrollTop = scrollTop

  const root = document.createElement("div")
  root.className = "wiki-content"
  for (const top of tops) {
    const block = document.createElement("p")
    block.getBoundingClientRect = () => box(top, 100)
    root.appendChild(block)
  }
  scroller.appendChild(root)
  document.body.appendChild(scroller)
  return { scroller, root }
}

describe("捕获阅读位置", () => {
  it("取判定线上最近的块，并记下块内比例", () => {
    // 判定线 24：第 0 块（顶 -400）与第 1 块（顶 -50）都在线以上，第 2 块（顶 200）在线下
    const { root } = makeScene([-400, -50, 200], 400)

    expect(captureScrollAnchor(root)).toEqual({
      blockIndex: 1,
      ratio: 0.74
    })
  })

  it("没滚动（短文）时不记位置", () => {
    const { root } = makeScene([-400, -50, 200], 0)

    expect(captureScrollAnchor(root)).toBeNull()
  })

  it("正文不在文档里时不当真：不记位置", () => {
    const root = document.createElement("div")
    const block = document.createElement("p")
    block.getBoundingClientRect = () => box(0, 100)
    root.appendChild(block)

    expect(captureScrollAnchor(root)).toBeNull()
  })

  it("找不到滚动容器时不记位置", () => {
    const root = document.createElement("div")
    const block = document.createElement("p")
    block.getBoundingClientRect = () => box(0, 100)
    root.appendChild(block)
    document.body.appendChild(root)

    expect(captureScrollAnchor(root)).toBeNull()
  })

  it("滚到文末时锚在最后一块上", () => {
    const { root } = makeScene([-800, -500, -200], 900)

    expect(captureScrollAnchor(root)).toEqual({ blockIndex: 2, ratio: 1 })
  })
})

describe("恢复到阅读位置", () => {
  it("把同一块按块内比例送回判定线", () => {
    const { scroller, root } = makeScene([-400, -50, 200], 400)

    expect(restoreScrollAnchor(root, { blockIndex: 1, ratio: 0.5 })).toBe(true)
    // 块顶 -50 + 0.5 × 100 = 0，判定线 24 → 往回滚 24
    expect(scroller.scrollTop).toBe(376)
  })

  it("inset 让落点压到固定层（吸顶工具条）下面", () => {
    const { scroller, root } = makeScene([-400, -50, 200], 400)

    expect(restoreScrollAnchor(root, { blockIndex: 1, ratio: 0.5 }, 60)).toBe(
      true
    )
    // 判定线 24 + 60 = 84 → 往回滚 84
    expect(scroller.scrollTop).toBe(316)
  })

  it("块序号越界时不滚动、返回 false（回退顶部，不报错）", () => {
    const { scroller, root } = makeScene([-400, -50, 200], 400)

    expect(restoreScrollAnchor(root, { blockIndex: 9, ratio: 0.5 })).toBe(false)
    expect(scroller.scrollTop).toBe(400)
  })

  it("没有滚动容器时不滚动、返回 false", () => {
    const root = document.createElement("div")
    const block = document.createElement("p")
    block.getBoundingClientRect = () => box(0, 100)
    root.appendChild(block)
    document.body.appendChild(root)

    expect(restoreScrollAnchor(root, { blockIndex: 0, ratio: 0 })).toBe(false)
  })
})

describe("位置锚的存取", () => {
  it("按 pageId 存取：换页读不到，读完即删", () => {
    rememberScrollAnchor(1, { blockIndex: 2, ratio: 0.5 })

    expect(readScrollAnchor(1)).toEqual({ blockIndex: 2, ratio: 0.5 })
    expect(readScrollAnchor(2)).toBeNull()
    expect(takeScrollAnchor(1)).toEqual({ blockIndex: 2, ratio: 0.5 })
    expect(readScrollAnchor(1)).toBeNull()
  })

  it("记 null 等于清掉这一页的位置", () => {
    rememberScrollAnchor(1, { blockIndex: 2, ratio: 0.5 })
    rememberScrollAnchor(1, null)

    expect(readScrollAnchor(1)).toBeNull()
  })

  it("脏数据当作没有，不抛错", () => {
    sessionStorage.setItem("ciki-scroll-anchor", "not json")

    expect(readScrollAnchor(1)).toBeNull()
  })
})
