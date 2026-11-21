import { act, render, screen } from "@testing-library/react"
import { Editor } from "@tiptap/core"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { EditorToolbar } from "@/editor/EditorToolbar"
import { createExtensions } from "@/editor/extensions"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"

/**
 * 工具条状态型控件随选区实时更新（响应式）的证据：
 * 渲染后再改变选区（纯选区变化、不改内容），控件的激活态/当前值必须刷新。
 * 这是第二项的失效模式——旧实现渲染时读一次 isActive/getAttributes，选区变化不重渲染。
 */

const editors: Editor[] = []

function cleanupEditors() {
  while (editors.length) {
    const ed = editors.pop()
    const el = ed?.options.element
    if (el instanceof Element) el.remove()
    ed?.destroy()
  }
}

function makeEditor(content: string): Editor {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    extensions: createExtensions("edit"),
    content
  })
  editors.push(editor)
  return editor
}

/** 光标落到第一处文字等于 `text` 的文字上。 */
function putCursorAt(editor: Editor, text: string) {
  let pos = 1
  editor.state.doc.descendants((node, nodePos) => {
    if (node.isText && node.text === text) pos = nodePos + 1
    return true
  })
  editor.commands.setTextSelection(pos)
}

describe("工具条随选区实时更新", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  afterEach(() => {
    cleanupEditors()
  })

  it("粗体按钮激活态随光标进入/离开粗体文字刷新", () => {
    const editor = makeEditor("<p>普通文字</p><p><strong>粗体文字</strong></p>")
    render(<EditorToolbar editor={editor} />)

    const bold = screen.getByRole("button", { name: "粗体" })
    expect(bold).toHaveAttribute("aria-pressed", "false")

    act(() => putCursorAt(editor, "粗体文字"))
    expect(bold).toHaveAttribute("aria-pressed", "true")

    act(() => putCursorAt(editor, "普通文字"))
    expect(bold).toHaveAttribute("aria-pressed", "false")
  })

  it("段落样式菜单当前值随光标进入/离开标题刷新", () => {
    const editor = makeEditor("<p>正文段落</p><h2>二级标题</h2>")
    render(<EditorToolbar editor={editor} />)

    const trigger = screen.getByRole("combobox", { name: "段落样式" })
    expect(trigger).toHaveTextContent(/^正文$/)

    act(() => putCursorAt(editor, "二级标题"))
    expect(trigger).toHaveTextContent(/^标题 2$/)

    act(() => putCursorAt(editor, "正文段落"))
    expect(trigger).toHaveTextContent(/^正文$/)
  })

  it("文字颜色按钮的当前色条随光标进入带色文字刷新", () => {
    const editor = makeEditor(
      '<p>无色</p><p><span data-text-color="#de350b">红色文字</span></p>'
    )
    render(<EditorToolbar editor={editor} />)

    const textColorButton = screen.getByRole("button", { name: "文字颜色" })
    const swatch = textColorButton.querySelector<HTMLElement>(
      "span[aria-hidden='true']"
    )
    expect(swatch).not.toBeNull()
    // 初始光标在无色文字：色条透明
    expect(swatch?.style.backgroundColor).toBe("transparent")

    act(() => putCursorAt(editor, "红色文字"))
    // 进入带色文字后色条反映当前颜色（不再是透明）
    expect(swatch?.style.backgroundColor).not.toBe("transparent")
  })

  it("字号下拉菜单当前值随光标进入/离开不同字号文字刷新", () => {
    const editor = makeEditor(
      '<p>默认字号</p><p><span data-font-size="20px">大字号</span></p>'
    )
    render(<EditorToolbar editor={editor} />)

    const trigger = screen.getByRole("combobox", { name: "字号" })
    expect(trigger).toHaveTextContent(/^默认$/)

    act(() => putCursorAt(editor, "大字号"))
    expect(trigger).toHaveTextContent(/^20px$/)

    act(() => putCursorAt(editor, "默认字号"))
    expect(trigger).toHaveTextContent(/^默认$/)
  })
})
