import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core"
import { ResizableNodeView } from "@tiptap/core"
import type { NodeView } from "@tiptap/pm/view"

/** 规格下限：拖动不会把图片压到 48px 以下。 */
export const MIN_IMAGE_WIDTH = 48

/**
 * 宽度口径：JSON 属性、生成的 HTML、行内样式三处只认这一份。
 * 只接受正整数像素；`"50%"`、小数、0、空值一律当作「没有宽度」，
 * 渲染回自然尺寸（上限正文宽），不猜用户意图。
 */
export function imageWidth(attrs: Record<string, unknown>): number | null {
  const raw = attrs.width
  const value =
    typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : raw
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  const width = Math.round(value)
  return width > 0 ? width : null
}

/** 节点属性 → <img>：撤销、外部更新与首次渲染共用同一条同步路径。 */
function syncImageAttributes(
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
  img.style.width = width === null ? "" : `${width}px`
  // 高度恒自动：拖动过程由 ResizableNodeView 临时写行内像素，松手必须收回。
  // 否则窄屏下宽度被 max-width:100% 夹小、高度还是旧像素值，图会被压扁。
  img.style.height = ""
}

/**
 * 图片节点视图。阅读态与「未转存」占位沿用 React 视图（ImageBlock）；
 * 编辑态的正常图片交给 @tiptap/core 的 ResizableNodeView——官方 Image 的
 * resize 选项内部用的就是同一个类，拖拽、比例锁、最小宽度都由依赖负责。
 *
 * 为什么不直接开官方 resize 选项：它自带的 node view 会顶掉 React 视图（未转存
 * 占位必须留 React），而且松手时把 width 与 height 一起写回节点、以行内像素高度
 * 渲染，窄屏会压扁图片。这里只补 DOM 外壳与「只存宽度」的落库口径。
 */
export function createImageNodeView(
  props: NodeViewRendererProps,
  reactView: NodeViewRenderer
): NodeView {
  // 阅读态（含版本预览）：按已存宽度渲染，不出任何手柄
  if (!props.editor.isEditable) return reactView(props)

  const src =
    typeof props.node.attrs.src === "string" ? props.node.attrs.src : ""
  // 编辑态的未转存占位：React 视图 + 换成真图后的重建信号
  if (!src) return placeholderNodeView(props, reactView)

  return resizableImageNodeView(props)
}

/**
 * 未转存占位被「上传替换 / 插件补抓」换成真图后必须重建节点视图，否则这一轮
 * 编辑里图片拿不到缩放手柄；update 返回 false 就是 ProseMirror 的重建信号。
 */
function placeholderNodeView(
  props: NodeViewRendererProps,
  reactView: NodeViewRenderer
): NodeView {
  const view = reactView(props)
  const update = view.update?.bind(view)
  view.update = (node, decorations, innerDecorations) => {
    if (node.attrs.src) return false
    return update ? update(node, decorations, innerDecorations) : true
  }
  return view
}

function resizableImageNodeView(props: NodeViewRendererProps): NodeView {
  const { node, editor, getPos } = props
  const img = document.createElement("img")

  const resizable = new ResizableNodeView({
    element: img,
    editor,
    node,
    getPos,
    // 拖动过程只做实时预览：宽高都写行内像素，松手再统一收口
    onResize: (width, height) => {
      img.style.width = `${width}px`
      img.style.height = `${height}px`
    },
    // 一次事务 = 一次可撤销的编辑；高度不落库（恒自动），顺手清掉遗留 height
    onCommit: (width) => {
      img.style.height = ""
      const pos = getPos()
      if (typeof pos !== "number") return
      editor
        .chain()
        .setNodeSelection(pos)
        .updateAttributes("image", { width: Math.round(width), height: null })
        .run()
    },
    onUpdate: (next) => {
      syncImageAttributes(img, next.attrs)
      return true
    },
    options: {
      directions: ["bottom-right"],
      min: { width: MIN_IMAGE_WIDTH },
      preserveAspectRatio: true,
      className: { container: "image-resize" }
    }
  })

  syncImageAttributes(img, node.attrs)
  // 依赖给容器写死 display:flex：flex 容器下 wrapper 会撑到正文列宽，手柄就贴到
  // 列右缘而不是图片右下角。块级排布交给 wrapper 的 fit-content 收口（见 index.css）。
  resizable.container.style.display = "block"

  const figure = document.createElement("figure")
  figure.className = "my-4"
  figure.dataset.imageBlock = ""
  figure.appendChild(resizable.container)

  return {
    dom: figure,
    update: (next, decorations, innerDecorations) =>
      resizable.update(next, decorations, innerDecorations),
    destroy: () => resizable.destroy()
  }
}
