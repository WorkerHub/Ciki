import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BackToTop } from "@/components/BackToTop"
import { i18n } from "@/i18n"

function createScroller({
  clientHeight = 600,
  scrollHeight = 2000,
  scrollTop = 0
}: {
  clientHeight?: number
  scrollHeight?: number
  scrollTop?: number
} = {}) {
  const scroller = document.createElement("div")
  scroller.style.overflowY = "auto"
  let currentScrollTop = scrollTop

  Object.defineProperty(scroller, "clientHeight", {
    value: clientHeight,
    writable: true,
    configurable: true
  })
  Object.defineProperty(scroller, "scrollHeight", {
    value: scrollHeight,
    writable: true,
    configurable: true
  })
  Object.defineProperty(scroller, "scrollTop", {
    get() {
      return currentScrollTop
    },
    set(v: number) {
      currentScrollTop = v
    },
    configurable: true
  })

  scroller.scrollTo = vi.fn(function (
    this: HTMLElement,
    options?: ScrollToOptions | number
  ) {
    if (typeof options === "object") {
      currentScrollTop = options.top ?? 0
    } else if (typeof options === "number") {
      currentScrollTop = options
    }
  })

  return scroller
}

describe("BackToTop 回到顶部组件", () => {
  let scroller: HTMLElement
  let content: HTMLElement

  beforeEach(async () => {
    await i18n.changeLanguage("zh")
  })

  afterEach(() => {
    if (scroller?.parentNode) {
      scroller.parentNode.removeChild(scroller)
    }
  })

  it("短页面（scrollHeight <= clientHeight）按钮永不出现", () => {
    scroller = createScroller({
      clientHeight: 600,
      scrollHeight: 500,
      scrollTop: 0
    })
    content = document.createElement("div")
    scroller.appendChild(content)
    document.body.appendChild(scroller)

    render(<BackToTop contentRoot={content} />)

    expect(
      screen.queryByRole("button", { name: "回到顶部" })
    ).not.toBeInTheDocument()

    // 即使发生滚动事件，短页面也不出现
    scroller.dispatchEvent(new Event("scroll"))
    expect(
      screen.queryByRole("button", { name: "回到顶部" })
    ).not.toBeInTheDocument()
  })

  it("长页面初始在顶部（scrollTop <= clientHeight）时不出现", () => {
    scroller = createScroller({
      clientHeight: 600,
      scrollHeight: 2000,
      scrollTop: 0
    })
    content = document.createElement("div")
    scroller.appendChild(content)
    document.body.appendChild(scroller)

    render(<BackToTop contentRoot={content} />)

    expect(
      screen.queryByRole("button", { name: "回到顶部" })
    ).not.toBeInTheDocument()
  })

  it("长页面下滑超过一屏（scrollTop > clientHeight）按钮淡入", async () => {
    scroller = createScroller({
      clientHeight: 600,
      scrollHeight: 2000,
      scrollTop: 0
    })
    content = document.createElement("div")
    scroller.appendChild(content)
    document.body.appendChild(scroller)

    render(<BackToTop contentRoot={content} />)

    expect(
      screen.queryByRole("button", { name: "回到顶部" })
    ).not.toBeInTheDocument()

    // 下滑超过一屏（601 > 600）
    scroller.scrollTop = 601
    scroller.dispatchEvent(new Event("scroll"))

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "回到顶部" })
      ).toBeInTheDocument()
    })
  })

  it("点击按钮平滑回顶，回顶后按钮消失", async () => {
    const user = userEvent.setup()
    scroller = createScroller({
      clientHeight: 600,
      scrollHeight: 2000,
      scrollTop: 800
    })
    content = document.createElement("div")
    scroller.appendChild(content)
    document.body.appendChild(scroller)

    render(<BackToTop contentRoot={content} />)

    const button = await screen.findByRole("button", { name: "回到顶部" })
    expect(button).toBeInTheDocument()

    await user.click(button)

    expect(scroller.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: "smooth"
    })

    // 回顶后触发 scroll 事件（scrollTop 已归零 <= clientHeight）
    scroller.dispatchEvent(new Event("scroll"))

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "回到顶部" })
      ).not.toBeInTheDocument()
    })
  })

  it("支持直接传入 scrollContainer 且向上回到阈值内淡出", async () => {
    scroller = createScroller({
      clientHeight: 600,
      scrollHeight: 2000,
      scrollTop: 700
    })
    document.body.appendChild(scroller)

    render(<BackToTop scrollContainer={scroller} />)

    expect(
      await screen.findByRole("button", { name: "回到顶部" })
    ).toBeInTheDocument()

    // 向上滑动回到一屏内（500 <= 600）
    scroller.scrollTop = 500
    scroller.dispatchEvent(new Event("scroll"))

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "回到顶部" })
      ).not.toBeInTheDocument()
    })
  })

  it("连续快速滚动时不卡顿、节流正常，状态最终稳定", async () => {
    scroller = createScroller({
      clientHeight: 600,
      scrollHeight: 2000,
      scrollTop: 0
    })
    document.body.appendChild(scroller)

    render(<BackToTop scrollContainer={scroller} />)

    // 连续高频派发 scroll 事件
    for (let i = 1; i <= 20; i++) {
      scroller.scrollTop = i * 50
      scroller.dispatchEvent(new Event("scroll"))
    }

    // 最终位置是 1000 > 600，按钮正常稳定显现
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "回到顶部" })
      ).toBeInTheDocument()
    })
  })

  it("支持英文环境 aria-label（Back to top）", async () => {
    await i18n.changeLanguage("en")
    scroller = createScroller({
      clientHeight: 600,
      scrollHeight: 2000,
      scrollTop: 700
    })
    document.body.appendChild(scroller)

    render(<BackToTop scrollContainer={scroller} />)

    expect(
      await screen.findByRole("button", { name: "Back to top" })
    ).toBeInTheDocument()
  })

  it("尊重 prefers-reduced-motion，减弱动画时采用 auto 平滑行为", async () => {
    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    }))

    try {
      const user = userEvent.setup()
      scroller = createScroller({
        clientHeight: 600,
        scrollHeight: 2000,
        scrollTop: 700
      })
      document.body.appendChild(scroller)

      render(<BackToTop scrollContainer={scroller} />)

      const button = await screen.findByRole("button", { name: "回到顶部" })
      await user.click(button)

      expect(scroller.scrollTo).toHaveBeenCalledWith({
        top: 0,
        behavior: "auto"
      })
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })

  it("样式包含 safe-area-inset 和尺寸类名", async () => {
    scroller = createScroller({
      clientHeight: 600,
      scrollHeight: 2000,
      scrollTop: 700
    })
    document.body.appendChild(scroller)

    render(<BackToTop scrollContainer={scroller} />)

    const button = await screen.findByRole("button", { name: "回到顶部" })
    expect(button.className).toContain("size-10")
    expect(button.className).toContain("rounded-full")
    expect(button.className).toContain("fixed")
    expect(button.className).toContain("safe-area-inset-bottom")
    expect(button.className).toContain("safe-area-inset-right")
  })
})
