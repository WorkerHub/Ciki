import { ResizableNodeView } from "@tiptap/core"
import type { NodeViewProps } from "@tiptap/react"
import { useEffect, useRef } from "react"
import { MIN_IMAGE_WIDTH, imageWidth } from "@/editor/image-attributes"

/**
 * 空画布或未设宽度时预览图的保底渲染下限（宽高与图片块 resize 下限 MIN_IMAGE_WIDTH=48 对齐）。
 *
 * 为什么与 MIN_IMAGE_WIDTH 对齐而非更大值：
 * 1. 保证默认未设宽度时极小画布（如 20×20 空画布）具有基本的点击与悬停可交互面积；
 * 2. 避免 minWidth 高于 ResizableNodeView 的缩放下限，导致拖拽缩放时 offsetWidth 被 CSS 钳制在 120px，
 *    使画布预览在编辑态能够与图片块一致平滑缩放到 48px 规格下限。
 */
export const MIN_EXCALIDRAW_PREVIEW_WIDTH = MIN_IMAGE_WIDTH
export const MIN_EXCALIDRAW_PREVIEW_HEIGHT = MIN_IMAGE_WIDTH

interface ResizableExcalidrawProps {
  node: NodeViewProps["node"]
  editor: NodeViewProps["editor"]
  getPos: NodeViewProps["getPos"]
  updateAttributes: NodeViewProps["updateAttributes"]
  onDoubleClick?: () => void
}

/** 属性同步至 <img> 预览节点 */
export function syncExcalidrawAttributes(
  img: HTMLImageElement,
  attrs: Record<string, unknown>
) {
  const previewKey =
    typeof attrs.previewKey === "string" ? attrs.previewKey : ""
  const src = previewKey ? `/api/files/${previewKey}` : ""
  if (src) {
    if (img.getAttribute("src") !== src) img.src = src
  } else if (img.hasAttribute("src")) {
    img.removeAttribute("src")
  }

  const alt = typeof attrs.extractedText === "string" ? attrs.extractedText : ""
  if (alt) img.alt = alt
  else img.removeAttribute("alt")

  img.setAttribute("data-type", "excalidraw")
  if (typeof attrs.sceneKey === "string" && attrs.sceneKey) {
    img.setAttribute("data-scene-key", attrs.sceneKey)
  }
  if (previewKey) {
    img.setAttribute("data-preview-key", previewKey)
  }

  const width = imageWidth(attrs)
  if (width === null) {
    img.style.width = ""
    img.style.minWidth = `${MIN_EXCALIDRAW_PREVIEW_WIDTH}px`
    img.style.minHeight = `${MIN_EXCALIDRAW_PREVIEW_HEIGHT}px`
    img.removeAttribute("width")
  } else {
    img.style.width = `${width}px`
    img.style.minWidth = ""
    img.style.minHeight = ""
    img.setAttribute("width", String(width))
  }
  img.style.objectFit = "contain"
  img.style.height = ""
}

/**
 * 编辑态画布预览图：拖拽缩放手柄，锁定宽高比。
 * 行为与 ResizableImage 对齐，手柄与容器样式复用 .wiki-content [data-resize-wrapper]。
 */
export function ResizableExcalidraw({
  node,
  editor,
  getPos,
  updateAttributes,
  onDoubleClick
}: ResizableExcalidrawProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const latest = useRef({ node, updateAttributes, onDoubleClick })
  latest.current = { node, updateAttributes, onDoubleClick }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const img = document.createElement("img")
    img.ondblclick = () => latest.current.onDoubleClick?.()

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      if (typeof getPos === "function") {
        try {
          const pos = getPos()
          if (typeof pos === "number") {
            e.preventDefault()
            editor.commands.setNodeSelection(pos)
            editor.commands.focus()
          }
        } catch {
          // 节点可能已卸载
        }
      }
    }
    img.addEventListener("mousedown", onMouseDown)

    const view = new ResizableNodeView({
      element: img,
      editor,
      node: latest.current.node,
      getPos,
      onResize: (width) => {
        img.style.width = `${width}px`
        img.style.height = ""
      },
      onCommit: (width) => {
        latest.current.updateAttributes({
          width: Math.round(width)
        })
      },
      onUpdate: () => true,
      options: {
        directions: ["bottom-right"],
        min: { width: MIN_IMAGE_WIDTH },
        preserveAspectRatio: true,
        className: { container: "image-resize" }
      }
    })

    syncExcalidrawAttributes(img, latest.current.node.attrs)
    view.container.style.display = "block"
    host.appendChild(view.container)

    imageRef.current = img
    return () => {
      img.removeEventListener("mousedown", onMouseDown)
      view.destroy()
      imageRef.current = null
    }
  }, [editor, getPos])

  useEffect(() => {
    const img = imageRef.current
    if (img) syncExcalidrawAttributes(img, node.attrs)
  }, [node.attrs])

  return <div ref={hostRef} className="contents" />
}
