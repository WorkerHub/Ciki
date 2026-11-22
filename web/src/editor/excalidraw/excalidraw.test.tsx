import fs from "node:fs"
import path from "node:path"
import { Editor } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import { DefaultSidebar, Excalidraw } from "@excalidraw/excalidraw"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useEffect } from "react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { EditorToolbar } from "@/editor/EditorToolbar"
import {
  MIN_EXCALIDRAW_PREVIEW_HEIGHT,
  MIN_EXCALIDRAW_PREVIEW_WIDTH,
  syncExcalidrawAttributes
} from "@/editor/excalidraw/ResizableExcalidraw"
import { createExtensions, type EditorMode } from "@/editor/extensions"
import { MIN_IMAGE_WIDTH } from "@/editor/image-attributes"
import { ReadView } from "@/editor/ReadView"
import { api, pagesApi } from "@/lib/api"
import { exportSceneToBlob } from "./export"
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

  it("空画布或未设宽度时对齐 MIN_IMAGE_WIDTH (48px) 保底，设宽后清除 minWidth 不钳制缩放", () => {
    expect(MIN_EXCALIDRAW_PREVIEW_WIDTH).toBe(MIN_IMAGE_WIDTH)
    expect(MIN_EXCALIDRAW_PREVIEW_HEIGHT).toBe(MIN_IMAGE_WIDTH)

    const img = document.createElement("img")
    // 1. 未指定 width（width === null）
    syncExcalidrawAttributes(img, { previewKey: PREVIEW_KEY })
    expect(img.style.minWidth).toBe(`${MIN_IMAGE_WIDTH}px`)
    expect(img.style.minHeight).toBe(`${MIN_IMAGE_WIDTH}px`)
    expect(img.style.width).toBe("")

    // 2. 指定已缩放到 48px（MIN_IMAGE_WIDTH）
    syncExcalidrawAttributes(img, {
      previewKey: PREVIEW_KEY,
      width: MIN_IMAGE_WIDTH
    })
    expect(img.style.width).toBe(`${MIN_IMAGE_WIDTH}px`)
    expect(img.style.minWidth).toBe("")
    expect(img.style.minHeight).toBe("")
  })

  it("exportSceneToBlob 能够执行", async () => {
    const blob = await exportSceneToBlob({
      elements: [
        {
          id: "rect-1",
          type: "rectangle",
          x: 10,
          y: 10,
          width: 100,
          height: 100
        }
      ]
    })
    expect(blob).toBeInstanceOf(Blob)
    const url = URL.createObjectURL(blob)
    expect(url).toMatch(/^blob:/)
    URL.revokeObjectURL(url)
  })
})

