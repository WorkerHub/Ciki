import fs from "node:fs"
import path from "node:path"
import { Editor } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import { DefaultSidebar, Excalidraw } from "@excalidraw/excalidraw"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useEffect } from "react"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { EditorToolbar } from "@/editor/EditorToolbar"
import { createExtensions, type EditorMode } from "@/editor/extensions"
import { ReadView } from "@/editor/ReadView"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"

const SCENE_KEY = "pages/1b3e5a7d-890f-4e3b-b21c-4f8a9e0d1c2b.json"
const PREVIEW_KEY = "pages/7fa3c5b1-e221-4d1a-8c90-9f201b1a3e45.png"
const EXTRACTED_TEXT = "Architecture Diagram Text"
const CANVAS_HTML = `<img src="/api/files/${PREVIEW_KEY}" alt="${EXTRACTED_TEXT}" width="720" data-type="excalidraw" data-scene-key="${SCENE_KEY}" data-preview-key="${PREVIEW_KEY}">`

const editors: Editor[] = []

function cleanupEditors() {
  while (editors.length) {
    const ed = editors.pop()
    const el = ed?.options.element
    if (el instanceof Element) el.remove()
    ed?.destroy()
  }
}

function makeEditor(content: string, mode: EditorMode = "edit"): Editor {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    extensions: createExtensions(mode),
    content,
    editable: mode === "edit"
  })
  editors.push(editor)
  return editor
}

function Harness({
  content,
  mode = "edit",
  onEditor
}: {
  content: string
  mode?: EditorMode
  onEditor?: (editor: Editor) => void
}) {
  const editor = useEditor(
    {
      extensions: createExtensions(mode),
      content,
      editable: mode === "edit"
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

describe("Excalidraw TipTap 节点契约与解析/序列化", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  afterEach(() => {
    cleanupEditors()
  })

  it("1. HTML 解析：准确提取 sceneKey, previewKey, extractedText, width", () => {
    const editor = makeEditor(CANVAS_HTML)
    const json = editor.getJSON()
    const excalidrawNode = json.content?.find(
      (node) => node.type === "excalidraw"
    )

    expect(excalidrawNode).toBeDefined()
    expect(excalidrawNode?.attrs).toEqual({
      sceneKey: SCENE_KEY,
      previewKey: PREVIEW_KEY,
      extractedText: EXTRACTED_TEXT,
      width: 720
    })
  })

  it("2. 节点优先级：data-type=excalidraw 解析为 excalidraw 节点，普通图片解析为 image 节点", () => {
    const mixedHtml = `
      <p><img src="/api/files/pages/normal.png" alt="普通图片"></p>
      ${CANVAS_HTML}
    `
    const editor = makeEditor(mixedHtml)
    const json = editor.getJSON()

    const imageNode = json.content?.find((node) => node.type === "image")
    expect(imageNode?.type).toBe("image")

    const excalidrawNode = json.content?.find(
      (node) => node.type === "excalidraw"
    )
    expect(excalidrawNode?.type).toBe("excalidraw")
  })

  it("3. HTML 序列化：输出标准 <img> 载具结构与全部 data 属性", () => {
    const editor = makeEditor(CANVAS_HTML)
    const outputHtml = editor.getHTML()

    expect(outputHtml).toContain('data-type="excalidraw"')
    expect(outputHtml).toContain(`data-scene-key="${SCENE_KEY}"`)
    expect(outputHtml).toContain(`data-preview-key="${PREVIEW_KEY}"`)
    expect(outputHtml).toContain(`src="/api/files/${PREVIEW_KEY}"`)
    expect(outputHtml).toContain(`alt="${EXTRACTED_TEXT}"`)
    expect(outputHtml).toContain('width="720"')
  })

  it("4. 文字提取与搜索索引：renderText 使得 extractedText 正确并入 editor.getText()", () => {
    const editor = makeEditor(`
      <h1>系统设计</h1>
      ${CANVAS_HTML}
      <p>后续说明</p>
    `)

    const plainText = editor.getText({ blockSeparator: "\n" })
    expect(plainText).toContain("系统设计")
    expect(plainText).toContain(EXTRACTED_TEXT)
    expect(plainText).toContain("后续说明")
  })

  it("5. setExcalidraw 命令可插入空白或指定属性的画布块", () => {
    const editor = makeEditor("<p>段落</p>")
    act(() => {
      editor.commands.setExcalidraw({
        sceneKey: SCENE_KEY,
        previewKey: PREVIEW_KEY,
        extractedText: "新插入画布",
        width: 600
      })
    })

    const node = editor.getJSON().content?.find((n) => n.type === "excalidraw")
    expect(node).toBeDefined()
    expect(node?.attrs?.sceneKey).toBe(SCENE_KEY)
    expect(node?.attrs?.extractedText).toBe("新插入画布")
    expect(node?.attrs?.width).toBe(600)
  })
})

describe("Excalidraw 双态渲染", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  it("阅读态 (ReadView)：只渲染静态 <img> 预览图，不加载编辑手柄或弹窗", async () => {
    const { container } = render(<ReadView html={CANVAS_HTML} />)
    const img = await screen.findByRole("img", { name: EXTRACTED_TEXT })

    expect(img).toBeInTheDocument()
    expect(img).toHaveAttribute("src", `/api/files/${PREVIEW_KEY}`)
    expect(img).toHaveAttribute("data-type", "excalidraw")
    expect(img).toHaveAttribute("data-scene-key", SCENE_KEY)
    expect(img).toHaveAttribute("data-preview-key", PREVIEW_KEY)
    expect(img).toHaveAttribute("width", "720")

    // 阅读态不应有任何缩放手柄或编辑按钮
    expect(container.querySelector("[data-resize-handle]")).toBeNull()
    expect(screen.queryByRole("button", { name: "编辑画布" })).toBeNull()
  })

  it("编辑态：已有预览图时渲染可缩放预览图与「编辑画布」按钮", async () => {
    const { container } = render(<Harness mode="edit" content={CANVAS_HTML} />)
    expect(await screen.findByTestId("ready")).toHaveTextContent("yes")

    expect(screen.getByRole("button", { name: "编辑画布" })).toBeInTheDocument()
    expect(
      container.querySelector("figure[data-excalidraw-block]")
    ).toBeInTheDocument()
  })

  it("编辑态：空白画布块渲染占位卡片与「编辑画布」引导", async () => {
    const blankCanvasHtml = '<img data-type="excalidraw">'
    render(<Harness mode="edit" content={blankCanvasHtml} />)
    expect(await screen.findByTestId("ready")).toHaveTextContent("yes")

    expect(screen.getByText("空白画布")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "编辑画布" })).toBeInTheDocument()
  })
})

