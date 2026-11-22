import { exportToBlob } from "@excalidraw/excalidraw"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ExcalidrawModal } from "./ExcalidrawModal"
import { api } from "@/lib/api"

// Mock @excalidraw/excalidraw components and utilities
let mockExcalidrawAPI: any = null
let lastExcalidrawProps: any = null

vi.mock("@excalidraw/excalidraw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@excalidraw/excalidraw")>()
  return {
    ...actual,
    Excalidraw: (props: any) => {
      lastExcalidrawProps = props
      const { excalidrawAPI, initialData, children } = props
      mockExcalidrawAPI = {
        getSceneElements: vi.fn(() => [
          { id: "1", type: "rectangle", text: "Box" },
          { id: "2", type: "text", text: "Hello Canvas" }
        ]),
        getAppState: vi.fn(() => ({
          theme: "light",
          exportScale: 2
        })),
        getFiles: vi.fn(() => ({}))
      }
      // Simulate registering the API ref
      setTimeout(() => excalidrawAPI?.(mockExcalidrawAPI), 0)
      return (
        <div data-testid="mock-excalidraw">
          <span data-testid="initial-elements-count">
            {initialData?.elements?.length ?? 0}
          </span>
          {children}
        </div>
      )
    },
    DefaultSidebar: Object.assign(() => null, {
      Trigger: ({ style, className }: any) => (
        <div
          data-testid="mock-default-sidebar-trigger"
          style={style}
          className={className}
        />
      ),
      TabTriggers: () => null
    }),
    getTextFromElements: vi.fn(() => "Hello Canvas\nBox"),
    serializeAsJSON: vi.fn(() => JSON.stringify({ elements: [] })),
    exportToBlob: vi.fn(
      async () =>
        new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" })
    ),
    MainMenu: Object.assign(() => null, {
      DefaultItems: {
        ClearCanvas: () => null,
        ChangeCanvasBackground: () => null,
        Help: () => null
      }
    }),
    WelcomeScreen: Object.assign(() => null, {
      Hints: {
        ToolbarHint: () => null,
        MenuHint: () => null,
        HelpHint: () => null
      }
    })
  }
})

describe("ExcalidrawModal 全屏画布编辑器", () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.mocked(exportToBlob).mockClear()
    vi.spyOn(api, "upload").mockImplementation(async (file: File) => {
      if (file.name.endsWith(".json")) {
        return {
          key: "pages/11111111-2222-3333-4444-555555555555.json",
          url: "/api/files/pages/11111111-2222-3333-4444-555555555555.json",
          contentType: "application/json",
          size: file.size
        }
      }
      return {
        key: "pages/66666666-7777-8888-9999-000000000000.png",
        url: "/api/files/pages/66666666-7777-8888-9999-000000000000.png",
        contentType: "image/png",
        size: file.size
      }
    })
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("1. 渲染弹窗标题与操作按钮", async () => {
    render(<ExcalidrawModal onClose={vi.fn()} onSave={vi.fn()} />)
    expect(screen.getByText("画布编辑器")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument()
    expect(await screen.findByTestId("mock-excalidraw")).toBeInTheDocument()
  })

  it("2. 点击取消或按 Esc 触发 onClose 回调", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ExcalidrawModal onClose={onClose} onSave={vi.fn()} />)

    const cancelBtn = screen.getByRole("button", { name: "取消" })
    await user.click(cancelBtn)
    expect(onClose).toHaveBeenCalledTimes(1)

    // 测试 Esc 键
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it("3. 若存在 sceneKey，通过 /api/files 加载并恢复场景数据", async () => {
    const fakeScene = {
      elements: [{ id: "elem-1", type: "text", text: "已存在的元素" }],
      appState: { viewBackgroundColor: "#ffffff" }
    }

    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => fakeScene
    })) as unknown as typeof fetch

    render(
      <ExcalidrawModal
        sceneKey="pages/12345678-1234-1234-1234-1234567890ab.json"
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/files/pages/12345678-1234-1234-1234-1234567890ab.json"
    )

    const count = await screen.findByTestId("initial-elements-count")
    expect(count).toHaveTextContent("1")
  })

  it("4. 若 sceneKey 加载失败，兜底以空白画布展现并提示错误，不阻断编辑器使用", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found"
    })) as unknown as typeof fetch

    render(
      <ExcalidrawModal
        sceneKey="pages/not-found.json"
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )

    const count = await screen.findByTestId("initial-elements-count")
    expect(count).toHaveTextContent("0")
  })

  it("5. 点击保存后提取文字、序列化 JSON、导出 2x 预览 PNG 并并行上传，回调 onSave", async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const onClose = vi.fn()

    render(<ExcalidrawModal onClose={onClose} onSave={onSave} />)

    await screen.findByTestId("mock-excalidraw")
    const saveBtn = screen.getByRole("button", { name: "保存" })

    await user.click(saveBtn)

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        sceneKey: "pages/11111111-2222-3333-4444-555555555555.json",
        previewKey: "pages/66666666-7777-8888-9999-000000000000.png",
        extractedText: "Hello Canvas\nBox"
      })
    })

    expect(api.upload).toHaveBeenCalledTimes(2)

    expect(exportToBlob).toHaveBeenCalledTimes(1)
    const exportCall = vi.mocked(exportToBlob).mock.calls[0][0]
    expect(exportCall.appState).toMatchObject({
      exportScale: 2,
      exportBackground: true
    })
    expect(exportCall.mimeType).toBe("image/png")
    expect(exportCall.getDimensions).toBeTypeOf("function")
    expect(exportCall.getDimensions?.(100, 200)).toEqual({
      width: 200,
      height: 400,
      scale: 2
    })
  })

  it("6. 满足红线与安全约束：validateEmbeddable 关闭、禁用图片工具、覆盖隐藏图库侧栏触发器", async () => {
    render(<ExcalidrawModal onClose={vi.fn()} onSave={vi.fn()} />)
    await screen.findByTestId("mock-excalidraw")

    // B2: 禁用 embeddable iframe，防止产生外部请求与数据丢失
    expect(lastExcalidrawProps.validateEmbeddable).toBe(false)

    // S1: 禁用图片工具，防止用户插入非白名单图片导致保存静默丢失
    expect(lastExcalidrawProps.UIOptions?.tools?.image).toBe(false)

    // B1: 覆盖图库触发器，确保不暴露外部图库浏览与发布入口
    const trigger = screen.getByTestId("mock-default-sidebar-trigger")
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveStyle({ display: "none" })
  })
})
