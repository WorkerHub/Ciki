// jsdom 环境的测试公共准备：jest-dom 断言 + 每个用例后清理 DOM 与本地存储。
import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach, beforeEach } from "vitest"
import { i18n } from "@/i18n"

// 默认测试语言固定 zh：现有用例大量断言中文原文，而 jsdom 的
// navigator.language 是 en-US，不钉死会让它们整体变红（规格 §3）。
beforeEach(async () => {
  await i18n.changeLanguage("zh")
})

afterEach(async () => {
  cleanup()
  // 个别用例会切到 en 验证英文文案；这里复位，别把语言留给下一个用例。
  await i18n.changeLanguage("zh")
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
  if (typeof HTMLCanvasElement !== "undefined") {
    HTMLCanvasElement.prototype.getContext = (() => ({
      filter: "none",
      fillRect: () => {},
      clearRect: () => {},
      getImageData: () => ({ data: new Array(4) }),
      putImageData: () => {},
      createImageData: () => ({ data: new Array(4) }),
      setTransform: () => {},
      drawImage: () => {},
      save: () => {},
      fillText: () => {},
      restore: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      stroke: () => {},
      translate: () => {},
      scale: () => {},
      rotate: () => {},
      arc: () => {},
      fill: () => {},
      measureText: () => ({ width: 0 }),
      transform: () => {},
      rect: () => {},
      clip: () => {}
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.toBlob = (callback, type = "image/png") => {
      const blob = new Blob(["mock-image-bytes"], { type })
      callback(blob)
    }
  }
  if (!("Path2D" in globalThis)) {
    class Path2DStub {
      addPath() {}
      closePath() {}
      moveTo() {}
      lineTo() {}
      bezierCurveTo() {}
      quadraticCurveTo() {}
      arc() {}
      arcTo() {}
      ellipse() {}
      rect() {}
    }
    ;(globalThis as unknown as { Path2D: unknown }).Path2D = Path2DStub
    if (typeof window !== "undefined") {
      ;(window as unknown as { Path2D: unknown }).Path2D = Path2DStub
    }
  }
  if (!("FontFace" in globalThis)) {
    class FontFaceStub {
      family: string
      source: string | ArrayBuffer
      descriptors?: unknown
      status = "loaded"
      unicodeRange = "U+0-10ffff"
      constructor(
        family: string,
        source: string | ArrayBuffer,
        descriptors?: { unicodeRange?: string }
      ) {
        this.family = family
        this.source = source
        this.descriptors = descriptors
        if (descriptors?.unicodeRange) {
          this.unicodeRange = descriptors.unicodeRange
        }
      }
      async load() {
        return this
      }
    }
    ;(globalThis as unknown as { FontFace: unknown }).FontFace = FontFaceStub
    if (typeof window !== "undefined") {
      ;(window as unknown as { FontFace: unknown }).FontFace = FontFaceStub
    }
  }
  if (
    typeof document !== "undefined" &&
    !(document as unknown as { fonts?: unknown }).fonts
  ) {
    const fontSet = new Set()
    ;(document as unknown as { fonts: unknown }).fonts = {
      has: (f: unknown) => fontSet.has(f),
      add: (f: unknown) => fontSet.add(f),
      delete: (f: unknown) => fontSet.delete(f),
      clear: () => fontSet.clear(),
      check: () => true,
      load: async () => [],
      ready: Promise.resolve()
    }
  }
}
