import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Editor, JSONContent } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import { useEffect } from "react"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { createExtensions } from "@/editor/extensions"
import { ReadView } from "@/editor/ReadView"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"

/**
 * 代码块折叠（契约 `pre[data-collapsed="true"|"false"]`，缺省为裸 `<pre>`）：
 * 阅读页/版本预览按三态决定初始是否折叠，编辑态永不折叠、用「默认折叠」开关写回属性。
 */

/** n 行代码：line 1 … line n（与单 A 夹具 codeText 同形）。 */
function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join(
    "\n"
  )
}

/** 服务端渲染 + 消毒后的 content_html 形态；mark 缺省即「未表态」。 */
function codeHtml(text: string, mark?: "true" | "false"): string {
  const attrs = mark ? ` data-collapsed="${mark}"` : ""
  return `<pre${attrs}><code>${text}</code></pre>`
}

function codePanel(container: HTMLElement): HTMLElement {
  const panel = container.querySelector<HTMLElement>(".code-block > pre")
  if (!panel) throw new Error("代码块 <pre> 没渲染出来")
  return panel
}

/** 展开态头部：左组随语言名、右组放复制/编辑控件（与 CodeBlockView 结构一一对应）。 */
function headerGroups(container: HTMLElement): {
  left: HTMLElement
  right: HTMLElement
} {
  const header = container.querySelector<HTMLElement>("[data-code-header]")
  if (!header) throw new Error("代码块头部没渲染出来")
  const [left, right] = Array.from(
    header.children,
    (child) => child as HTMLElement
  )
  if (!left || !right) throw new Error("代码块头部只有一组控件")
  return { left, right }
}

function codeDoc(attrs: Record<string, unknown>, rows: number): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "codeBlock",
        attrs: { language: "sql", ...attrs },
        content: [{ type: "text", text: lines(rows) }]
      }
    ]
  }
}

function collapsedOf(editor: Editor): unknown {
  return editor.state.doc.firstChild?.attrs.collapsed ?? null
}

/** 编辑器实例放在 ref 里：用例里取用时再确认非空，避免一堆 as 断言。 */
type EditorRef = { current: Editor | null }

function instanceOf(ref: EditorRef): Editor {
  if (!ref.current) throw new Error("编辑器还没就绪")
  return ref.current
}

function EditHarness({
  content,
  onEditor,
  onUpdate
}: {
  content: string | JSONContent
  onEditor?: (editor: Editor) => void
  onUpdate?: () => void
}) {
  const editor = useEditor({
    extensions: createExtensions("edit"),
    content,
    onUpdate
  })
  useEffect(() => {
    if (editor) onEditor?.(editor)
  }, [editor, onEditor])
  return <EditorContent editor={editor} />
}

describe("阅读页代码块折叠（三态）", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  it("true 的块打开即折叠：一条折叠栏，点开见全文并可再收起", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <ReadView html={codeHtml("select 1;", "true")} />
    )
    const expand = await screen.findByRole("button", { name: /展开代码/ })

    expect(codePanel(container)).not.toBeVisible()
    expect(expand).toHaveAttribute("aria-expanded", "false")
    // 折叠态内容不可见，不给复制入口
    expect(screen.queryByRole("button", { name: "复制代码" })).toBeNull()

    await user.click(expand)

    expect(codePanel(container)).toBeVisible()
    expect(screen.getByRole("button", { name: "复制代码" })).toBeInTheDocument()
    const collapse = screen.getByRole("button", { name: /收起代码/ })
    expect(collapse).toHaveAttribute("aria-expanded", "true")

    await user.click(collapse)

    expect(codePanel(container)).not.toBeVisible()
    expect(screen.getByRole("button", { name: /展开代码/ })).toBeInTheDocument()
  })

  it("折叠栏显示语言名，展开后回到头部那条栏并给出「收起代码」", async () => {
    const user = userEvent.setup()
    render(
      <ReadView
        html={
          '<pre data-collapsed="true"><code class="language-sql">select 1;</code></pre>'
        }
      />
    )
    const bar = await screen.findByRole("button", { name: /展开代码/ })
    expect(bar).toHaveTextContent("SQL")

    await user.click(bar)
    expect(screen.getByRole("button", { name: /收起代码/ })).toBeInTheDocument()
    // 展开后语言名回到头部左侧，「收起代码」就排在它后面
    expect(screen.getByText("SQL")).toBeInTheDocument()
  })

  it("展开态「收起代码」在头部左侧语言名之后，复制按钮在右侧", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <ReadView
        html={
          '<pre data-collapsed="true"><code class="language-sql">select 1;</code></pre>'
        }
      />
    )

    await user.click(await screen.findByRole("button", { name: /展开代码/ }))

    const { left, right } = headerGroups(container)
    const collapse = screen.getByRole("button", { name: /收起代码/ })
    const copy = screen.getByRole("button", { name: "复制代码" })

    // 左侧顺序：图标 → 语言名 → 收起代码（与折叠态「展开代码」同一位置）
    expect(left.children).toHaveLength(3)
    expect(left.lastElementChild).toBe(collapse)
    expect(left.querySelector("[data-code-language]")).toHaveTextContent("SQL")
    // 右侧阅读态只剩复制按钮
    expect(right.querySelectorAll("button")).toHaveLength(1)
    expect(right.querySelector("button")).toBe(copy)
    expect(right).not.toContainElement(collapse)
  })

  it("反复展开/收起，开关始终在左侧同一位置、复制按钮始终在右侧", async () => {
    const user = userEvent.setup()
    // 自动折叠的块（> 20 行、未表态）与显式 collapsed=true 走同一套开关
    const { container } = render(<ReadView html={codeHtml(lines(30))} />)

    for (let round = 0; round < 2; round += 1) {
      await user.click(await screen.findByRole("button", { name: /展开代码/ }))

      const { left, right } = headerGroups(container)
      const collapse = screen.getByRole("button", { name: /收起代码/ })
      expect(codePanel(container)).toBeVisible()
      expect(left.lastElementChild).toBe(collapse)
      expect(right.querySelector("button")).toBe(
        screen.getByRole("button", { name: "复制代码" })
      )

      await user.click(collapse)

      expect(codePanel(container)).not.toBeVisible()
      expect(screen.queryByRole("button", { name: "复制代码" })).toBeNull()
    }
  })

  it("无语言名的折叠块只有「展开代码」，不写「纯文本」", async () => {
    render(<ReadView html={codeHtml(lines(30))} />)
    expect(
      await screen.findByRole("button", { name: "展开代码" })
    ).toHaveTextContent(/^展开代码$/)
  })

  it("false 的 30 行块打开即展开，且不给折叠入口", async () => {
    const { container } = render(
      <ReadView html={codeHtml(lines(30), "false")} />
    )
    expect(
      await screen.findByRole("button", { name: "复制代码" })
    ).toBeInTheDocument()

    expect(codePanel(container)).toBeVisible()
    expect(screen.queryByRole("button", { name: /展开代码/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /收起代码/ })).toBeNull()
  })

  it("未表态的 30 行块自动折叠、10 行块展开", async () => {
    const long = render(<ReadView html={codeHtml(lines(30))} />)
    expect(
      await screen.findByRole("button", { name: "展开代码" })
    ).toBeInTheDocument()
    expect(codePanel(long.container)).not.toBeVisible()
    long.unmount()

    const short = render(<ReadView html={codeHtml(lines(10))} />)
    expect(
      await screen.findByRole("button", { name: "复制代码" })
    ).toBeInTheDocument()
    expect(codePanel(short.container)).toBeVisible()
    expect(screen.queryByRole("button", { name: /展开代码/ })).toBeNull()
  })
})

