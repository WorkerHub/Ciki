import { render, screen } from "@testing-library/react"
import { Editor } from "@tiptap/core"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { createExtensions } from "@/editor/extensions"
import {
  PARAGRAPH_STYLES,
  ParagraphStyleMenu
} from "@/editor/ParagraphStyleMenu"
import { i18n } from "@/i18n"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"

/**
 * 段落样式下拉：选项集合与顺序不变，触发器收起态仍是纯文字当前项。
 * 每项的字号示范来自 .wiki-content 的同一组刻度（CSS），实际渲染在浏览器里取证。
 */

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

describe("段落样式下拉", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  afterEach(() => {
    while (editors.length) editors.pop()?.destroy()
  })

  it("选项仍是正文 + 标题 1–6，顺序固定，data-style 与选项同值", () => {
    expect(PARAGRAPH_STYLES.map((style) => style.value)).toEqual([
      "p",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6"
    ])
    // 数据里只有 key：文案由 t() 在渲染时给出
    expect(
      PARAGRAPH_STYLES.map((style) =>
        i18n.t(style.labelKey, { level: style.level })
      )
    ).toEqual([
      "正文",
      "标题 1",
      "标题 2",
      "标题 3",
      "标题 4",
      "标题 5",
      "标题 6"
    ])
  })

  it("英文界面：段落样式名换语言，data-style 不受影响", async () => {
    await i18n.changeLanguage("en")
    expect(
      PARAGRAPH_STYLES.map((style) =>
        i18n.t(style.labelKey, { level: style.level })
      )
    ).toEqual([
      "Body",
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Heading 4",
      "Heading 5",
      "Heading 6"
    ])
    expect(screen.queryByText("正文")).toBeNull()
  })

  it("收起态触发器是纯文字当前项（正文）", () => {
    const editor = makeEditor("<p>正文内容</p>")
    render(<ParagraphStyleMenu editor={editor} />)
    const trigger = screen.getByRole("combobox", { name: "段落样式" })
    expect(trigger).toHaveTextContent(/^正文$/)
  })

  it("光标在标题里时触发器显示该层级", () => {
    const editor = makeEditor("<h2>小标题</h2>")
    editor.commands.setTextSelection(1)
    render(<ParagraphStyleMenu editor={editor} />)
    expect(
      screen.getByRole("combobox", { name: "段落样式" })
    ).toHaveTextContent(/^标题 2$/)
  })
})
