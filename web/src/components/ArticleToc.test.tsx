import { act, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ArticleToc } from "@/components/ArticleToc"
import type { TocItem } from "@/lib/toc"

const items: TocItem[] = [
  { id: "heading-1", level: 2, text: "部署" },
  { id: "heading-2", level: 3, text: "配置表" },
  { id: "heading-3", level: 2, text: "回滚" }
]

/** 只关心断点匹配：xl 以上为 true，以下为 false。 */
function mockViewport(wide: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: wide,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

function rect(top: number, height = 20): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    height,
    toJSON: () => ({})
  } as DOMRect
}

class FakeObserver {
  static instances: FakeObserver[] = []
  callback: IntersectionObserverCallback
  observed: Element[] = []
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    FakeObserver.instances.push(this)
  }
  observe(target: Element) {
    this.observed.push(target)
  }
  unobserve() {}
  disconnect() {
    this.observed = []
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  trigger() {
    this.callback([], this as unknown as IntersectionObserver)
  }
}

/** 造一个正文根元素：每个标题的位置由 tests 控制（jsdom 没有布局）。 */
function makeContent(tops: number[], list: TocItem[] = items): HTMLElement {
  const root = document.createElement("div")
  tops.forEach((top, index) => {
    const heading = document.createElement("h2")
    heading.id = list[index].id
    heading.textContent = list[index].text
    heading.getBoundingClientRect = () => rect(top)
    root.appendChild(heading)
  })
  return root
}

beforeEach(() => {
  FakeObserver.instances = []
  window.IntersectionObserver =
    FakeObserver as unknown as typeof IntersectionObserver
  // rAF 同步执行，观察器回调的结果在 act 里立刻可见
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0)
    return 1
  }) as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = () => {}
  mockViewport(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("阅读页右侧索引轨", () => {
  it("渲染无可见标题的 nav，每项是单行原生锚点", () => {
    render(<ArticleToc items={items} contentRoot={null} />)

    const nav = screen.getByRole("navigation", { name: "本页索引" })
    expect(nav).toBeInTheDocument()
    expect(screen.queryByText("目录")).toBeNull()

    const links = within(nav).getAllByRole("link")
    expect(links).toHaveLength(3)
    expect(links[0]).toHaveAttribute("href", "#heading-1")
    expect(links[0]).toHaveAttribute("title", "部署")
    expect(links[0].className).toContain("truncate")
    expect(links[0]).toHaveAttribute("aria-current", "location")
  })

  it("缩进以本文最浅层级为基准：2 级不缩进，3 级递进", () => {
    render(<ArticleToc items={items} contentRoot={null} />)

    const links = within(
      screen.getByRole("navigation", { name: "本页索引" })
    ).getAllByRole("link")
    expect(links[0].style.paddingInlineStart).toBe("8px")
    expect(links[1].style.paddingInlineStart).toBe("20px")
    expect(links[2].style.paddingInlineStart).toBe("8px")
  })

  it("少于 2 条或视口不到 1280px 时不渲染整轨", () => {
    const first = render(<ArticleToc items={[items[0]]} contentRoot={null} />)
    expect(screen.queryByRole("navigation")).toBeNull()
    first.unmount()

    render(<ArticleToc items={items} contentRoot={null} />)
    expect(screen.getByRole("navigation", { name: "本页索引" })).toBeTruthy()

    // 断点按挂载时读到的 matchMedia 决定：窄视口下重新进场就是整轨不渲染
    document.body.innerHTML = ""
    mockViewport(false)
    render(<ArticleToc items={items} contentRoot={null} />)
    expect(screen.queryByRole("navigation")).toBeNull()
  })

  it("滚动越过判定线时高亮切到对应小节", () => {
    const root = makeContent([-200, 100, 400])
    render(<ArticleToc items={items} contentRoot={root} />)

    const observer = FakeObserver.instances.at(-1)
    expect(observer?.observed).toHaveLength(3)

    act(() => observer?.trigger())
    expect(screen.getByRole("link", { name: "部署" })).toHaveAttribute(
      "aria-current",
      "location"
    )

    root.children[1].getBoundingClientRect = () => rect(10)
    act(() => observer?.trigger())
    expect(screen.getByRole("link", { name: "配置表" })).toHaveAttribute(
      "aria-current",
      "location"
    )
    expect(screen.getByRole("link", { name: "部署" })).not.toHaveAttribute(
      "aria-current"
    )
  })

  it("切到另一篇文章时高亮从第一项重新开始", () => {
    const first = makeContent([-200, 100, 400])
    const { rerender } = render(
      <ArticleToc items={items} contentRoot={first} />
    )
    const observer = FakeObserver.instances.at(-1)
    first.children[2].getBoundingClientRect = () => rect(10)
    act(() => observer?.trigger())
    expect(screen.getByRole("link", { name: "回滚" })).toHaveAttribute(
      "aria-current",
      "location"
    )

    // 新页位置式 id 与上一页同名：不重置的话 heading-3 会直接“继承”高亮
    const nextItems: TocItem[] = [
      { id: "heading-1", level: 2, text: "新页甲" },
      { id: "heading-2", level: 3, text: "新页乙" },
      { id: "heading-3", level: 2, text: "新页丙" }
    ]
    const next = makeContent([-200, 100, 400], nextItems)
    rerender(<ArticleToc items={nextItems} contentRoot={next} />)

    expect(screen.getByRole("link", { name: "新页甲" })).toHaveAttribute(
      "aria-current",
      "location"
    )
    expect(screen.getByRole("link", { name: "新页丙" })).not.toHaveAttribute(
      "aria-current"
    )
  })

  it("轨超高时只滚动轨自身，当前项保持可见", () => {
    const root = makeContent([-200, 10, 400])
    render(<ArticleToc items={items} contentRoot={root} />)
    const observer = FakeObserver.instances.at(-1)
    const nav = screen.getByRole("navigation", { name: "本页索引" })
    Object.defineProperty(nav, "clientHeight", {
      value: 40,
      configurable: true
    })
    const active = screen.getByRole("link", { name: "配置表" })
    Object.defineProperty(active, "offsetTop", {
      value: 200,
      configurable: true
    })
    Object.defineProperty(active, "offsetHeight", {
      value: 20,
      configurable: true
    })

    act(() => observer?.trigger())

    expect(nav.scrollTop).toBe(180)
  })
})