describe("编辑器「默认折叠」开关", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  it("缺省时开关为关、编辑态不折叠；开→true、关→显式 false，都算一次改动", async () => {
    const user = userEvent.setup()
    const onUpdate = vi.fn()
    const ref: EditorRef = { current: null }
    const { container } = render(
      <EditHarness
        content={codeDoc({}, 30)}
        onEditor={(instance) => {
          ref.current = instance
        }}
        onUpdate={onUpdate}
      />
    )

    const toggle = await screen.findByRole("switch", { name: "默认折叠" })
    expect(toggle).not.toBeChecked()
    // 编辑态永不折叠：没有折叠栏，30 行正文完整可见
    expect(codePanel(container)).toBeVisible()
    expect(screen.queryByRole("button", { name: /展开代码/ })).toBeNull()
    expect(onUpdate).not.toHaveBeenCalled()
    // 未表态的内容序列化出去仍是裸 <pre>
    expect(instanceOf(ref).getHTML()).not.toContain("data-collapsed")

    await user.click(toggle)

    expect(toggle).toBeChecked()
    expect(collapsedOf(instanceOf(ref))).toBe(true)
    expect(instanceOf(ref).getHTML()).toContain('data-collapsed="true"')
    expect(onUpdate).toHaveBeenCalled()

    await user.click(toggle)

    expect(toggle).not.toBeChecked()
    expect(collapsedOf(instanceOf(ref))).toBe(false)
    expect(instanceOf(ref).getHTML()).toContain('data-collapsed="false"')
  })

  it("collapsed=true 的块在编辑态也完整可编辑，开关回显为开", async () => {
    const { container } = render(
      <EditHarness content={codeDoc({ collapsed: true }, 3)} />
    )

    const toggle = await screen.findByRole("switch", { name: "默认折叠" })
    expect(toggle).toBeChecked()
    expect(codePanel(container)).toBeVisible()
    expect(screen.queryByRole("button", { name: /展开代码/ })).toBeNull()
  })

  it("HTML 载具往返：false 解析为显式 false，裸 pre 解析为未表态", async () => {
    const ref: EditorRef = { current: null }
    const marked = render(
      <EditHarness
        content={codeHtml("select 1;", "false")}
        onEditor={(instance) => {
          ref.current = instance
        }}
      />
    )
    await waitFor(() => expect(ref.current).not.toBeNull())
    await waitFor(() => expect(collapsedOf(instanceOf(ref))).toBe(false))
    // 显式 false 必须原样写回，不能降级成「未表态」
    expect(instanceOf(ref).getHTML()).toContain('data-collapsed="false"')
    marked.unmount()
    ref.current = null

    render(
      <EditHarness
        content={codeHtml("select 1;")}
        onEditor={(instance) => {
          ref.current = instance
        }}
      />
    )
    await waitFor(() => expect(ref.current).not.toBeNull())
    expect(collapsedOf(instanceOf(ref))).toBeNull()
    expect(instanceOf(ref).getHTML()).not.toContain("data-collapsed")
  })
})
