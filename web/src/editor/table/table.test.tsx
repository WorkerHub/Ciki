import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Editor } from "@tiptap/core"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { editorPayload } from "@/editor/Editor"
import { EditorToolbar } from "@/editor/EditorToolbar"
import { createExtensions } from "@/editor/extensions"
import {
  MAX_TABLE_COLS,
  MAX_TABLE_ROWS,
  TableSizePicker
} from "@/editor/table/TableSizePicker"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"
import { docJson } from "@/test/tiptap-json"

/**
 * 表格入口的证据：网格选择器（上限、悬停高亮与计数同源、键盘路径），
 * 以及「插入所选行列 + 首行表头」与「当前表格」一组的显隐。
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

/** 光标落到第一处包含 `text` 的文字上。 */
function putCursorAt(editor: Editor, text: string) {
  let pos = 1
  editor.state.doc.descendants((node, nodePos) => {
    if (node.isText && node.text === text) pos = nodePos + 1
    return true
  })
  editor.commands.setTextSelection(pos)
}

function cell(row: number, col: number) {
  return screen.getByRole("button", { name: `${col} 列 × ${row} 行` })
}

function highlighted() {
  return document.querySelectorAll('[data-cell][data-selected="true"]')
}

describe("网格选择器", () => {
  it("上限 15 列 × 20 行，默认预选 3 × 3", () => {
    render(<TableSizePicker onPick={() => {}} />)
    expect(screen.getAllByRole("button")).toHaveLength(
      MAX_TABLE_COLS * MAX_TABLE_ROWS
    )
    expect(screen.getByText("3 × 3")).toBeInTheDocument()
    expect(highlighted()).toHaveLength(9)
  })

  it("悬停 4 列 × 2 行：计数变 4 × 2，高亮恰好 8 格", async () => {
    const user = userEvent.setup()
    render(<TableSizePicker onPick={() => {}} />)
    await user.hover(cell(2, 4))
    expect(screen.getByText("4 × 2")).toBeInTheDocument()
    expect(highlighted()).toHaveLength(8)
  })

  it("点击按所选行列回调（rows 含表头行）", async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<TableSizePicker onPick={onPick} />)
    await user.click(cell(2, 4))
    expect(onPick).toHaveBeenCalledWith(2, 4)
  })

  it("键盘：唯一 Tab 停靠点是当前格，方向键移动后 Enter 插入", async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<TableSizePicker onPick={onPick} />)

    // 默认只有 3×3 那一格可 Tab 到达
    const tabbable = document.querySelectorAll('[data-cell][tabindex="0"]')
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0]).toBe(cell(3, 3))

    cell(3, 3).focus()
    await user.keyboard("{ArrowRight}{ArrowDown}")
    expect(screen.getByText("4 × 4")).toBeInTheDocument()
    expect(document.activeElement).toBe(cell(4, 4))

    await user.keyboard("{Enter}")
    expect(onPick).toHaveBeenCalledWith(4, 4)
  })

  it("方向键在边界处停住，不越界", async () => {
    const user = userEvent.setup()
    render(<TableSizePicker onPick={() => {}} />)
    cell(1, 1).focus()
    await user.keyboard("{ArrowUp}{ArrowLeft}")
    expect(screen.getByText("1 × 1")).toBeInTheDocument()
    expect(document.activeElement).toBe(cell(1, 1))
  })
})

describe("工具条表格入口", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  afterEach(() => {
    while (editors.length) editors.pop()?.destroy()
  })

  it("光标不在表格内：只有选择器，没有「当前表格」一组", async () => {
    const user = userEvent.setup()
    const editor = makeEditor("<p>正文</p>")
    render(<EditorToolbar editor={editor} />)

    await user.click(screen.getByRole("button", { name: "表格" }))

    expect(await screen.findByText("3 × 3")).toBeInTheDocument()
    expect(screen.queryByText("当前表格")).toBeNull()
    expect(screen.queryByRole("button", { name: "在下方插入行" })).toBeNull()
    expect(screen.queryByRole("button", { name: "删除表格" })).toBeNull()
    // 老的第一项「插入表格（3×3）」不再直接出表格
    expect(screen.queryByText("插入表格（3×3）")).toBeNull()
  })

  it("选 4 列 × 2 行：插入 4 列 2 行，首行为表头", async () => {
    const user = userEvent.setup()
    const editor = makeEditor("<p>正文</p>")
    render(<EditorToolbar editor={editor} />)

    await user.click(screen.getByRole("button", { name: "表格" }))
    await user.click(await screen.findByRole("button", { name: "4 列 × 2 行" }))

    const table = docJson(editor).content?.find((node) => node.type === "table")
    expect(table?.content).toHaveLength(2)
    const [headerRow, bodyRow] = table?.content ?? []
    expect(headerRow.content?.map((node) => node.type)).toEqual([
      "tableHeader",
      "tableHeader",
      "tableHeader",
      "tableHeader"
    ])
    expect(bodyRow.content?.map((node) => node.type)).toEqual([
      "tableCell",
      "tableCell",
      "tableCell",
      "tableCell"
    ])
  })

  it("光标在表格内：出现「当前表格」五项", async () => {
    const user = userEvent.setup()
    const editor = makeEditor(
      "<table><tbody><tr><td>A</td></tr></tbody></table>"
    )
    putCursorAt(editor, "A")
    render(<EditorToolbar editor={editor} />)

    await user.click(screen.getByRole("button", { name: "表格" }))

    expect(await screen.findByText("当前表格")).toBeInTheDocument()
    for (const label of [
      "在下方插入行",
      "在右侧插入列",
      "删除当前行",
      "删除当前列",
      "删除表格"
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument()
    }
    // 选择器与「当前表格」并存
    expect(screen.getByText("3 × 3")).toBeInTheDocument()
  })
})

