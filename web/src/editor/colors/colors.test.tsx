import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Editor } from "@tiptap/core"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  currentCellBackground,
  currentHighlight,
  currentTextColor,
  setCellBackground,
  setHighlight,
  setTextColor
} from "@/editor/colors/commands"
import {
  CELL_COLORS,
  HIGHLIGHT_COLORS,
  TEXT_COLORS
} from "@/editor/colors/palette"
import { EditorToolbar } from "@/editor/EditorToolbar"
import { createExtensions } from "@/editor/extensions"
import { i18n } from "@/i18n"
import { normalizeColor } from "@/lib/color"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"
import { docJson } from "@/test/tiptap-json"

/**
 * 颜色能力的 Web 侧证据：模型形态（contract 冻结的 textStyle.color / highlight.color /
 * tableCell.backgroundColor）、命令行为（设置/清除/多格选区），以及工具条三个入口。
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

function jsonText(editor: Editor, index = 0) {
  return docJson(editor).content?.[index]?.content?.[0]
}

/** 表格里每行每格的背景色（按文档顺序）。 */
function cellBackgrounds(editor: Editor): (string | null)[][] {
  const rows = docJson(editor).content?.[0]?.content ?? []
  return rows.map((row) =>
    (row.content ?? []).map(
      (cell) => (cell.attrs?.backgroundColor as string | null) ?? null
    )
  )
}

describe("颜色值归一（写入 JSON 之前）", () => {
  it("hex / 短 hex / rgb() / rgba(…,1) 都归一成小写 #rrggbb", () => {
    expect(normalizeColor("#DE350B")).toBe("#de350b")
    expect(normalizeColor("#f00")).toBe("#ff0000")
    expect(normalizeColor("rgb(222, 53, 11)")).toBe("#de350b")
    expect(normalizeColor("rgba(222,53,11,1)")).toBe("#de350b")
  })

  it("逗号两侧有空白、纯空格分隔都认", () => {
    expect(normalizeColor("rgb( 222 , 53 , 11 )")).toBe("#de350b")
    expect(normalizeColor("rgb(222 53 11)")).toBe("#de350b")
    expect(normalizeColor("rgba(222 53 11 / 1)")).toBe("#de350b")
  })

  it("归一不出来的写法返回 null（不猜）", () => {
    expect(normalizeColor("red")).toBeNull()
    expect(normalizeColor("var(--accent)")).toBeNull()
    expect(normalizeColor("rgba(222,53,11,0.5)")).toBeNull()
    expect(normalizeColor("")).toBeNull()
  })

  it("畸形超长输入立即返回 null（分隔符无重叠空白量词，不会 O(n²) 回溯）", () => {
    const started = performance.now()
    expect(normalizeColor(`rgba(1${" ".repeat(100_000)}`)).toBeNull()
    expect(normalizeColor(`rgb(1${" ,".repeat(50_000)}`)).toBeNull()
    expect(normalizeColor(`rgb(${" ".repeat(100_000)}1`)).toBeNull()
    expect(performance.now() - started).toBeLessThan(50)
  })
})

