import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight"
import { isNodeSelection } from "@tiptap/core"
import Image from "@tiptap/extension-image"
import Placeholder from "@tiptap/extension-placeholder"
import { Table, createTable } from "@tiptap/extension-table"
import TableRow from "@tiptap/extension-table-row"
import TaskItem from "@tiptap/extension-task-item"
import TaskList from "@tiptap/extension-task-list"
import { TextSelection } from "@tiptap/pm/state"
import { ReactNodeViewRenderer } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { insertBlockAfterNodeSelection } from "@/editor/block-insert"
import { CodeBlockView } from "@/editor/CodeBlockView"
import {
  WikiColor,
  WikiHighlight,
  WikiJointColorAdaptation,
  WikiTableCell,
  WikiTableHeader,
  WikiTextStyle
} from "@/editor/colors/extensions"
import { WikiExcalidraw } from "@/editor/excalidraw/extension"
import { WikiHtmlEmbed } from "@/editor/htmlEmbed/extension"
import { WikiFontSize } from "@/editor/font-size/extensions"
import { ImageBlock } from "@/editor/ImageBlock"
import { imageWidth } from "@/editor/image-attributes"
import { lowlight } from "@/editor/lowlight"
import { WikiLowlightPlugin } from "@/editor/lowlight-plugin"

export { lowlight }

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
  },
  addProseMirrorPlugins() {
    return [
      WikiLowlightPlugin({
        name: this.name,
        lowlight: this.options.lowlight,
        defaultLanguage: this.options.defaultLanguage
      })
    ]
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
  addCommands() {
    return {
      ...this.parent?.(),
      setImage: (options) => (props) => {
        return insertBlockAfterNodeSelection(props, {
          type: this.name,
          attrs: options
        })
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
 * 表格：在 NodeSelection 下插入表格时插在被选中块节点之后，防止覆盖现有块节点。
 */
const WikiTable = Table.extend({
  addCommands() {
    return {
      ...this.parent?.(),
      insertTable:
        ({ rows = 3, cols = 3, withHeaderRow = true } = {}) =>
        ({ tr, dispatch, editor }) => {
          const node = createTable(editor.schema, rows, cols, withHeaderRow)

          if (dispatch) {
            if (isNodeSelection(tr.selection)) {
              const insertPos = tr.selection.to
              tr.insert(insertPos, node)
                .scrollIntoView()
                .setSelection(TextSelection.near(tr.doc.resolve(insertPos + 1)))
            } else {
              const offset = tr.selection.from + 1
              tr.replaceSelectionWith(node)
                .scrollIntoView()
                .setSelection(TextSelection.near(tr.doc.resolve(offset)))
            }
          }

          return true
        }
    }
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
      },
      dropcursor: isEdit ? undefined : false,
      gapcursor: isEdit ? undefined : false,
      undoRedo: isEdit ? undefined : false,
      trailingNode: isEdit ? undefined : false
    }),
    WikiCodeBlock.configure({
      lowlight,
      defaultLanguage: null,
      languageClassPrefix: "language-"
    }),
    WikiImage.configure({ allowBase64: true, inline: false }),
    WikiExcalidraw,
    WikiHtmlEmbed,
    // 颜色与行内字号：文字样式（TextStyle + Color + FontSize）、高亮、单元格底色。
    // HTML 载具一律是 data 属性，详见 colors 与 font-size 扩展说明。
    WikiTextStyle,
    WikiColor,
    WikiFontSize,
    WikiHighlight.configure({ multicolor: true }),
    WikiJointColorAdaptation,
    WikiTable.configure({
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

export { WikiExcalidraw, WikiHtmlEmbed, WikiTable }
