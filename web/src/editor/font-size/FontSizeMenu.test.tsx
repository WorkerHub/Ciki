import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Editor } from "@tiptap/core"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { createExtensions } from "@/editor/extensions"
import {
  FONT_SIZE_OPTIONS,
  FontSizeMenu
} from "@/editor/font-size/FontSizeMenu"
import { currentFontSize } from "@/editor/font-size/commands"
import { i18n } from "@/i18n"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"

const editors: Editor[] = []

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

function putCursorAt(editor: Editor, text: string) {
  let pos = 1
  editor.state.doc.descendants((node, nodePos) => {
    if (node.isText && node.text === text) pos = nodePos + 1
    return true
  })
  editor.commands.setTextSelection(pos)
}

describe("字号下拉组件（FontSizeMenu）", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  afterEach(async () => {
    await i18n.changeLanguage("zh")
    while (editors.length) editors.pop()?.destroy()
  })

  it("选项包含默认项与 7 档固定刻度", () => {
    expect(FONT_SIZE_OPTIONS.map((opt) => opt.value)).toEqual([
      "default",
      "12px",
      "14px",
      "16px",
      "18px",
      "20px",
      "24px",
      "32px"
    ])
  })

  it("双语国际化：默认项文案跟随语言切换（中文：默认，英文：Default）", async () => {
    await i18n.changeLanguage("zh")
    const editor = makeEditor("<p>测试</p>")
    const { unmount } = render(<FontSizeMenu editor={editor} />)
    expect(screen.getByRole("combobox", { name: "字号" })).toHaveTextContent(
      "默认"
    )
    unmount()

    await i18n.changeLanguage("en")
    render(<FontSizeMenu editor={editor} />)
    expect(
      screen.getByRole("combobox", { name: "Font size" })
    ).toHaveTextContent("Default")
  })

  it("下拉切换字号应用到选区，选择默认项清除字号", async () => {
    const user = userEvent.setup()
    const editor = makeEditor("<p>选中文字</p>")
    editor.commands.selectAll()
    render(<FontSizeMenu editor={editor} />)

    const trigger = screen.getByRole("combobox", { name: "字号" })
    expect(trigger).toHaveTextContent("默认")

    // 打开下拉选择 20px
    await user.click(trigger)
    const opt20 = await screen.findByRole("option", { name: "20px" })
    await user.click(opt20)

    expect(currentFontSize(editor)).toBe("20px")
    expect(trigger).toHaveTextContent("20px")

    // 重新打开选择「默认」
    await user.click(trigger)
    const optDefault = await screen.findByRole("option", { name: "默认" })
    await user.click(optDefault)

    expect(currentFontSize(editor)).toBeNull()
    expect(trigger).toHaveTextContent("默认")
  })

  it("光标在不同字号文本间切换时实时响应（响应式）", () => {
    const editor = makeEditor(
      '<p>常规文字<span data-font-size="24px">超大文字</span></p>'
    )
    render(<FontSizeMenu editor={editor} />)

    const trigger = screen.getByRole("combobox", { name: "字号" })
    expect(trigger).toHaveTextContent("默认")

    act(() => putCursorAt(editor, "超大文字"))
    expect(trigger).toHaveTextContent("24px")

    act(() => putCursorAt(editor, "常规文字"))
    expect(trigger).toHaveTextContent("默认")
  })
})
