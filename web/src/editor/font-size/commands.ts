import type { Editor } from "@tiptap/react"
import { type AllowedFontSize, normalizeFontSize } from "@/lib/font-size"

/** 当前选区行内字号（若为默认/未设置或非法则为 null）。 */
export function currentFontSize(editor: Editor): AllowedFontSize | null {
  const raw = editor.getAttributes("textStyle").fontSize as string | undefined
  return normalizeFontSize(raw)
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