describe("颜色命令（编辑器模型）", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  afterEach(() => {
    while (editors.length) editors.pop()?.destroy()
  })

  it("文字颜色：设置写入 textStyle.color，清除后 mark 消失", () => {
    const editor = makeEditor("<p>文字</p>")
    editor.commands.selectAll()
    setTextColor(editor, "#0052cc")
    expect(jsonText(editor)?.marks).toEqual([
      { type: "textStyle", attrs: { color: "#0052cc", fontSize: null } }
    ])
    expect(currentTextColor(editor)).toBe("#0052cc")
    expect(editor.getHTML()).toContain('data-text-color="#0052cc"')
    expect(editor.getHTML()).toContain("--dark-text-color: #3385ff")

    setTextColor(editor, null)
    expect(jsonText(editor)?.marks ?? []).toEqual([])
    expect(currentTextColor(editor)).toBeNull()
    expect(editor.getHTML()).not.toContain("data-text-color")
  })

  it("高亮：设置写入 highlight.color，清除后 mark 消失", () => {
    const editor = makeEditor("<p>文字</p>")
    editor.commands.selectAll()
    setHighlight(editor, "#ffe58f")
    expect(jsonText(editor)?.marks).toEqual([
      { type: "highlight", attrs: { color: "#ffe58f" } }
    ])
    expect(currentHighlight(editor)).toBe("#ffe58f")
    expect(editor.getHTML()).toContain('data-color="#ffe58f"')
    expect(editor.getHTML()).toContain("--dark-bg-color: #705600")

    setHighlight(editor, null)
    expect(jsonText(editor)?.marks ?? []).toEqual([])
    expect(currentHighlight(editor)).toBeNull()
  })

  it("文字颜色与高亮可以叠加在同一段文字上", () => {
    const editor = makeEditor("<p>文字</p>")
    editor.commands.selectAll()
    setTextColor(editor, "#de350b")
    setHighlight(editor, "#fffae6")
    expect(jsonText(editor)?.marks).toEqual([
      { type: "textStyle", attrs: { color: "#de350b", fontSize: null } },
      { type: "highlight", attrs: { color: "#fffae6" } }
    ])
  })

  it("决策 B：Confluence 亮红 (#de350b) 豁免夜间提亮，保持原色", () => {
    const editor = makeEditor("<p>亮红测试</p>")
    editor.commands.selectAll()
    setTextColor(editor, "#de350b")

    // HTML 输出与 DOM 均严格保持 #de350b
    expect(editor.getHTML()).toContain('data-text-color="#de350b"')
    expect(editor.getHTML()).toContain("--dark-text-color: #de350b")

    const span = editor.view.dom.querySelector(
      'span[data-text-color="#de350b"]'
    ) as HTMLElement
    expect(span.style.getPropertyValue("--dark-text-color")).toBe("#de350b")
  })

  it("决策 A：编辑态下文字与高亮/单元格底色联合自适应", () => {
    const editor = makeEditor("<p>前缀高亮后缀</p>")
    // 选中“高亮”两字（offset 3 到 5）并设置深黑字色 + 黄色高亮
    editor.commands.setTextSelection({ from: 3, to: 5 })
    setTextColor(editor, "#172b4d")
    setHighlight(editor, "#ffe58f")

    const mark = editor.view.dom.querySelector(
      'mark[data-color="#ffe58f"]'
    ) as HTMLElement
    expect(mark).toBeTruthy()
    // 联合背景自适应：生成带 --dark-text-color 的 Decoration 行内装饰器，避免直接写 DOM 引发自激死循环
    const jointSpan = editor.view.dom.querySelector(
      ".wiki-joint-text"
    ) as HTMLElement
    expect(jointSpan).toBeTruthy()
    expect(jointSpan.style.getPropertyValue("--dark-text-color")).toBe(
      "#c1d1ec"
    )
  })

  it("单元格底色：光标所在格与整表选区都能设，清除后属性回到 null", () => {
    const editor = makeEditor(
      "<table><tbody><tr><th>H</th><th>H2</th></tr><tr><td>A</td><td>B</td></tr></tbody></table>"
    )
    // 光标落在第二行第一格的 A 单元格里
    let pos = 1
    editor.state.doc.descendants((node, nodePos) => {
      if (node.isText && node.text === "A") pos = nodePos + 1
      return true
    })
    editor.commands.setTextSelection(pos)
    setCellBackground(editor, "#fffae6")
    expect(cellBackgrounds(editor)).toEqual([
      [null, null],
      ["#fffae6", null]
    ])
    expect(currentCellBackground(editor)).toBe("#fffae6")
    expect(editor.getHTML()).toContain('data-cell-bg="#fffae6"')
    expect(editor.getHTML()).toContain("--dark-bg-color: #191400")

    // 整表选中：表头与数据格一起写
    editor.commands.selectAll()
    setCellBackground(editor, "#deebff")
    expect(cellBackgrounds(editor)).toEqual([
      ["#deebff", "#deebff"],
      ["#deebff", "#deebff"]
    ])

    setCellBackground(editor, null)
    expect(cellBackgrounds(editor)).toEqual([
      [null, null],
      [null, null]
    ])
    expect(editor.getHTML()).not.toContain("data-cell-bg")
  })

  it("撤销/重做：颜色与单元格底色都能回退再回来", () => {
    const editor = makeEditor("<p>文字</p>")
    editor.commands.selectAll()
    setTextColor(editor, "#de350b")
    setHighlight(editor, "#ffe58f")
    expect(docJson(editor).content?.[0]?.content?.[0]?.marks).toHaveLength(2)

    editor.commands.undo()
    expect(jsonText(editor)?.marks ?? []).toHaveLength(1)
    editor.commands.undo()
    expect(jsonText(editor)?.marks ?? []).toHaveLength(0)

    editor.commands.redo()
    editor.commands.redo()
    expect(jsonText(editor)?.marks).toEqual([
      { type: "textStyle", attrs: { color: "#de350b", fontSize: null } },
      { type: "highlight", attrs: { color: "#ffe58f" } }
    ])
  })

  it("撤销：单元格底色写入可回退", () => {
    const editor = makeEditor(
      "<table><tbody><tr><td>A</td></tr></tbody></table>"
    )
    let pos = 1
    editor.state.doc.descendants((node, nodePos) => {
      if (node.isText && node.text === "A") pos = nodePos + 1
      return true
    })
    editor.commands.setTextSelection(pos)
    setCellBackground(editor, "#ffebe6")
    expect(cellBackgrounds(editor)).toEqual([["#ffebe6"]])
    editor.commands.undo()
    expect(cellBackgrounds(editor)).toEqual([[null]])
  })

  it("表头里的当前底色也能读回", () => {
    const editor = makeEditor(
      '<table><tbody><tr><th data-cell-bg="#f4f5f7">H</th></tr></tbody></table>'
    )
    let pos = 1
    editor.state.doc.descendants((node, nodePos) => {
      if (node.isText && node.text === "H") pos = nodePos + 1
      return true
    })
    editor.commands.setTextSelection(pos)
    expect(currentCellBackground(editor)).toBe("#f4f5f7")
  })
})

