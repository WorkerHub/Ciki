import type { Editor } from "@tiptap/react"
import {
  ALLOWED_FONT_SIZES,
  type AllowedFontSize,
  normalizeFontSize
} from "@/lib/font-size"

export interface SelectionFontSizeResult {
  size: AllowedFontSize | null
  isMixed: boolean
}

export const FONT_SIZE_STEPS: readonly (AllowedFontSize | null)[] = [
  null,
  ...ALLOWED_FONT_SIZES
]

/**
 * 探测当前选区的字号状态：
 * - 纯光标态（empty）：直接读取光标所在处的 mark。
 * - 范围选区：扫描选区内包含的所有文本节点；
 *   - 若包含多种不同字号或部分带字号部分不带字号，判定为混排（isMixed: true, size: null）；
 *   - 若所有文本节点字号完全一致，返回统一的字号（或 null，代表全部为默认）；
 *   - 若选区内没有文本节点（如空段落或 NodeSelection），降级为光标处属性。
 */
export function selectionFontSize(editor: Editor): SelectionFontSizeResult {
  const { state } = editor
  const { from, to, empty } = state.selection

  if (empty) {
    const raw = editor.getAttributes("textStyle").fontSize as string | undefined
    return {
      size: normalizeFontSize(raw),
      isMixed: false
    }
  }

  let firstSeen = false
  let commonSize: AllowedFontSize | null = null
  let isMixed = false

  state.doc.nodesBetween(from, to, (node) => {
    if (isMixed) return false
    if (node.isText) {
      const mark = node.marks.find((m) => m.type.name === "textStyle")
      const nodeSize = normalizeFontSize(
        mark?.attrs?.fontSize as string | undefined
      )
      if (!firstSeen) {
        firstSeen = true
        commonSize = nodeSize
      } else if (nodeSize !== commonSize) {
        isMixed = true
        return false
      }
    }
    return true
  })

  if (!firstSeen) {
    const raw = editor.getAttributes("textStyle").fontSize as string | undefined
    return {
      size: normalizeFontSize(raw),
      isMixed: false
    }
  }

  if (isMixed) {
    return {
      size: null,
      isMixed: true
    }
  }

  return {
    size: commonSize,
    isMixed: false
  }
}

/** 当前选区行内字号（若为默认/未设置/非法或混排则为 null）。 */
export function currentFontSize(editor: Editor): AllowedFontSize | null {
  const result = selectionFontSize(editor)
  return result.isMixed ? null : result.size
}

/** 设置选区行内字号；size 为 null 时清除字号。 */
export function setFontSize(
  editor: Editor,
  size: AllowedFontSize | null
): void {
  if (size) {
    editor.chain().focus().setFontSize(size).run()
    return
  }
  editor.chain().focus().unsetFontSize().run()
}

/** 判断当前能否沿固定刻度步进（混排时置灰禁用）。 */
export function canStepFontSize(
  editor: Editor,
  direction: "up" | "down"
): boolean {
  const { size, isMixed } = selectionFontSize(editor)
  if (isMixed) return false
  const index = FONT_SIZE_STEPS.indexOf(size)
  if (index === -1) return false
  if (direction === "down") return index > 0
  return index < FONT_SIZE_STEPS.length - 1
}

/** 沿固定刻度逐档增减字号。 */
export function stepFontSize(editor: Editor, direction: "up" | "down"): void {
  const { size, isMixed } = selectionFontSize(editor)
  if (isMixed) return
  const index = FONT_SIZE_STEPS.indexOf(size)
  if (index === -1) return
  const nextIndex = direction === "down" ? index - 1 : index + 1
  if (nextIndex < 0 || nextIndex >= FONT_SIZE_STEPS.length) return
  setFontSize(editor, FONT_SIZE_STEPS[nextIndex])
}
