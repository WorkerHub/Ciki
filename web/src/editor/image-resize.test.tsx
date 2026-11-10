import { render, screen, waitFor } from "@testing-library/react"
import type { Editor, JSONContent } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import { useEffect } from "react"
import { beforeAll, describe, expect, it } from "vitest"
import { createExtensions, type EditorMode } from "@/editor/extensions"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"

const SRC = "/api/files/0f3c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b.png"
const UPLOADED = "/api/files/1f3c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b.png"
const UNTRANSFERRED_HTML = `<p><img alt="架构图" data-original-src="https://confluence.example.com/download/attachments/1/arch.png" data-confluence-img="true"></p>`

function Harness({
  content,
  mode,
  onEditor,
  onUpdate
}: {
  content: string
  mode: EditorMode
  onEditor?: (editor: Editor) => void
  onUpdate?: () => void
}) {
  const editor = useEditor(
    {
      extensions: createExtensions(mode),
      content,
      editable: mode === "edit",
      onUpdate: () => onUpdate?.()
    },
    [mode]
  )
  useEffect(() => {
    if (editor) onEditor?.(editor)
  }, [editor, onEditor])
  return (
    <div>
      <EditorContent editor={editor} />
      <span data-testid="ready">{editor ? "yes" : "no"}</span>
    </div>
  )
}

/** 图片是块级节点，前面常有一个空段落：按文档顺序找它的实际位置。 */
function imagePosition(editor: Editor): number {
  let position = -1
  editor.state.doc.forEach((node, offset) => {
    if (position < 0 && node.type.name === "image") position = offset
  })
  return position
}

function imageNode(editor: Editor): JSONContent | undefined {
  return editor.getJSON().content?.find((node) => node.type === "image")
}

describe("图片手动缩放（编辑态手柄 + 宽度持久化）", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  it("编辑态：带宽度渲染成可缩放视图，手柄就位，宽度写回 HTML", async () => {
    let editor: Editor | null = null
    const { container } = render(
      <Harness
        mode="edit"
        content={`<p><img src="${SRC}" alt="示意图" width="320"></p>`}
        onEditor={(instance) => {
          editor = instance
        }}
      />
    )

    await screen.findByRole("img", { name: "示意图" })
    const img = container.querySelector(
      "figure[data-image-block] img"
    ) as HTMLImageElement
    expect(img.style.width).toBe("320px")
    // 高恒自动：节点上没有 height，行内也不该有像素高度
    expect(img.style.height).toBe("")
    expect(img).not.toHaveAttribute("height")
    // 缩放手柄由依赖（ResizableNodeView）生成，右下角一个
    expect(container.querySelector("[data-resize-container]")).not.toBeNull()
    expect(
      container.querySelector('[data-resize-handle="bottom-right"]')
    ).not.toBeNull()
    await waitFor(() => {
      expect(editor?.getHTML()).toContain('width="320"')
      expect(editor?.getHTML()).not.toContain("height=")
    })
  })

  it("编辑态：存量无宽度图片维持自然尺寸、不写出宽度", async () => {
    let editor: Editor | null = null
    const { container } = render(
      <Harness
        mode="edit"
        content={`<p><img src="${SRC}" alt="示意图"></p>`}
        onEditor={(instance) => {
          editor = instance
        }}
      />
    )

    await screen.findByRole("img", { name: "示意图" })
    const img = container.querySelector(
      "figure[data-image-block] img"
    ) as HTMLImageElement
    expect(img.style.width).toBe("")
    expect(img.style.height).toBe("")
    // 没有宽度的图同样可以拖：手柄照出
    expect(
      container.querySelector('[data-resize-handle="bottom-right"]')
    ).not.toBeNull()
    await waitFor(() => {
      expect(editor?.getHTML()).not.toContain("width=")
    })
  })

  it("阅读态：只按已存宽度渲染，不出任何手柄", async () => {
    const { container } = render(
      <Harness
        mode="read"
        content={`<p><img src="${SRC}" alt="示意图" width="320"></p>`}
      />
    )

    const img = await screen.findByRole("img", { name: "示意图" })
    expect(img).toHaveAttribute("width", "320")
    expect(container.querySelector("[data-resize-container]")).toBeNull()
    expect(container.querySelector("[data-resize-handle]")).toBeNull()
  })

  it('非整数宽度（width="50%"）丢弃，回退自然尺寸', async () => {
    let editor: Editor | null = null
    render(
      <Harness
        mode="edit"
        content={`<p><img src="${SRC}" alt="示意图" width="50%"></p>`}
        onEditor={(instance) => {
          editor = instance
        }}
      />
    )

    await screen.findByRole("img", { name: "示意图" })
    await waitFor(() => {
      expect(imageNode(editor as Editor)?.attrs?.width).toBeNull()
      expect(editor?.getHTML()).not.toContain("width=")
    })
  })

  it("缩放写进节点属性：一次编辑、可撤销，JSON 与 HTML 同口径往返", async () => {
    let editor: Editor | null = null
    let updates = 0
    const { container } = render(
      <Harness
        mode="edit"
        content={`<p><img src="${SRC}" alt="示意图" width="320"></p>`}
        onEditor={(instance) => {
          editor = instance
        }}
        onUpdate={() => {
          updates += 1
        }}
      />
    )
    await screen.findByRole("img", { name: "示意图" })

    const instance = editor as unknown as Editor
    instance.commands.setNodeSelection(imagePosition(instance))
    instance.commands.updateAttributes("image", { width: 240, height: null })

    await waitFor(() => {
      expect(imageNode(instance)?.attrs?.width).toBe(240)
      expect(instance.getHTML()).toContain('width="240"')
    })
    // 计为一次编辑：编辑器 update 事件触发（保存页据此进入未保存状态）
    expect(updates).toBeGreaterThan(0)
    expect(imageNode(instance)?.attrs?.height).toBeNull()
    const img = container.querySelector(
      "figure[data-image-block] img"
    ) as HTMLImageElement
    expect(img.style.width).toBe("240px")

    // Ctrl+Z 回退到缩放前的宽度
    expect(instance.can().undo()).toBe(true)
    instance.commands.undo()
    await waitFor(() => {
      expect(imageNode(instance)?.attrs?.width).toBe(320)
    })

    // 由 HTML 再喂回编辑器：宽度仍是同一口径
    instance.commands.setContent(instance.getHTML())
    await waitFor(() => {
      expect(imageNode(instance)?.attrs?.width).toBe(320)
    })
  })

  it("未转存占位换成真图后，节点视图重建为可缩放视图", async () => {
    let editor: Editor | null = null
    const { container } = render(
      <Harness
        mode="edit"
        content={UNTRANSFERRED_HTML}
        onEditor={(instance) => {
          editor = instance
        }}
      />
    )
    expect(await screen.findByText("未转存的图片")).toBeInTheDocument()
    expect(container.querySelector("[data-resize-container]")).toBeNull()

    const instance = editor as unknown as Editor
    instance.commands.setNodeSelection(imagePosition(instance))
    instance.commands.updateAttributes("image", { src: UPLOADED })

    await waitFor(() => {
      expect(container.querySelector("[data-resize-container]")).not.toBeNull()
    })
    const img = container.querySelector(
      "figure[data-image-block] img"
    ) as HTMLImageElement
    expect(img.getAttribute("src")).toBe(UPLOADED)
    expect(screen.getByRole("img", { name: "架构图" })).toBe(img)
  })
})
