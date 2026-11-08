import { Editor } from "@tiptap/core"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { EditorToolbar } from "@/editor/EditorToolbar"
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
import { createExtensions } from "@/editor/extensions"
import { normalizeColor } from "@/lib/color"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"

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
  return editor.getJSON().content?.[index]?.content?.[0]
}

/** 表格里每行每格的背景色（按文档顺序）。 */
function cellBackgrounds(editor: Editor): (string | null)[][] {
  const rows = editor.getJSON().content?.[0]?.content ?? []
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
      { type: "textStyle", attrs: { color: "#0052cc" } }
    ])
    expect(currentTextColor(editor)).toBe("#0052cc")
    expect(editor.getHTML()).toContain('data-text-color="#0052cc"')

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
      { type: "textStyle", attrs: { color: "#de350b" } },
      { type: "highlight", attrs: { color: "#fffae6" } }
    ])
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
    expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toHaveLength(2)

    editor.commands.undo()
    expect(jsonText(editor)?.marks ?? []).toHaveLength(1)
    editor.commands.undo()
    expect(jsonText(editor)?.marks ?? []).toHaveLength(0)

    editor.commands.redo()
    editor.commands.redo()
    expect(jsonText(editor)?.marks).toEqual([
      { type: "textStyle", attrs: { color: "#de350b" } },
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
      { type: "textStyle", attrs: { color: "#0052cc" } }
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