describe("工具条取色入口", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  afterEach(() => {
    while (editors.length) editors.pop()?.destroy()
  })

  it("文字颜色与高亮入口常显，单元格背景只在表格内出现", () => {
    const editor = makeEditor("<p>正文</p>")
    render(<EditorToolbar editor={editor} />)
    expect(screen.getByRole("button", { name: "文字颜色" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "高亮" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "单元格背景" })).toBeNull()
  })

  it("光标在表格里时出现单元格背景入口", () => {
    const editor = makeEditor(
      "<table><tbody><tr><td>A</td></tr></tbody></table>"
    )
    let pos = 1
    editor.state.doc.descendants((node, nodePos) => {
      if (node.isText && node.text === "A") pos = nodePos + 1
      return true
    })
    editor.commands.setTextSelection(pos)
    render(<EditorToolbar editor={editor} />)
    expect(
      screen.getByRole("button", { name: "单元格背景" })
    ).toBeInTheDocument()
  })

  it("点开色板选色后写入文档（文字颜色）", async () => {
    const user = userEvent.setup()
    const editor = makeEditor("<p>文字</p>")
    editor.commands.selectAll()
    render(<EditorToolbar editor={editor} />)

    await user.click(screen.getByRole("button", { name: "文字颜色" }))
    const swatch = await screen.findByRole("menuitem", { name: "蓝色" })
    await user.click(swatch)

    expect(jsonText(editor)?.marks).toEqual([
      { type: "textStyle", attrs: { color: "#0052cc", fontSize: null } }
    ])
  })

  it("点开色板选「清除」后颜色去掉", async () => {
    const user = userEvent.setup()
    const editor = makeEditor(
      '<p><span data-text-color="#de350b">文字</span></p>'
    )
    editor.commands.selectAll()
    render(<EditorToolbar editor={editor} />)

    await user.click(screen.getByRole("button", { name: "文字颜色" }))
    await user.click(await screen.findByRole("menuitem", { name: "清除颜色" }))

    expect(jsonText(editor)?.marks ?? []).toEqual([])
  })
})

describe("调色板数据", () => {
  it("三组预设都是 8 个色值 + 一个清除项，且色值合法", () => {
    for (const palette of [TEXT_COLORS, HIGHLIGHT_COLORS, CELL_COLORS]) {
      const values = palette.filter((option) => option.value)
      expect(values).toHaveLength(8)
      expect(palette.filter((option) => !option.value)).toHaveLength(1)
      for (const option of values) {
        expect(normalizeColor(option.value)).toBe(option.value)
      }
    }
  })
})

