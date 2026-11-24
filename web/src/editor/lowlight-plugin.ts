import { findChildren } from "@tiptap/core"
import type { Node as ProsemirrorNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

function parseNodes(
  nodes: any[],
  className: string[] = []
): { text: string; classes: string[] }[] {
  return nodes.flatMap((node) => {
    const classes = [
      ...className,
      ...(node.properties ? node.properties.className : [])
    ]
    if (node.children) return parseNodes(node.children, classes)
    return {
      text: node.value,
      classes
    }
  })
}

function getHighlightNodes(result: any) {
  return result.value || result.children || []
}

export function getDecorations({
  doc,
  name,
  lowlight,
  defaultLanguage
}: {
  doc: ProsemirrorNode
  name: string
  lowlight: any
  defaultLanguage: string | null | undefined
}) {
  const decorations: Decoration[] = []

  findChildren(doc, (node) => node.type.name === name).forEach((block) => {
    let from = block.pos + 1
    const language = block.node.attrs.language || defaultLanguage

    const nodes = language
      ? lowlight.registered(language)
        ? getHighlightNodes(lowlight.highlight(language, block.node.textContent))
        : []
      : getHighlightNodes(lowlight.highlightAuto(block.node.textContent))

    parseNodes(nodes).forEach((node) => {
      const to = from + node.text.length
      if (node.classes.length) {
        const decoration = Decoration.inline(from, to, {
          class: node.classes.join(" ")
        })
        decorations.push(decoration)
      }
      from = to
    })
  })

  return DecorationSet.create(doc, decorations)
}

export const lowlightPluginKey = new PluginKey("lowlight")

export function WikiLowlightPlugin({
  name,
  lowlight,
  defaultLanguage
}: {
  name: string
  lowlight: any
  defaultLanguage: string | null | undefined
}) {
  const plugin: Plugin<any> = new Plugin({
    key: lowlightPluginKey,
    state: {
      init: (_, { doc }) =>
        getDecorations({
          doc,
          name,
          lowlight,
          defaultLanguage
        }),
      apply: (transaction, decorationSet, oldState, newState) => {
        if (transaction.getMeta("lowlight")) {
          return getDecorations({
            doc: newState.doc,
            name,
            lowlight,
            defaultLanguage
          })
        }
        if (!transaction.docChanged) return decorationSet

        const oldNodeName = oldState.selection.$head.parent.type.name
        const newNodeName = newState.selection.$head.parent.type.name
        const oldNodes = findChildren(oldState.doc, (node) => node.type.name === name)
        const newNodes = findChildren(newState.doc, (node) => node.type.name === name)

        if (
          [oldNodeName, newNodeName].includes(name) ||
          newNodes.length !== oldNodes.length ||
          transaction.steps.some((step: any) => {
            return (
              step.from !== undefined &&
              step.to !== undefined &&
              oldNodes.some((node) => {
                return (
                  node.pos >= step.from &&
                  node.pos + node.node.nodeSize <= step.to
                )
              })
            )
          })
        ) {
          return getDecorations({
            doc: transaction.doc,
            name,
            lowlight,
            defaultLanguage
          })
        }

        return decorationSet.map(transaction.mapping, transaction.doc)
      }
    },
    props: {
      decorations(state) {
        return plugin.getState(state)
      }
    }
  })

  return plugin
}
