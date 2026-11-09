import type { ReactNode } from "react"

/**
 * jsdom 没有布局：给「滚动容器 + .wiki-content 正文块」装一套可量的几何。
 *
 * 块的几何跟着最近滚动容器当前的 scrollTop 走（第 i 块顶 = i × blockHeight −
 * scrollTop），滚动容器自身视口高 viewportHeight、顶边在 0——与真实浏览器里
 * 「主区滚动容器 + 正文」的关系一致，捕获/恢复读到的相对位置才是真的。
 *
 * 因为要覆盖渲染期就产生的元素，桩装在 HTMLElement 原型上，必须在 render 之前安装。
 */
export function installScrollLayout(
  options: { blockHeight?: number; viewportHeight?: number } = {}
): { restore: () => void } {
  const blockHeight = options.blockHeight ?? 100
  const viewportHeight = options.viewportHeight ?? 600
  const original = HTMLElement.prototype.getBoundingClientRect

  HTMLElement.prototype.getBoundingClientRect = function (
    this: HTMLElement
  ): DOMRect {
    if (isScrollBox(this)) return box(0, viewportHeight)
    const parent = this.parentElement
    if (parent?.classList.contains("wiki-content")) {
      const index = Array.from(parent.children).indexOf(this)
      return box(index * blockHeight - scrollTopOf(this), blockHeight)
    }
    return box(0, 0)
  }

  return {
    restore: () => {
      HTMLElement.prototype.getBoundingClientRect = original
    }
  }
}

/** 测试用的滚动容器：内联 overflow-y 既是最小实现，也让 getComputedStyle 认得出。 */
export function ScrollHost({ children }: { children: ReactNode }) {
  return (
    <div data-testid="scroller" style={{ overflowY: "auto" }}>
      {children}
    </div>
  )
}

export function box(top: number, height: number): DOMRect {
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

function isScrollBox(element: HTMLElement): boolean {
  const overflowY = element.style.overflowY
  return overflowY === "auto" || overflowY === "scroll"
}

function scrollTopOf(element: HTMLElement): number {
  let current = element.parentElement
  while (current) {
    if (isScrollBox(current)) return current.scrollTop
    current = current.parentElement
  }
  return 0
}