/**
 * 保存口径：单列表格的 colwidth 不许落库（列数=1 的表格唯一列占满正文宽）。
 * 载入时已经剥过一次，这里验保存侧——会话里拖过列宽手柄也回不到存储里。
 */
describe("保存负载的单列表格口径", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  const tableJson = (colwidth: number[] | null, secondCell = false) => ({
    type: "doc",
    content: [
      {
        type: "table",
        attrs: {},
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 1, colwidth },
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "参数" }]
                  }
                ]
              },
              ...(secondCell
                ? [
                    {
                      type: "tableCell",
                      attrs: { colspan: 1, rowspan: 1, colwidth: [200] },
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "值" }]
                        }
                      ]
                    }
                  ]
                : [])
            ]
          }
        ]
      }
    ]
  })

  const makeDocEditor = (content: unknown) => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const editor = new Editor({
      element: host,
      extensions: createExtensions("edit"),
      content: content as never
    })
    editors.push(editor)
    return editor
  }

  it("单列表格的 colwidth 在 contentJson 里被剥掉", () => {
    const editor = makeDocEditor(tableJson([76]))
    const payload = editorPayload(editor)
    expect(payload.contentJson).not.toContain("colwidth")
  })

  it("多列表格的列宽原样保留", () => {
    const editor = makeDocEditor(tableJson([120], true))
    const payload = editorPayload(editor)
    expect(payload.contentJson).toContain('"colwidth":[120]')
    expect(payload.contentJson).toContain('"colwidth":[200]')
  })
})

/**
 * 表格宽度 CSS 的判据（web/src/index.css）：带列宽的表格要放开 max-width，否则总宽被
 * 正文宽钳住，末列右边线拖不出正文宽。这里锁的是那条选择器依赖的 DOM 形态——TipTap
 * 升级若改了 col 的 style 写法，规则会静默失效；jsdom 没有布局，量不出尺寸，只能锁形态。
 */
describe("表格宽度 CSS 的判据", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  afterEach(() => {
    while (editors.length) editors.pop()?.destroy()
  })

  // 与 index.css 里那条规则同源：多列 + 至少一列带明确列宽
  const WIDTH_RULE =
    '.tableWrapper > table:has(> colgroup > col[style^="width:"], > colgroup > col[style*="; width:"]):not(:has(> colgroup > col:only-child))'

  const rendered = (html: string) => {
    const editor = makeEditor(html)
    const table = editor.view.dom.querySelector(".tableWrapper > table")
    expect(table).not.toBeNull()
    return table as HTMLTableElement
  }

  it("colgroup 带列宽的多列表格命中", () => {
    const table = rendered(
      [
        '<table><colgroup><col width="120"><col width="200"></colgroup><tbody>',
        "<tr><td>a</td><td>b</td></tr></tbody></table>"
      ].join("")
    )
    // 列宽落在 col 的 inline style 上，判据才认得出「这张表有列宽」
    expect(table.querySelector("col")?.getAttribute("style")).toBe(
      "width: 120px;"
    )
    expect(table.matches(WIDTH_RULE)).toBe(true)
  })

  it("没设过列宽的多列表格不命中（仍按内容定宽）", () => {
    const table = rendered(
      "<table><tbody><tr><td>a</td><td>b</td><td>c</td></tr></tbody></table>"
    )
    expect(table.querySelector("col")?.getAttribute("style")).toBe(
      "min-width: 25px;"
    )
    expect(table.matches(WIDTH_RULE)).toBe(false)
  })

  /**
   * 首拖之后：TableView 只给被拖那列写 width、不清原来的 min-width，
   * Chrome 于是把这一列序列化成 `min-width: 25px; width: 285px;`（实测形态）。
   */
  it("首拖之后某一列同时带 min-width 与 width 的形态命中", () => {
    const wrapper = document.createElement("div")
    wrapper.className = "tableWrapper"
    wrapper.innerHTML = [
      '<table><colgroup><col style="min-width: 25px; width: 285px;">',
      '<col style="min-width: 25px;"></colgroup>',
      "<tbody><tr><td>a</td><td>b</td></tr></tbody></table>"
    ].join("")
    const table = wrapper.querySelector("table") as HTMLTableElement
    expect(table.matches(WIDTH_RULE)).toBe(true)
  })

  it("单列表格即使带着列宽也不命中（恒满宽那条规则专管）", () => {
    const wrapper = document.createElement("div")
    wrapper.className = "tableWrapper"
    wrapper.innerHTML = [
      '<table><colgroup><col style="min-width: 25px; width: 1030px;"></colgroup>',
      "<tbody><tr><td>只有一个格子</td></tr></tbody></table>"
    ].join("")
    const table = wrapper.querySelector("table") as HTMLTableElement
    expect(table.matches(WIDTH_RULE)).toBe(false)
  })
})