describe("工具栏「插入画布」动作", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  afterEach(() => {
    cleanupEditors()
  })

  it("工具栏包含「插入画布」按钮，点击后向编辑器插入空白画布节点", async () => {
    const user = userEvent.setup()
    const editor = makeEditor("<p>初始文本</p>")
    render(<EditorToolbar editor={editor} />)

    const insertBtn = screen.getByRole("button", { name: "插入画布" })
    expect(insertBtn).toBeInTheDocument()

    await user.click(insertBtn)

    const excalidrawNode = editor
      .getJSON()
      .content?.find((node) => node.type === "excalidraw")
    expect(excalidrawNode).toBeDefined()
    expect(excalidrawNode?.attrs?.sceneKey).toBe("")
    expect(excalidrawNode?.attrs?.previewKey).toBe("")
  })
})

describe("Excalidraw 画布挂载沙箱约束", () => {
  let modalRule: string | undefined

  beforeAll(() => {
    // 从 web/src/index.css 读取沙箱 CSS 规则并注入 JSDOM
    // 确保真实检验 index.css 中的 .wiki-excalidraw-modal 沙箱规则对 Excalidraw DOM 的样式约束
    const cssContent = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../index.css"),
      "utf-8"
    )
    modalRule = cssContent.match(
      /\.wiki-excalidraw-modal[\s\S]*?\{[\s\S]*?\}/
    )?.[0]
    if (modalRule) {
      const styleEl = document.createElement("style")
      styleEl.innerHTML = modalRule
      document.head.appendChild(styleEl)
    }
  })

  it("通过 DefaultSidebar.Trigger 覆盖默认图库触发按钮，不暴露外部图库入口", async () => {
    const { container } = render(
      <div
        className="wiki-excalidraw-modal"
        style={{ width: 800, height: 600 }}
      >
        <Excalidraw
          validateEmbeddable={false}
          UIOptions={{
            tools: { image: false }
          }}
        >
          <DefaultSidebar.Trigger
            title=""
            style={{ display: "none" }}
            className="hidden pointer-events-none"
          />
        </Excalidraw>
      </div>
    )

    await waitFor(() => {
      expect(container.querySelector(".LoadingMessage")).toBeNull()
    })

    // 校验不暴露任何图库触发文案与按钮
    const libraryTriggers = container.querySelectorAll(
      "[aria-label*='library' i], [title*='library' i], [title*='图库'], .sidebar-trigger__label"
    )
    expect(libraryTriggers.length).toBe(0)

    // 默认侧栏触发器具有 display: none 样式
    const trigger = container.querySelector(".default-sidebar-trigger")
    expect(trigger).toHaveStyle({ display: "none" })
  })

  it("当侧栏被 openSidebar 激活时，验证 .default-sidebar 侧栏在沙箱 CSS 下保持 display: none 隐藏", async () => {
    const { container } = render(
      <div
        className="wiki-excalidraw-modal"
        style={{ width: 800, height: 600 }}
      >
        <Excalidraw
          initialData={{
            appState: {
              openSidebar: { name: "default", tab: "library" }
            } as any
          }}
          validateEmbeddable={false}
          UIOptions={{
            tools: { image: false }
          }}
        >
          <DefaultSidebar.Trigger
            title=""
            style={{ display: "none" }}
            className="hidden pointer-events-none"
          />
        </Excalidraw>
      </div>
    )

    await waitFor(() => {
      expect(container.querySelector(".LoadingMessage")).toBeNull()
    })

    const sidebar = container.querySelector(".default-sidebar")
    expect(sidebar).toBeInTheDocument()
    // 验证承重 CSS: .wiki-excalidraw-modal .default-sidebar { display: none }
    // 确保即便侧栏被意外打开（如快捷键触发），其根容器在沙箱 CSS 下也为 display: none，彻底隔绝外部图库入口呈现
    expect(window.getComputedStyle(sidebar!).display).toBe("none")
    expect(sidebar).toHaveStyle({ display: "none" })
  })
})