/** 英文界面：工具条动作的 aria-label/title 与色板里的颜色名全走 locale。 */
describe("工具条：英文界面", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  afterEach(() => {
    while (editors.length) editors.pop()?.destroy()
  })

  it("动作名与快捷键提示都换英文", async () => {
    await i18n.changeLanguage("en")
    const editor = makeEditor("<p>正文</p>")
    render(<EditorToolbar editor={editor} />)

    expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute(
      "title",
      "Bold (Ctrl/⌘ + B)"
    )
    expect(
      screen.getByRole("button", { name: "Strikethrough" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Text color" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Highlight" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Insert link" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Upload image" })
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "粗体" })).toBeNull()
  })

  it("色板的颜色名与清除项是英文", async () => {
    await i18n.changeLanguage("en")
    const user = userEvent.setup()
    const editor = makeEditor("<p>文字</p>")
    editor.commands.selectAll()
    render(<EditorToolbar editor={editor} />)

    await user.click(screen.getByRole("button", { name: "Text color" }))
    expect(
      await screen.findByRole("menuitem", { name: "Blue" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("menuitem", { name: "Clear color" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "蓝色" })).toBeNull()
  })
})

describe("编辑态死循环回归（ProseMirror DOMObserver 防自激）", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  afterEach(() => {
    while (editors.length) editors.pop()?.destroy()
  })

  it("触发矩阵 1：≥2 个「高亮+彩字」联合结构在编辑态正常渲染，零自激死循环", () => {
    const content = [
      '<p><mark data-color="#ffe58f"><span data-text-color="#172b4d">高亮一深黑字</span></mark></p>',
      '<p><mark data-color="#ffd7a8"><span data-text-color="#0052cc">高亮二蓝字</span></mark></p>',
      '<p><mark data-color="#baf5c0"><span data-text-color="#de350b">高亮三豁免红字</span></mark></p>'
    ].join("")

    const editor = makeEditor(content)
    expect(editor.isDestroyed).toBe(false)

    // 检查 Decoration 装饰器正常生效
    const jointSpans = Array.from(
      editor.view.dom.querySelectorAll<HTMLElement>(".wiki-joint-text")
    )
    expect(jointSpans).toHaveLength(3)
    // 第一项深黑字以黄色压暗底 (#705600) 为基准
    expect(jointSpans[0].style.getPropertyValue("--dark-text-color")).toBe(
      "#c1d1ec"
    )
    // 第二项蓝字以橙色压暗底为基准
    expect(
      jointSpans[1].style.getPropertyValue("--dark-text-color")
    ).toBeTruthy()
    // 第三项亮红字 #de350b 严格保持原色豁免
    expect(jointSpans[2].style.getPropertyValue("--dark-text-color")).toBe(
      "#de350b"
    )

    // 编辑操作（键入 / 修改选区）幂等且不引发循环重绘
    editor.commands.setTextSelection({ from: 1, to: 2 })
    editor.commands.insertContent("新输入")
    expect(editor.getText()).toContain("新输入")
  })

  it("触发矩阵 2：td+彩字 ≥3 与 th+彩字 ≥2 在编辑态正常渲染，零自激死循环", () => {
    const tableContent = [
      "<table>",
      "  <thead>",
      "    <tr>",
      '      <th data-cell-bg="#f4f5f7"><p><span data-text-color="#172b4d">表头1</span></p></th>',
      '      <th data-cell-bg="#deebff"><p><span data-text-color="#0052cc">表头2</span></p></th>',
      "    </tr>",
      "  </thead>",
      "  <tbody>",
      "    <tr>",
      '      <td data-cell-bg="#fffae6"><p><span data-text-color="#172b4d">单元格1</span></p></td>',
      '      <td data-cell-bg="#ffebe6"><p><span data-text-color="#d97008">单元格2</span></p></td>',
      '      <td data-cell-bg="#e3fcef"><p><span data-text-color="#1f845a">单元格3</span></p></td>',
      "    </tr>",
      "  </tbody>",
      "</table>"
    ].join("")

    const editor = makeEditor(tableContent)
    const jointSpans = Array.from(
      editor.view.dom.querySelectorAll<HTMLElement>(".wiki-joint-text")
    )
    expect(jointSpans).toHaveLength(5)
    for (const span of jointSpans) {
      expect(span.style.getPropertyValue("--dark-text-color")).toBeTruthy()
    }

    // 存储契约零改动：Decoration 不侵入 getHTML 与 getJSON 存储
    expect(editor.getHTML()).not.toContain("wiki-joint-text")
    expect(JSON.stringify(docJson(editor))).not.toContain("wiki-joint-text")
  })
})
