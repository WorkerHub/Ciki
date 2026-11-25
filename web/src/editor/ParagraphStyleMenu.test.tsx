import { act, render, screen } from "@testing-library/react"
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
    render(<ParagraphStyleMenu editor={editor} />)
    // 首挂事务发生前稳定显示正文（#230）
    expect(
      screen.getByRole("combobox", { name: "段落样式" })
    ).toHaveTextContent(/^正文$/)

    // 光标进入标题产生事务后显示对应层级
    act(() => {
      editor.commands.setTextSelection(1)
    })
    expect(
      screen.getByRole("combobox", { name: "段落样式" })
    ).toHaveTextContent(/^标题 2$/)
  })

  it("正文到位重建实例后标签稳定为正文，落定后如实反映选区（#210）", () => {
    // 正文到位前：空文档实例
    const first = makeEditor("")
    const { rerender } = render(<ParagraphStyleMenu editor={first} />)
    const trigger = screen.getByRole("combobox", { name: "段落样式" })
    expect(trigger).toHaveTextContent(/^正文$/)

    // 正文到位：useEditor 重建一个以标题开头的新实例，默认 selection 落在标题上
    const second = makeEditor("<h2>小标题</h2><p>正文内容</p>")
    rerender(<ParagraphStyleMenu editor={second} />)
    // 关键回归：标签仍是「正文」，不随机闪成「标题 2」
    expect(trigger).toHaveTextContent(/^正文$/)

    // 用户把光标真正移进标题后才反映层级
    act(() => {
      second.commands.setTextSelection(2)
    })
    expect(trigger).toHaveTextContent(/^标题 2$/)

    // 移入正文：标签跟随变为「正文」
    act(() => {
      second.commands.setTextSelection(8)
    })
    expect(trigger).toHaveTextContent(/^正文$/)

    // 再次移入标题：标签跟随变回「标题 2」
    act(() => {
      second.commands.setTextSelection(2)
    })
    expect(trigger).toHaveTextContent(/^标题 2$/)
  })

  it("同一页面内容多次重载，初始标签必须稳定一致为正文（#210）", () => {
    const initial = makeEditor("")
    const { rerender } = render(<ParagraphStyleMenu editor={initial} />)
    const trigger = screen.getByRole("combobox", { name: "段落样式" })

    // 模拟多次换页或内容重载（每次均以 h2 开头）
    for (let i = 0; i < 3; i++) {
      const nextEditor = makeEditor(
        `<h2>第 ${i + 1} 次标题</h2><p>段落内容</p>`
      )
      rerender(<ParagraphStyleMenu editor={nextEditor} />)
      // 重载后事务发生前一律显示「正文」，无抖动
      expect(trigger).toHaveTextContent(/^正文$/)

      // 光标落定到标题上后才反映「标题 2」
      act(() => {
        nextEditor.commands.setTextSelection(2)
      })
      expect(trigger).toHaveTextContent(/^标题 2$/)
    }
  })

  it("首挂即拿到含标题内容实例时标签稳定为正文，首笔事务落定后如实反映选区（#230）", () => {
    const editor = makeEditor("<h2>文首标题</h2><p>正文内容</p>")
    render(<ParagraphStyleMenu editor={editor} />)
    const trigger = screen.getByRole("combobox", { name: "段落样式" })
    // 首挂即正文：tx: 0 哨兵阻断 0 > -1 恒真路径，防止首挂直接反映文首标题（#229 打回项）
    expect(trigger).toHaveTextContent(/^正文$/)

    // 首笔事务落定（用户交互或光标定位）后如实反映选区
    act(() => {
      editor.commands.setTextSelection(2)
    })
    expect(trigger).toHaveTextContent(/^标题 2$/)

    // 移入正文跟随变回正文
    act(() => {
      editor.commands.setTextSelection(8)
    })
    expect(trigger).toHaveTextContent(/^正文$/)
  })
})