describe("Excalidraw 弹窗 Portal 挂载与节点选区交互", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  afterEach(() => {
    cleanupEditors()
  })

  it("点击「编辑画布」时，全屏编辑器通过 createPortal 挂载到 document.body，彻底脱离 ProseMirror 容器", async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness mode="edit" content={CANVAS_HTML} />)
    expect(await screen.findByTestId("ready")).toHaveTextContent("yes")

    const editBtn = screen.getByRole("button", { name: "编辑画布" })
    await user.click(editBtn)

    await waitFor(() => {
      const modal = document.querySelector(".wiki-excalidraw-modal")
      expect(modal).toBeInTheDocument()
      expect(modal?.parentElement).toBe(document.body)
      expect(container.contains(modal)).toBe(false)
    })
  })

  it("点击画布预览图触发 mousedown 时，建立 NodeSelection 并触发编辑器聚焦", async () => {
    let ed: any = null
    const { container } = render(
      <Harness
        mode="edit"
        content={CANVAS_HTML}
        onEditor={(editor) => {
          ed = editor
        }}
      />
    )
    expect(await screen.findByTestId("ready")).toHaveTextContent("yes")

    const img = container.querySelector("img[data-type='excalidraw']")
    expect(img).toBeInTheDocument()

    act(() => {
      img?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 })
      )
    })

    expect(ed).not.toBeNull()
    expect(ed!.state.selection.toJSON().type).toBe("node")
    expect((ed!.state.selection as any).node?.type?.name).toBe("excalidraw")
  })
})
