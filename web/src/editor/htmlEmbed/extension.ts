import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { i18n } from "@/i18n"
import { HtmlEmbedBlockView } from "./HtmlEmbedBlockView"
import type { HtmlEmbedNodeAttrs } from "./types"

export const MIN_HTML_EMBED_MANUAL_HEIGHT = 200
export const MAX_HTML_EMBED_MANUAL_HEIGHT = 2000
export const MIN_HTML_EMBED_AUTO_HEIGHT = 200
export const MAX_HTML_EMBED_AUTO_HEIGHT = 4000
export const DEFAULT_HTML_EMBED_HEIGHT = 480

export const MIN_HTML_EMBED_HEIGHT = MIN_HTML_EMBED_MANUAL_HEIGHT
export const MAX_HTML_EMBED_HEIGHT = MAX_HTML_EMBED_MANUAL_HEIGHT

/**
 * 针对手填/固定高度的钳制（200–2000px）。为空、空字符串或非法值返回 null（表示自动模式）。
 */
export function clampManualHtmlEmbedHeight(raw: unknown): number | null {
  if (raw == null) return null
  if (typeof raw === "string" && raw.trim() === "") return null
  const num = Number(raw)
  if (!Number.isFinite(num)) return null
  return Math.min(
    MAX_HTML_EMBED_MANUAL_HEIGHT,
    Math.max(MIN_HTML_EMBED_MANUAL_HEIGHT, Math.round(num))
  )
}

/**
 * 针对自动贴合上报高度的钳制（200–4000px）。
 */
export function clampAutoHtmlEmbedHeight(raw: unknown): number {
  const num = Number(raw)
  if (!Number.isFinite(num)) return DEFAULT_HTML_EMBED_HEIGHT
  return Math.min(
    MAX_HTML_EMBED_AUTO_HEIGHT,
    Math.max(MIN_HTML_EMBED_AUTO_HEIGHT, Math.round(num))
  )
}

/**
 * 兼容旧调用的手填高度 clamp（别名）。
 */
export function clampHtmlEmbedHeight(raw: unknown): number | null {
  return clampManualHtmlEmbedHeight(raw)
}

export interface HtmlEmbedOptions {
  HTMLAttributes: Record<string, unknown>
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    htmlEmbed: {
      setHtmlEmbed: (attrs?: Partial<HtmlEmbedNodeAttrs>) => ReturnType
    }
  }
}

function stopForInteractive({ event }: { event: Event }): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  return Boolean(
    target.closest("button, input, a, select, [data-html-embed-action]")
  )
}

export const WikiHtmlEmbed = Node.create<HtmlEmbedOptions>({
  name: "htmlEmbed",
  priority: 1000,
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return {
      HTMLAttributes: {}
    }
  },

  addAttributes() {
    return {
      key: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-key") ?? "",
        renderHTML: (attributes) => {
          if (!attributes.key) return {}
          return { "data-key": attributes.key }
        }
      },
      height: {
        default: null,
        parseHTML: (element) => {
          const raw = element.getAttribute("data-height")
          if (raw == null || raw.trim() === "") return null
          return clampManualHtmlEmbedHeight(raw)
        },
        renderHTML: (attributes) => {
          if (attributes.height == null || attributes.height === "") {
            return {}
          }
          const clamped = clampManualHtmlEmbedHeight(attributes.height)
          if (clamped == null) return {}
          return {
            "data-height": String(clamped)
          }
        }
      },
      name: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-name") ?? "",
        renderHTML: (attributes) => {
          if (!attributes.name) return {}
          return { "data-name": attributes.name }
        }
      }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="html-embed"]'
      }
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(
        this.options.HTMLAttributes,
        { "data-type": "html-embed" },
        HTMLAttributes
      )
    ]
  },

  renderText({ node }) {
    const label = i18n.t("editor.htmlEmbed.title")
    const unnamed = i18n.t("editor.htmlEmbed.unnamed")
    const name = node.attrs.name || unnamed
    return `[${label}: ${name}]\n`
  },

  addCommands() {
    return {
      setHtmlEmbed:
        (attrs) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              key: "",
              height: null,
              name: "",
              ...attrs
            }
          })
        }
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(HtmlEmbedBlockView, {
      stopEvent: stopForInteractive
    })
  }
})
