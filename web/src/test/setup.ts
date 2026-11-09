// jsdom 环境的测试公共准备：jest-dom 断言 + 每个用例后清理 DOM 与本地存储。
import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

afterEach(() => {
  cleanup()
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {
    /* jsdom 一定有 storage，这里只是兜底 */
  }
})

// jsdom 没有 ResizeObserver / scrollIntoView，Radix 的浮层与 dnd-kit 会用到。
if (typeof window !== "undefined") {
  if (!("ResizeObserver" in window)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      ResizeObserverStub
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {}
  }
  // 索引轨的滚动高亮用原生 IntersectionObserver；jsdom 没有，给个不回调的空桩。
  if (!("IntersectionObserver" in window)) {
    class IntersectionObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): IntersectionObserverEntry[] {
        return []
      }
    }
    ;(
      window as unknown as { IntersectionObserver: unknown }
    ).IntersectionObserver = IntersectionObserverStub
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {}
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia
  }
}
