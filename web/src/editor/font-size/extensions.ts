/**
 * 行内字号扩展 —— 编辑态与阅读态共用这一套。
 *
 * 约定：字号在 HTML 里一律走 data 载具（`span[data-font-size]`），
 * 值严格限定为 7 档固定刻度（`12px`、`14px`、`16px`、`18px`、`20px`、`24px`、`32px`）。
 * 入库消毒会剥除 style，保留 data-font-size；浏览器渲染时输出内联样式以保证视觉一致。
 */
import {
  type Attributes,
  type GlobalAttributes,
  getStyleProperty
} from "@tiptap/core"
import { FontSize } from "@tiptap/extension-text-style"
import { normalizeFontSize } from "@/lib/font-size"

export const WikiFontSize = FontSize.extend({
  addGlobalAttributes() {
    const groups = (this.parent?.() ?? []) as GlobalAttributes
    return groups.map((group) => {
      if (!group.types.includes("textStyle")) return group
      return {
        ...group,
        attributes: {
          ...group.attributes,
          fontSize: {
            ...group.attributes.fontSize,
            default: null,
            parseHTML: (element: HTMLElement) =>
              normalizeFontSize(element.getAttribute("data-font-size")) ??
              normalizeFontSize(
                getStyleProperty(element, "font-size") ?? element.style.fontSize
              ),
            renderHTML: (attributes: Attributes) => {
              const size = normalizeFontSize(
                attributes.fontSize as string | null
              )
              if (!size) return {}
              return { "data-font-size": size, style: `font-size: ${size}` }
            }
          }
        }
      }
    })
  },

  addCommands() {
    return {
      ...this.parent?.(),
      setFontSize:
        (fontSize: string) =>
        ({ chain }) => {
          const normalized = normalizeFontSize(fontSize)
          if (!normalized) {
            return chain()
              .setMark("textStyle", { fontSize: null })
              .removeEmptyTextStyle()
              .run()
          }
          return chain().setMark("textStyle", { fontSize: normalized }).run()
        },
      unsetFontSize:
        () =>
        ({ chain }) => {
          return chain()
            .setMark("textStyle", { fontSize: null })
            .removeEmptyTextStyle()
            .run()
        }
    }
  }
})
