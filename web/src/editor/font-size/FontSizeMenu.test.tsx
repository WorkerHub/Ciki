import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Editor } from "@tiptap/core"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { createExtensions } from "@/editor/extensions"
import { FontSizeMenu } from "@/editor/font-size/FontSizeMenu"
import { currentFontSize, setFontSize } from "@/editor/font-size/commands"
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

describe("字号步进数字框组件（FontSizeMenu）", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  afterEach(async () => {
    await i18n.changeLanguage("zh")
    while (editors.length) editors.pop()?.destroy()
  })

  it("双语国际化：文案跟随语言切换（中文：默认/字号，英文：Default/Font size）", async () => {
    await i18n.changeLanguage("zh")
    const editor = makeEditor("<p>测试</p>")
    const { unmount } = render(<FontSizeMenu editor={editor} />)
    expect(screen.getByRole("button", { name: "字号" })).toHaveTextContent(
      "默认"
    )
    expect(screen.getByRole("button", { name: "减小字号" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "增大字号" })).toBeInTheDocument()
    unmount()

    await i18n.changeLanguage("en")
    render(<FontSizeMenu editor={editor} />)
    expect(screen.getByRole("button", { name: "Font size" })).toHaveTextContent(
      "Default"
    )
    expect(
      screen.getByRole("button", { name: "Decrease font size" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Increase font size" })
    ).toBeInTheDocument()
  })

  it("通过 − / + 沿固定刻度逐档增减，并在端点正确禁用", async () => {
    const user = userEvent.setup()
    const editor = makeEditor("<p>选中文字</p>")
    editor.commands.selectAll()
    render(<FontSizeMenu editor={editor} />)

    const minusBtn = screen.getByRole("button", { name: "减小字号" })
    const plusBtn = screen.getByRole("button", { name: "增大字号" })
    const trigger = screen.getByRole("button", { name: "字号" })

    // 默认档：- 禁用，+ 可用
    expect(trigger).toHaveTextContent("默认")
    expect(minusBtn).toBeDisabled()
    expect(plusBtn).toBeEnabled()

    // 点击 + -> 12
    await user.click(plusBtn)
    expect(currentFontSize(editor)).toBe("12px")
    expect(trigger).toHaveTextContent("12")
    expect(minusBtn).toBeEnabled()

    // 点击 + -> 14
    await user.click(plusBtn)
    expect(currentFontSize(editor)).toBe("14px")
    expect(trigger).toHaveTextContent("14")

    // 点击 - -> 回到 12
    await user.click(minusBtn)
    expect(currentFontSize(editor)).toBe("12px")
    expect(trigger).toHaveTextContent("12")

    // 点击 - -> 降回默认
    await user.click(minusBtn)
    expect(currentFontSize(editor)).toBeNull()
    expect(trigger).toHaveTextContent("默认")
    expect(minusBtn).toBeDisabled()

    // 设为最大刻度 32px
    act(() => {
      setFontSize(editor, "32px")
    })
    expect(trigger).toHaveTextContent("32")
    expect(plusBtn).toBeDisabled()
    expect(minusBtn).toBeEnabled()
  })

  it("点数字弹出纯数字刻度列表，点选切换字号并支持清除为默认", async () => {
    const user = userEvent.setup()
    const editor = makeEditor("<p>列表点选测试</p>")
    editor.commands.selectAll()
    render(<FontSizeMenu editor={editor} />)

    const trigger = screen.getByRole("button", { name: "字号" })
    expect(trigger).toHaveTextContent("默认")

    // 打开下拉选择 20
    await user.click(trigger)
    const item20 = await screen.findByRole("menuitem", { name: "20" })
    await user.click(item20)

    expect(currentFontSize(editor)).toBe("20px")
    expect(trigger).toHaveTextContent("20")

    // 重新打开选择「默认」清除字号
    await user.click(trigger)
    const itemDefault = await screen.findByRole("menuitem", { name: "默认" })
    await user.click(itemDefault)

    expect(currentFontSize(editor)).toBeNull()
    expect(trigger).toHaveTextContent("默认")
  })

  it("选区字号不一致时显示「—」，−/+ 置灰，点选任一刻度统一应用", async () => {
    const user = userEvent.setup()
    const editor = makeEditor(
      '<p>常规文字<span data-font-size="20px">大字号</span></p>'
    )
    editor.commands.selectAll()
    render(<FontSizeMenu editor={editor} />)

    const trigger = screen.getByRole("button", { name: "字号" })
    const minusBtn = screen.getByRole("button", { name: "减小字号" })
    const plusBtn = screen.getByRole("button", { name: "增大字号" })

    // 选区混排：显示 —，两端按钮禁用
    expect(trigger).toHaveTextContent("—")
    expect(minusBtn).toBeDisabled()
    expect(plusBtn).toBeDisabled()

    // 点开列表统一选 24
    await user.click(trigger)
    const item24 = await screen.findByRole("menuitem", { name: "24" })
    await user.click(item24)

    expect(currentFontSize(editor)).toBe("24px")
    expect(trigger).toHaveTextContent("24")
    expect(minusBtn).toBeEnabled()
    expect(plusBtn).toBeEnabled()
  })

  it("光标在不同字号文本间切换时实时响应（响应式）", () => {
    const editor = makeEditor(
      '<p>常规文字<span data-font-size="24px">超大文字</span></p>'
    )
    render(<FontSizeMenu editor={editor} />)

    const trigger = screen.getByRole("button", { name: "字号" })
    expect(trigger).toHaveTextContent("默认")

    act(() => putCursorAt(editor, "超大文字"))
    expect(trigger).toHaveTextContent("24")

    act(() => putCursorAt(editor, "常规文字"))
    expect(trigger).toHaveTextContent("默认")
  })
})
