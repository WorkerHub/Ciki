import { Editor } from "@tiptap/core"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest"
import { EditorToolbar } from "@/editor/EditorToolbar"
import { createExtensions } from "@/editor/extensions"
import type { SearchResult } from "@/lib/api"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"

/**
 * 链接对话框的站内页面选择（规格：按编号/关键字搜索点选插入）：
 * 候选形态、两种选区情形的插入结果、当前页自排除、键盘选中、空态，
 * 以及 URL 手输原流程的回归。
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    searchApi: { ...actual.searchApi, query: vi.fn() }
  }
})

const { searchApi } = await import("@/lib/api")

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

function result(
  pageId: number,
  title: string,
  spaceName = "默认空间"
): SearchResult {
  return {
    pageId,
    title,
    snippet: `${title} 的正文片段`,
    updatedAt: "2026-11-13T00:00:00.000Z",
    spaceId: 1,
    spaceName
  }
}

function mockResults(results: SearchResult[]) {
  vi.mocked(searchApi.query).mockResolvedValue({ query: "q", results })
}

/** 文档里所有 link 标记的 href（按出现顺序）。 */
function linkHrefs(editor: Editor): string[] {
  const hrefs: string[] = []
  editor.state.doc.descendants((node) => {
    if (!node.isText) return true
    for (const mark of node.marks) {
      if (mark.type.name === "link") hrefs.push(mark.attrs.href as string)
    }
    return true
  })
  return hrefs
}

async function openLinkDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "插入链接" }))
}

describe("链接对话框：站内页面搜索选择", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  beforeEach(() => {
    vi.mocked(searchApi.query).mockReset()
  })

  afterEach(() => {
    while (editors.length) editors.pop()?.destroy()
  })

  it("候选带标题、空间名与编号，搜索参数是 (关键字, 8)", async () => {
    const user = userEvent.setup()
    const editor = makeEditor("<p>正文</p>")
    mockResults([result(42, "部署手册", "运维空间")])
    render(<EditorToolbar editor={editor} />)

    await openLinkDialog(user)
    await user.type(screen.getByLabelText("搜索站内页面"), "部署")

    const row = await screen.findByRole("button", { name: /部署手册/ })
    expect(row).toHaveTextContent("运维空间")
    expect(row).toHaveTextContent("#42")
    expect(searchApi.query).toHaveBeenCalledWith("部署", 8)
  })

  it("有选区时点选：选区文字不变，只是加上指向 /p/<id> 的链接", async () => {
    const user = userEvent.setup()
    const editor = makeEditor("<p>查看部署手册</p>")
    editor.commands.selectAll()
    mockResults([result(42, "部署手册", "运维空间")])
    render(<EditorToolbar editor={editor} />)

    await openLinkDialog(user)
    await user.type(screen.getByLabelText("搜索站内页面"), "部署")
    await user.click(await screen.findByRole("button", { name: /部署手册/ }))

    expect(editor.getText()).toBe("查看部署手册")
    expect(linkHrefs(editor)).toEqual(["/p/42"])
    expect(editor.getHTML()).toContain('href="/p/42"')
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("无选区时点选：光标处插入以目标标题为文字的链接", async () => {
    const user = userEvent.setup()
    const editor = makeEditor("<p>开始</p>")
    // 光标放到段落末尾（空选区）
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    mockResults([result(42, "部署手册", "运维空间")])
    render(<EditorToolbar editor={editor} />)

    await openLinkDialog(user)
    await user.type(screen.getByLabelText("搜索站内页面"), "部署")
    await user.click(await screen.findByRole("button", { name: /部署手册/ }))

    expect(editor.getText()).toBe("开始部署手册")
    expect(linkHrefs(editor)).toEqual(["/p/42"])
  })

  it("正在编辑的页面不出现在自己的候选里", async () => {
    const user = userEvent.setup()
    const editor = makeEditor("<p>正文</p>")
    mockResults([result(42, "当前页"), result(43, "另一页")])
    render(<EditorToolbar editor={editor} currentPageId={42} />)

    await openLinkDialog(user)
    await user.type(screen.getByLabelText("搜索站内页面"), "页")

    expect(await screen.findByRole("button", { name: /另一页/ })).toBeDefined()
    expect(screen.queryByRole("button", { name: /当前页/ })).toBeNull()
  })

  it("↑↓ 移动高亮、Enter 选中当前高亮项", async () => {
    const user = userEvent.setup()
    const editor = makeEditor("<p>正文</p>")
    mockResults([result(42, "部署手册"), result(43, "部署记录")])
    render(<EditorToolbar editor={editor} />)

    await openLinkDialog(user)
    const input = screen.getByLabelText("搜索站内页面")
    await user.type(input, "部署")
    await screen.findByRole("button", { name: /部署手册/ })

    await user.keyboard("{ArrowDown}{Enter}")

    expect(linkHrefs(editor)).toEqual(["/p/43"])
  })

  it("零结果只显示一行弱化文字，未输入时什么都不显示", async () => {
    const user = userEvent.setup()
    const editor = makeEditor("<p>正文</p>")
    mockResults([])
    render(<EditorToolbar editor={editor} />)

    await openLinkDialog(user)
    expect(screen.queryByText("无匹配页面")).toBeNull()

    await user.type(screen.getByLabelText("搜索站内页面"), "不存在的词")
    expect(await screen.findByText("无匹配页面")).toBeInTheDocument()
    expect(linkHrefs(editor)).toEqual([])
  })

  it("URL 手输原流程：应用写入链接，清空后应用移除链接", async () => {
    const user = userEvent.setup()
    const editor = makeEditor("<p>官网</p>")
    editor.commands.selectAll()
    render(<EditorToolbar editor={editor} />)

    await openLinkDialog(user)
    await user.type(screen.getByLabelText("链接地址"), "example.com")
    await user.click(screen.getByRole("button", { name: "应用" }))
    expect(linkHrefs(editor)).toEqual(["https://example.com"])

    await openLinkDialog(user)
    await user.clear(screen.getByLabelText("链接地址"))
    await user.click(screen.getByRole("button", { name: "应用" }))
    expect(linkHrefs(editor)).toEqual([])
    expect(editor.getText()).toBe("官网")
  })
})
