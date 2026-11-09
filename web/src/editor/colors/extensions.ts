/**
 * 颜色能力（文字颜色 / 高亮 / 单元格背景）的扩展覆盖 —— 编辑态与阅读态共用这一套。
 *
 * 约定：颜色在 HTML 里一律走 data 载具（`data-text-color` / `data-color` / `data-cell-bg`），
 * 值只认 `#rrggbb`。原因见 docs/api-contract.md「服务端消毒规则」：落库前的服务端消毒
 * 只认这套 data 载具、`style` 一律剥掉（插件导入路径首当其冲），只有普通属性三路一致。
 * 浏览器里仍然输出内联样式（`renderHTML` 同时给 data 属性与 style），所以编辑与阅读的
 * 观感就是 TipTap 原生的样子；落库前消毒层把 style 剥掉、留下 data 属性。
 */
import type { Attributes, GlobalAttributes } from "@tiptap/core"
import Color from "@tiptap/extension-color"
import Highlight from "@tiptap/extension-highlight"
import TableCell from "@tiptap/extension-table-cell"
import TableHeader from "@tiptap/extension-table-header"
import { TextStyle } from "@tiptap/extension-text-style"
import { normalizeColor } from "@/lib/color"

/**
 * 文字颜色：TextStyle 的原生规则只认「带 style 的 span」，所以额外加一条
 * `span[data-text-color]`——入库 HTML 里颜色只存在 data 属性上。
 */
export const WikiTextStyle = TextStyle.extend({
  parseHTML() {
    return [
      { tag: "span[data-text-color]", getAttrs: () => ({}) },
      ...(this.parent?.() ?? [])
    ]
  }
})

/**
 * 颜色 mark（TextStyle + Color）：解析时先读 data 载具，再退回内联样式
 * （浏览器把 hex 序列化成 rgb()，统一归一回 `#rrggbb`），渲染时两者都给。
 */
export const WikiColor = Color.extend({
  addGlobalAttributes() {
    const groups = (this.parent?.() ?? []) as GlobalAttributes
    return groups.map((group) => {
      if (!group.types.includes("textStyle")) return group
      return {
        ...group,
        attributes: {
          ...group.attributes,
          color: {
            ...group.attributes.color,
            parseHTML: (element: HTMLElement) =>
              normalizeColor(element.getAttribute("data-text-color")) ??
              normalizeColor(element.style.color),
            renderHTML: (attributes: Attributes) => {
              const color = attributes.color as string | null
              if (!color) return {}
              return { "data-text-color": color, style: `color: ${color}` }
            }
          }
        }
      }
    })
  }
})

/**
 * 高亮：原生行为就是 `mark[data-color]`（multicolor），只是把解析到的颜色归一成
 * `#rrggbb`，免得同一种颜色在 JSON 里有 rgb() 与 hex 两种写法。
 */
export const WikiHighlight = Highlight.extend({
  addAttributes() {
    const parent = (this.parent?.() ?? {}) as Attributes
    if (!parent.color) return parent
    return {
      ...parent,
      color: {
        ...parent.color,
        parseHTML: (element: HTMLElement) =>
          normalizeColor(element.getAttribute("data-color")) ??
          normalizeColor(element.style.backgroundColor)
      }
    }
  }
})

/** 单元格底色：TipTap 的表格 schema 没有这个属性，按契约挂 `backgroundColor`。 */
function backgroundColorAttribute() {
  return {
    backgroundColor: {
      default: null,
      parseHTML: (element: HTMLElement) =>
        normalizeColor(element.getAttribute("data-cell-bg")) ??
        normalizeColor(element.style.backgroundColor),
      renderHTML: (attributes: Attributes) => {
        const color = attributes.backgroundColor as string | null
        if (!color) return {}
        return {
          "data-cell-bg": color,
          style: `background-color: ${color}`
        }
      }
    }
  }
}

export const WikiTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...backgroundColorAttribute() }
  }
})

export const WikiTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...backgroundColorAttribute() }
  }
})
