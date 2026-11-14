import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight"
import Image from "@tiptap/extension-image"
import Placeholder from "@tiptap/extension-placeholder"
import { Table } from "@tiptap/extension-table"
import TableRow from "@tiptap/extension-table-row"
import TaskItem from "@tiptap/extension-task-item"
import TaskList from "@tiptap/extension-task-list"
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
import { imageWidth } from "@/editor/image-attributes"

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
  addAttributes() {
    return {
      ...this.parent?.(),
      /**
       * 折叠三态（契约见 docs/api-contract.md「代码块折叠」）：
       * true/false 是显式表态，null 为未表态（阅读页按「> 20 行」自动折叠）。
       * HTML 载具是 pre 上的 data-collapsed，只认小写 true/false；
       * 显式 false 必须输出——它与「未表态」在阅读页行为不同。
       */
      collapsed: {
        default: null,
        parseHTML: (element) => {
          const value = element.getAttribute("data-collapsed")
          if (value === "true") return true
          if (value === "false") return false
          return null
        },
        renderHTML: (attributes) => {
          if (attributes.collapsed === true) return { "data-collapsed": "true" }
          if (attributes.collapsed === false)
            return { "data-collapsed": "false" }
          return {}
        }
      }
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView, {
      stopEvent: stopForInteractive
    })
  }
})

/**
 * 图片：额外两个属性承载「未转存」标记（与契约 §三 图片白名单同名），
 * 这样 contentHtml 读进来后能恢复成占位，而不是变成一个空图。
 *
 * width 是 @tiptap/extension-image 基类已声明的属性（不加 schema、不迁移），
 * 这里只把口径收紧成「正整数像素」，见 image-attributes.ts 的 imageWidth。
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
    // 一个图片节点视图盖三种态：未转存占位、阅读态渲染、编辑态可缩放（见 ImageBlock）
    return ReactNodeViewRenderer(ImageBlock, { stopEvent: stopForInteractive })
  },
  // 未转存的图片没有 src（只有 data-original-src），默认的 img[src] 规则会把它丢掉。
  parseHTML() {
    return [...(this.parent?.() ?? []), { tag: "img[data-original-src]" }]
  }
})

/**
 * 一套扩展供编辑态与阅读态共用（规格 §4：编辑态阅读态一致）。
 * 差异只有三处：只读时不挂 Placeholder、链接可点、表格不给列宽拖拽手柄。
 * 空文档占位文案只在创建时取一次（编辑页内不热切换：切语言必离开编辑页、重新挂载）。
 */
export function createExtensions(mode: EditorMode, placeholder?: string) {
  const isEdit = mode === "edit"
  return [
    StarterKit.configure({
      codeBlock: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      // Link 与 Underline 自 TipTap 3 起由 StarterKit 内置，只能在这里配置；
      // 再单独注册同名扩展会触发 Duplicate extension names，且最终生效的配置不确定。
      link: {
        openOnClick: !isEdit,
        autolink: true,
        HTMLAttributes: {
          rel: "noopener noreferrer nofollow",
          target: "_blank"
        }
      }
    }),
    WikiCodeBlock.configure({
      lowlight,
      defaultLanguage: null,
      languageClassPrefix: "language-"
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
            placeholder: placeholder ?? "",
            showOnlyWhenEditable: true
          })
        ]
      : [])
  ]
}
