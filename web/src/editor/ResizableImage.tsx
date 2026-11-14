import { ResizableNodeView } from "@tiptap/core"
import type { NodeViewProps } from "@tiptap/react"
import { useEffect, useRef } from "react"
import { MIN_IMAGE_WIDTH, syncImageAttributes } from "@/editor/image-attributes"

interface ResizableImageProps {
  node: NodeViewProps["node"]
  editor: NodeViewProps["editor"]
  getPos: NodeViewProps["getPos"]
  updateAttributes: NodeViewProps["updateAttributes"]
}

/**
 * 编辑态图片：拖着改宽、锁定宽高比、高自动。
 *
 * DOM 与拖拽全部交给 @tiptap/core 的 ResizableNodeView（官方 Image 的 `resize`
 * 选项内部用的就是同一个类：手柄、比例锁、最小宽度、提交回调都由它负责），
 * 这里只做三件事：把实例挂进节点视图、跟着节点属性同步、卸载时拆干净。
 *
 * 为什么不像官方那样直接开 `resize` 选项：它自己的 node view 会顶掉图片的 React
 * 节点视图（「未转存图片」占位卡片、上传替换必须留 React），而且松手时把 width
 * 和 height 一起写回节点、以行内像素高度渲染，窄屏会压扁图片。这里只存宽度。
 *
 * 为什么不按 src 切换两套 node view（占位走 React、图片走原生 + 缩放）：那样
 * 「上传替换」与它的撤销都必须在事务里销毁并重建 React 节点视图，行为取决于
 * ProseMirror 的重建路径；同一个节点视图内部换内容既不重建，也不会丢占位卡片
 * 的补抓状态。
 */
export function ResizableImage({
  node,
  editor,
  getPos,
  updateAttributes
}: ResizableImageProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  // 提交回调里要拿最新的节点/回调：实例只建一次，闭包不能定死在首次渲染
  const latest = useRef({ node, updateAttributes })
  latest.current = { node, updateAttributes }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const img = document.createElement("img")
    const view = new ResizableNodeView({
      element: img,
      editor,
      node: latest.current.node,
      getPos,
      // 拖动过程只做实时预览：只写宽度，高度交给 CSS 的 height:auto 按原比例算。
      // 若跟着写像素高，向右拖出正文列时宽度被 max-width:100% 卡住、高度还在长，
      // 预览会纵向拉伸变形（手柄也会跟着飞出图片）。
      onResize: (width) => {
        img.style.width = `${width}px`
        img.style.height = ""
      },
      // 一次事务 = 一次可撤销的编辑；高度不落库（恒自动），顺手清掉遗留 height
      onCommit: (width) => {
        latest.current.updateAttributes({
          width: Math.round(width),
          height: null
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

    syncImageAttributes(img, latest.current.node.attrs)
    // 依赖给容器写死 display:flex：flex 容器下 wrapper 会撑到正文列宽，手柄就贴到
    // 列右缘而不是图片右下角。块级排布交给 wrapper 的 fit-content 收口（见 index.css）。
    view.container.style.display = "block"
    host.appendChild(view.container)

    imageRef.current = img
    return () => {
      view.destroy()
      imageRef.current = null
    }
  }, [editor, getPos])

  // 节点属性变了（撤销、外部更新、提交后的回写）就同步回同一个 <img>
  useEffect(() => {
    const img = imageRef.current
    if (img) syncImageAttributes(img, node.attrs)
  }, [node.attrs])

  return <div ref={hostRef} className="contents" />
}
