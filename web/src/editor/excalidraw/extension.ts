import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { imageWidth } from "@/editor/image-attributes"
import { ExcalidrawBlockView } from "./ExcalidrawBlockView"
import type { ExcalidrawNodeAttrs } from "./types"

export interface ExcalidrawOptions {
  HTMLAttributes: Record<string, unknown>
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    excalidraw: {
      setExcalidraw: (attrs?: Partial<ExcalidrawNodeAttrs>) => ReturnType
    }
  }
}

function stopForInteractive({ event }: { event: Event }): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  return Boolean(
    target.closest("button, input, a, select, [data-excalidraw-action]")
  )
}

export const WikiExcalidraw = Node.create<ExcalidrawOptions>({
  name: "excalidraw",
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
      sceneKey: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-scene-key") ?? "",
        renderHTML: (attributes) => {
          if (!attributes.sceneKey) return {}
          return { "data-scene-key": attributes.sceneKey }
        }
      },
      previewKey: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-preview-key") ?? "",
        renderHTML: (attributes) => {
          if (!attributes.previewKey) return {}
          return {
            "data-preview-key": attributes.previewKey,
            src: `/api/files/${attributes.previewKey}`
          }
        }
      },
      extractedText: {
        default: "",
        parseHTML: (element) => element.getAttribute("alt") ?? "",
        renderHTML: (attributes) => {
          return attributes.extractedText
            ? { alt: attributes.extractedText }
            : { alt: "" }
        }
      },
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

  parseHTML() {
    return [
      {
        tag: 'img[data-type="excalidraw"]'
      }
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "img",
      mergeAttributes(
        this.options.HTMLAttributes,
        { "data-type": "excalidraw" },
        HTMLAttributes
      )
    ]
  },

  renderText({ node }) {
    return node.attrs.extractedText ? `${node.attrs.extractedText}\n` : ""
  },

  addCommands() {
    return {
      setExcalidraw:
        (attrs) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              sceneKey: "",
              previewKey: "",
              extractedText: "",
              width: null,
              ...attrs
            }
          })
        }
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(ExcalidrawBlockView, {
      stopEvent: stopForInteractive
    })
  }
})
