import { ResizableNodeView } from "@tiptap/core"
import type { NodeViewProps } from "@tiptap/react"
import { useEffect, useRef } from "react"
import { MIN_IMAGE_WIDTH, imageWidth } from "@/editor/image-attributes"

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
    img.removeAttribute("width")
  } else {
    img.style.width = `${width}px`
    img.setAttribute("width", String(width))
  }
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
  const latest = useRef({ node, updateAttributes })
  latest.current = { node, updateAttributes }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const img = document.createElement("img")
    if (onDoubleClick) {
      img.ondblclick = onDoubleClick
    }

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
      view.destroy()
      imageRef.current = null
    }
  }, [editor, getPos, onDoubleClick])

  useEffect(() => {
    const img = imageRef.current
    if (img) syncExcalidrawAttributes(img, node.attrs)
  }, [node.attrs])

  return <div ref={hostRef} className="contents" />
}