describe("画布阅读态现场渲染与回填触发 (Todo #61)", () => {
  const MOCK_SCENE_DATA = {
    elements: [
      {
        id: "rect-1",
        type: "rectangle",
        x: 10,
        y: 10,
        width: 120,
        height: 80,
        strokeColor: "#1e1e1e",
        backgroundColor: "#e03131",
        fillStyle: "solid",
        strokeWidth: 2
      }
    ],
    appState: {
      viewBackgroundColor: "#ffffff"
    }
  }

  const NO_PREVIEW_CANVAS_HTML = `<img data-type="excalidraw" data-scene-key="${SCENE_KEY}" alt="${EXTRACTED_TEXT}" width="640">`

  beforeAll(() => {
    installTiptapJsdomShims()
  })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("1. 缺失 previewKey 时阅读态先展示 Loading，拉取场景后现场渲染出 2x 预览并以 Object URL 展示", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input)
      if (url.includes(SCENE_KEY)) {
        return new Response(JSON.stringify(MOCK_SCENE_DATA), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      }
      return new Response("Not found", { status: 404 })
    })

    const uploadSpy = vi.spyOn(api, "upload")
    const canvasPreviewSpy = vi.spyOn(pagesApi, "canvasPreview")

    const { container } = render(
      <ReadView html={NO_PREVIEW_CANVAS_HTML} canWrite={false} />
    )

    // 应先进入 loading 态
    expect(container.querySelector("[data-canvas-loading]")).toBeInTheDocument()

    // 现场渲染完成，出现 <img>
    const img = await screen.findByRole("img", { name: EXTRACTED_TEXT })
    expect(img).toBeInTheDocument()
    expect(img.getAttribute("src")).toMatch(/^blob:/)
    expect(img).toHaveAttribute("data-type", "excalidraw")
    expect(img).toHaveAttribute("data-scene-key", SCENE_KEY)
    expect(img).toHaveAttribute("width", "640")

    // 验证场景请求触发且携带会话 cookie 凭据
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/files/${SCENE_KEY}`,
      expect.objectContaining({ credentials: "include" })
    )

    // 无写权限时：仅内存现场渲染，绝不触发上传或回填 API
    expect(uploadSpy).not.toHaveBeenCalled()
    expect(canvasPreviewSpy).not.toHaveBeenCalled()
  })

  it("2. 有编辑权限 (canWrite=true, pageId 存在) 时，现场渲染后自动上传 PNG 并调用 canvasPreview 回填，切为静态预览图", async () => {
    const NEW_PREVIEW_KEY = "pages/newly-rendered-preview-key.png"
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input)
      if (url.includes(SCENE_KEY)) {
        return new Response(JSON.stringify(MOCK_SCENE_DATA), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      }
      return new Response("Not found", { status: 404 })
    })

    const uploadSpy = vi.spyOn(api, "upload").mockResolvedValue({
      key: NEW_PREVIEW_KEY,
      url: `/api/files/${NEW_PREVIEW_KEY}`,
      contentType: "image/png",
      size: 2048
    })

    const canvasPreviewSpy = vi.spyOn(pagesApi, "canvasPreview").mockResolvedValue({
      ok: true,
      status: "updated",
      sceneKey: SCENE_KEY,
      previewKey: NEW_PREVIEW_KEY
    })

    render(
      <ReadView html={NO_PREVIEW_CANVAS_HTML} pageId={88} canWrite={true} />
    )

    // 等待回填完成并切换为静态预览图
    await waitFor(() => {
      const img = screen.getByRole("img", { name: EXTRACTED_TEXT })
      expect(img).toHaveAttribute("src", `/api/files/${NEW_PREVIEW_KEY}`)
      expect(img).toHaveAttribute("data-preview-key", NEW_PREVIEW_KEY)
    })

    // 验证上传参数
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    const uploadedFile = uploadSpy.mock.calls[0][0]
    expect(uploadedFile).toBeInstanceOf(File)
    expect(uploadedFile.name).toBe("preview.png")
    expect(uploadedFile.type).toBe("image/png")

    // 验证调用回填端点
    expect(canvasPreviewSpy).toHaveBeenCalledWith(88, {
      sceneKey: SCENE_KEY,
      previewKey: NEW_PREVIEW_KEY
    })
  })

  it("2.1 并发回填收到 already_filled 状态时采用服务端已保存的 previewKey", async () => {
    const SERVER_PREVIEW_KEY = "pages/server-first-winner.png"
    const LOCAL_UPLOAD_KEY = "pages/local-loser.png"
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input)
      if (url.includes(SCENE_KEY)) {
        return new Response(JSON.stringify(MOCK_SCENE_DATA), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      }
      return new Response("Not found", { status: 404 })
    })

    vi.spyOn(api, "upload").mockResolvedValue({
      key: LOCAL_UPLOAD_KEY,
      url: `/api/files/${LOCAL_UPLOAD_KEY}`,
      contentType: "image/png",
      size: 2048
    })

    vi.spyOn(pagesApi, "canvasPreview").mockResolvedValue({
      ok: true,
      status: "already_filled",
      sceneKey: SCENE_KEY,
      previewKey: SERVER_PREVIEW_KEY
    })

    render(
      <ReadView html={NO_PREVIEW_CANVAS_HTML} pageId={88} canWrite={true} />
    )

    await waitFor(() => {
      const img = screen.getByRole("img", { name: EXTRACTED_TEXT })
      expect(img).toHaveAttribute("src", `/api/files/${SERVER_PREVIEW_KEY}`)
      expect(img).toHaveAttribute("data-preview-key", SERVER_PREVIEW_KEY)
    })
  })

  it("3. 回填 API 异常时不阻断现场渲染的图片展示（优雅降级）", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input)
      if (url.includes(SCENE_KEY)) {
        return new Response(JSON.stringify(MOCK_SCENE_DATA), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      }
      return new Response("Not found", { status: 404 })
    })

    vi.spyOn(api, "upload").mockRejectedValue(new Error("Network upload failure"))
    const canvasPreviewSpy = vi.spyOn(pagesApi, "canvasPreview")

    render(
      <ReadView html={NO_PREVIEW_CANVAS_HTML} pageId={88} canWrite={true} />
    )

    const img = await screen.findByRole("img", { name: EXTRACTED_TEXT })
    expect(img).toBeInTheDocument()
    // 上传失败后，内存渲染图依然正常展示为 Object URL
    expect(img.getAttribute("src")).toMatch(/^blob:/)
    expect(canvasPreviewSpy).not.toHaveBeenCalled()
  })

  it("4. 场景数据拉取失败时展示降级提示，不引发未捕获异常", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404, statusText: "Not Found" })
    )

    render(
      <ReadView html={NO_PREVIEW_CANVAS_HTML} canWrite={false} />
    )

    // 应展示失败文字或 extractedText
    const fallback = await screen.findByText(EXTRACTED_TEXT)
    expect(fallback).toBeInTheDocument()
  })

  it("5. 已有 previewKey 的老画布块直接走静态图，不发场景拉取请求也不触发回填", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const uploadSpy = vi.spyOn(api, "upload")
    const canvasPreviewSpy = vi.spyOn(pagesApi, "canvasPreview")

    render(
      <ReadView html={CANVAS_HTML} pageId={88} canWrite={true} />
    )

    const img = await screen.findByRole("img", { name: EXTRACTED_TEXT })
    expect(img).toBeInTheDocument()
    expect(img).toHaveAttribute("src", `/api/files/${PREVIEW_KEY}`)

    // 绝不对已有 previewKey 的画布拉取 scene 或触发回填
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(uploadSpy).not.toHaveBeenCalled()
    expect(canvasPreviewSpy).not.toHaveBeenCalled()
  })
})
