/**
 * TipTap 在 jsdom 里跑起来需要一点垫片：jsdom 没有布局引擎，
 * Range/Element 的 getClientRects 与 getBoundingClientRect 默认不存在，
 * ProseMirror 初始化视图时会调用它们。只补缺失的方法，不改已有行为。
 */

function zeroRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    toJSON: () => ({})
  } as DOMRect
}

function emptyRectList(): DOMRectList {
  return {
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator]
  } as unknown as DOMRectList
}

export function installTiptapJsdomShims() {
  if (typeof Range !== "undefined") {
    if (!Range.prototype.getClientRects) {
      Range.prototype.getClientRects = () => emptyRectList()
    }
    if (!Range.prototype.getBoundingClientRect) {
      Range.prototype.getBoundingClientRect = zeroRect
    }
  }
  if (typeof HTMLElement !== "undefined") {
    if (!HTMLElement.prototype.getClientRects) {
      HTMLElement.prototype.getClientRects = () => emptyRectList()
    }
    if (!HTMLElement.prototype.getBoundingClientRect) {
      HTMLElement.prototype.getBoundingClientRect = zeroRect
    }
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = () => {}
    }
  }
  if (typeof document !== "undefined" && !document.elementFromPoint) {
    document.elementFromPoint = () => null
  }
}
