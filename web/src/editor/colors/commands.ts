/**
 * 三个取色入口的读写助手 —— 工具条只关心「当前是什么色、点一下设成什么色」。
 * 单元格底色要同时落到 tableCell 与 tableHeader：TipTap 的单元格选区可以跨表头，
 * 一次链式调用会把选区内两种节点都写上（cursor 落在其中一种时另一种是空操作）。
 */
import type { Editor } from "@tiptap/react"

/** 当前选区文字颜色（无则 null）。 */
export function currentTextColor(editor: Editor): string | null {
  return (editor.getAttributes("textStyle").color as string | undefined) ?? null
}

export function setTextColor(editor: Editor, color: string | null): void {
  if (color) {
    editor.chain().focus().setColor(color).run()
    return
  }
  editor.chain().focus().unsetColor().run()
}

/** 当前选区高亮色（无则 null）。 */
export function currentHighlight(editor: Editor): string | null {
  return (editor.getAttributes("highlight").color as string | undefined) ?? null
}

export function setHighlight(editor: Editor, color: string | null): void {
  if (color) {
    editor.chain().focus().setHighlight({ color }).run()
    return
  }
  editor.chain().focus().unsetHighlight().run()
}

/** 当前单元格底色（表头与普通单元格都算，无则 null）。 */
export function currentCellBackground(editor: Editor): string | null {
  const cell = editor.getAttributes("tableCell").backgroundColor as
    | string
    | undefined
  const header = editor.getAttributes("tableHeader").backgroundColor as
    | string
    | undefined
  return cell ?? header ?? null
}

export function setCellBackground(editor: Editor, color: string | null): void {
  editor
    .chain()
    .focus()
    .updateAttributes("tableCell", { backgroundColor: color })
    .updateAttributes("tableHeader", { backgroundColor: color })
    .run()
}
