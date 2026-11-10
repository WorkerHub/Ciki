import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight"
import Image from "@tiptap/extension-image"
import Link from "@tiptap/extension-link"
import Placeholder from "@tiptap/extension-placeholder"
import { Table } from "@tiptap/extension-table"
import TableRow from "@tiptap/extension-table-row"
import TaskItem from "@tiptap/extension-task-item"
import TaskList from "@tiptap/extension-task-list"
import Underline from "@tiptap/extension-underline"
import { ReactNodeViewRenderer } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { common, createLowlight } from "lowlight"
import { CodeBlockView } from "@/editor/CodeBlockView"
import {
  WikiColor,
  WikiHighlight,
  WikiTableCell,
  WikiTableHeader,
  WikiTextStyle
} from "@/editor/colors/extensions"
import { ImageBlock } from "@/editor/ImageBlock"
import { createImageNodeView, imageWidth } from "@/editor/image-view"

/** lowlight 只在模块加载时建一次；common 覆盖了 Confluence 里常见语言。 */
export const lowlight = createLowlight(common)

export type EditorMode = "edit" | "read"

/** NodeView 里的按钮/下拉不该被编辑器抢走事件。 */
function stopForInteractive({ event }: { event: Event }): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest("button, input, a, select, [data-code-header]"))
}

/** 代码块：语言角标 + 复制按钮，编辑态与阅读态共用同一个 NodeView。 */
export const WikiCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView, {
      stopEvent: stopForInteractive
    })
  }
})

/** 未转存占位的 React 视图：阅读态与编辑态共用，模块里只建一次。 */
const placeholderImageView = ReactNodeViewRenderer(ImageBlock, {
  stopEvent: stopForInteractive
})

/**
 * 图片：额外两个属性承载「未转存」标记（与契约 §三 图片白名单同名），
 * 这样 contentHtml 读进来后能恢复成占位，而不是变成一个空图。
 *
 * width 是 @tiptap/extension-image 基类已声明的属性（不加 schema、不迁移），
 * 这里只把口径收紧成「正整数像素」，见 image-view.ts 的 imageWidth。
 */
export const WikiImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      originalSrc: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-original-src"),
        renderHTML: (attributes) =>
          attributes.originalSrc
            ? { "data-original-src": attributes.originalSrc }
            : {}
      },
      confluenceImg: {
        default: false,
        parseHTML: (element) => element.hasAttribute("data-confluence-img"),
        renderHTML: (attributes) =>
          attributes.confluenceImg ? { "data-confluence-img": "true" } : {}
      },
      // 宽度只认裸整数像素：粘进来的 width="50%" 直接丢弃，回退自然尺寸
      width: {
        default: null,
        parseHTML: (element) => {
          const raw = element.getAttribute("width")?.trim() ?? ""
          return /^\d+$/.test(raw) ? Number(raw) : null
        },
        renderHTML: (attributes) => {
          const width = imageWidth(attributes)
          return width === null ? {} : { width: String(width) }
        }
      }
    }
  },
  addNodeView() {
    return (props) => createImageNodeView(props, placeholderImageView)
  },
  // 未转存的图片没有 src（只有 data-original-src），默认的 img[src] 规则会把它丢掉。
  parseHTML() {
    return [...(this.parent?.() ?? []), { tag: "img[data-original-src]" }]
  }
})

/**
 * 一套扩展供编辑态与阅读态共用（规格 §4：编辑态阅读态一致）。
 * 差异只有三处：只读时不挂 Placeholder、链接可点、表格不给列宽拖拽手柄。
 */
export function createExtensions(mode: EditorMode) {
  const isEdit = mode === "edit"
  return [
    StarterKit.configure({
      codeBlock: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] }
    }),
    WikiCodeBlock.configure({
      lowlight,
      defaultLanguage: null,
      languageClassPrefix: "language-"
    }),
    Underline,
    Link.configure({
      openOnClick: !isEdit,
      autolink: true,
      HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" }
    }),
    WikiImage.configure({ allowBase64: true, inline: false }),
    // 颜色三件套：文字颜色（TextStyle+Color）、高亮、单元格底色。
    // HTML 载具一律是 data 属性，详见 colors/extensions.ts 的说明。
    WikiTextStyle,
    WikiColor,
    WikiHighlight.configure({ multicolor: true }),
    Table.configure({
      resizable: isEdit,
      // 始终包一层 .tableWrapper：读态也要横向滚动，否则超宽表格会把正文挤变形
      renderWrapper: true,
      allowTableNodeSelection: true
    }),
    TableRow,
    WikiTableHeader,
    WikiTableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    ...(isEdit
      ? [
          Placeholder.configure({
            placeholder: "开始输入，或直接粘贴内容…",
            showOnlyWhenEditable: true
          })
        ]
      : [])
  ]
}
