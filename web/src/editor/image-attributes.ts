/**
 * 图片宽度的属性口径：节点属性、生成的 HTML、编辑态行内样式三处只认这一份。
 *
 * 只接受正整数像素；`"50%"`、布尔、小数串、0、空值一律当作「没有宽度」，
 * 渲染回自然尺寸（上限正文宽），不猜用户意图。worker 侧的 JSON→HTML
 * （worker/src/lib/tiptap-html.ts 的 ImportImage）用的是同一条规则。
 */
export function imageWidth(attrs: Record<string, unknown>): number | null {
  const raw = attrs.width
  const value =
    typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : raw
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  const width = Math.round(value)
  return width > 0 ? width : null
}

/** 规格下限：拖动不会把图片压到 48px 以下。 */
export const MIN_IMAGE_WIDTH = 48

/** 节点属性 → <img>：首次挂载、撤销、外部更新共用同一条同步路径。 */
export function syncImageAttributes(
  img: HTMLImageElement,
  attrs: Record<string, unknown>
) {
  const src = typeof attrs.src === "string" ? attrs.src : ""
  if (src) {
    if (img.getAttribute("src") !== src) img.src = src
  } else if (img.hasAttribute("src")) {
    img.removeAttribute("src")
  }

  const alt = typeof attrs.alt === "string" ? attrs.alt : ""
  if (alt) img.alt = alt
  else img.removeAttribute("alt")

  const title = typeof attrs.title === "string" ? attrs.title : ""
  if (title) img.title = title
  else img.removeAttribute("title")

  const width = imageWidth(attrs)
  // 行内样式管渲染，HTML 属性与阅读态/服务端输出对齐（同一口径、同一数值）
  if (width === null) {
    img.style.width = ""
    img.removeAttribute("width")
  } else {
    img.style.width = `${width}px`
    img.setAttribute("width", String(width))
  }
  // 高度恒自动：拖动过程里 ResizableNodeView 会临时写行内像素，松手必须收回。
  // 否则窄屏下宽度被 max-width:100% 夹小、高度还是旧像素值，图会被压扁。
  img.style.height = ""
}
