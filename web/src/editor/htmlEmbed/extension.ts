import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { i18n } from "@/i18n"
import { HtmlEmbedBlockView } from "./HtmlEmbedBlockView"
import type { HtmlEmbedNodeAttrs } from "./types"

export const MIN_HTML_EMBED_HEIGHT = 200
export const MAX_HTML_EMBED_HEIGHT = 2000
export const DEFAULT_HTML_EMBED_HEIGHT = 480

export function clampHtmlEmbedHeight(raw: unknown): number {
  if (raw == null) return DEFAULT_HTML_EMBED_HEIGHT
  if (typeof raw === "string" && raw.trim() === "")
    return DEFAULT_HTML_EMBED_HEIGHT
  const num = Number(raw)
  if (!Number.isFinite(num)) return DEFAULT_HTML_EMBED_HEIGHT
  return Math.min(
    MAX_HTML_EMBED_HEIGHT,
    Math.max(MIN_HTML_EMBED_HEIGHT, Math.round(num))
  )
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
        default: DEFAULT_HTML_EMBED_HEIGHT,
        parseHTML: (element) => {
          const raw = element.getAttribute("data-height")
          if (raw == null || raw.trim() === "") return DEFAULT_HTML_EMBED_HEIGHT
          return clampHtmlEmbedHeight(raw)
        },
        renderHTML: (attributes) => {
          return {
            "data-height": String(clampHtmlEmbedHeight(attributes.height))
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
              height: DEFAULT_HTML_EMBED_HEIGHT,
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
