import { Editor } from "@tiptap/core"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi
} from "vitest"
import {
  dispatchBridgeReady,
  IMAGE_BRIDGE_CAPTURED,
  IMAGE_BRIDGE_HELLO
} from "@/editor/bridge/contract"
import { UntransferredImageBridge } from "@/editor/bridge/extension"
import { createExtensions } from "@/editor/extensions"
import { ApiError } from "@/lib/api"
import { uploadImage } from "@/lib/upload"
import { useImageBridgeStore } from "@/stores/image-bridge"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"

vi.mock("@/lib/upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/upload")>()
  return { ...actual, uploadImage: vi.fn() }
})

const SRC = "https://confluence.example.com/download/attachments/1/arch.png"
const OTHER_SRC =
  "https://confluence.example.com/download/attachments/1/flow.png"
const UPLOADED = "/api/files/0f3c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b.png"

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="

/** jsdom 的 File 不认 Node 的 Blob，所以把 dataUrl 解码 stub 成同 realm 的 Blob。 */
function stubDataUrlFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const base64 = String(input).split(",")[1] ?? ""
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    return {
      ok: true,
      blob: async () => new Blob([bytes], { type: "image/png" })
    } as unknown as Response
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function untransferredHtml(...sources: string[]): string {
  return sources
    .map(
      (src, index) =>
        `<p><img alt="图 ${index + 1}" data-original-src="${src}" data-confluence-img="true"></p>`
    )
    .join("")
}

function imageAttrs(editor: Editor): Record<string, unknown>[] {
  const attrs: Record<string, unknown>[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === "image") attrs.push(node.attrs)
  })
  return attrs
}

function dispatchCaptured(detail: Record<string, unknown>): void {
  window.dispatchEvent(
    new CustomEvent(IMAGE_BRIDGE_CAPTURED, { detail: { ...detail } })
  )
}

function captureDetail(src: string) {
  return {
    src,
    dataUrl: PNG_DATA_URL,
    filename: "arch.png",
    contentType: "image/png"
  }
}

describe("补抓事件桥：插件递字节 → TipTap 模型里替换", () => {
  let editor: Editor | null = null
  let host: HTMLDivElement
  let hello: Mock<(detail: unknown) => void>
  const onHello = (event: Event) => {
    hello((event as CustomEvent).detail)
  }

  beforeAll(() => {
    installTiptapJsdomShims()
  })

  beforeEach(() => {
    useImageBridgeStore.getState().reset()
    vi.mocked(uploadImage).mockReset()
    vi.mocked(uploadImage).mockResolvedValue({
      key: "files/arch.png",
      url: UPLOADED,
      contentType: "image/png",
      size: 70
    })
    stubDataUrlFetch()
    hello = vi.fn<(detail: unknown) => void>()
    window.addEventListener(IMAGE_BRIDGE_HELLO, onHello)
    host = document.createElement("div")
    document.body.appendChild(host)
  })

  afterEach(() => {
    editor?.destroy()
    editor = null
    host.remove()
    window.removeEventListener(IMAGE_BRIDGE_HELLO, onHello)
    useImageBridgeStore.getState().reset()
    vi.unstubAllGlobals()
  })

  // TipTap 在 setTimeout(0) 里才 emit create，扩展的 onCreate 要到那一刻才跑
  const createEditor = async (html: string) => {
    editor = new Editor({
      element: host,
      extensions: [...createExtensions("edit"), UntransferredImageBridge],
      content: html
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    return editor
  }

  it("挂载时把待补抓清单喊一遍，插件报到后再喊一遍", async () => {
    await createEditor(untransferredHtml(SRC))
    expect(hello).toHaveBeenCalledTimes(1)
    expect(hello.mock.calls[0][0]).toEqual({ sources: [SRC] })

    dispatchBridgeReady()
    expect(hello).toHaveBeenCalledTimes(2)
  })

  it("没有未转存图时不发清单", async () => {
    await createEditor('<p><img src="/api/files/abc.png" alt="本站图"></p>')
    expect(hello).not.toHaveBeenCalled()
  })

  it("正文变化后去抖再喊一次清单（当场粘贴进来的标黄图也能补抓）", async () => {
    const active = await createEditor("<p>空正文</p>")
    expect(hello).not.toHaveBeenCalled()

    active.commands.insertContent(untransferredHtml(SRC))

    await vi.waitFor(() => {
      expect(hello).toHaveBeenCalled()
    })
    expect(hello.mock.calls.at(-1)?.[0]).toEqual({ sources: [SRC] })
  })

  it("插件递来字节后上传换掉节点，标黄与 data-original-src 一起消失", async () => {
    const active = await createEditor(untransferredHtml(SRC))

    dispatchCaptured(captureDetail(SRC))

    await vi.waitFor(() => {
      expect(imageAttrs(active)[0]).toMatchObject({
        src: UPLOADED,
        originalSrc: null,
        confluenceImg: false,
        alt: "图 1"
      })
    })
    expect(uploadImage).toHaveBeenCalledTimes(1)
    const file = vi.mocked(uploadImage).mock.calls[0][0]
    expect(file.name).toBe("arch.png")
    expect(file.type).toBe("image/png")
    expect(active.getHTML()).toContain(`src="${UPLOADED}"`)
    expect(active.getHTML()).not.toContain("data-confluence-img")
    expect(useImageBridgeStore.getState().pending[SRC]).toBeUndefined()
  })

  it("同一个 src 出现多次：只上传一次，一个事务全部替换", async () => {
    const active = await createEditor(untransferredHtml(SRC, SRC))
    let transactions = 0
    active.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) transactions += 1
    })

    dispatchCaptured(captureDetail(SRC))

    await vi.waitFor(() => {
      const attrs = imageAttrs(active)
      expect(attrs).toHaveLength(2)
      expect(attrs.every((attr) => attr.src === UPLOADED)).toBe(true)
    })
    expect(uploadImage).toHaveBeenCalledTimes(1)
    expect(transactions).toBe(1)
  })

  it("替换进 undo 历史：撤销回到标黄", async () => {
    const active = await createEditor(untransferredHtml(SRC))

    dispatchCaptured(captureDetail(SRC))
    await vi.waitFor(() => {
      expect(imageAttrs(active)[0]?.src).toBe(UPLOADED)
    })

    active.commands.undo()
    expect(imageAttrs(active)[0]).toMatchObject({
      src: null,
      originalSrc: SRC,
      confluenceImg: true
    })
  })

  it("点了重试（pending 已置位）后插件回话仍会走上传，不被当成重复投递", async () => {
    const active = await createEditor(untransferredHtml(SRC))
    // 用户点「重试自动转存」：先立 pending，再派发 capture
    useImageBridgeStore.getState().requestCapture(SRC)
    expect(useImageBridgeStore.getState().pending[SRC]).toBe(true)

    dispatchCaptured(captureDetail(SRC))

    await vi.waitFor(() => {
      expect(imageAttrs(active)[0]?.src).toBe(UPLOADED)
    })
    expect(uploadImage).toHaveBeenCalledTimes(1)
    const state = useImageBridgeStore.getState()
    expect(state.pending[SRC]).toBeUndefined()
    expect(state.errors[SRC]).toBeUndefined()
  })

  it("文档里没有这个 src 的节点：不替不存在的图上传", async () => {
    await createEditor(untransferredHtml(SRC))
    dispatchCaptured(captureDetail(OTHER_SRC))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(uploadImage).not.toHaveBeenCalled()
  })

  it("危险协议的 src 直接丢弃", async () => {
    await createEditor(untransferredHtml(SRC))
    dispatchCaptured({
      ...captureDetail(SRC),
      src: "javascript:alert(1)"
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(uploadImage).not.toHaveBeenCalled()
  })

  it("上传失败：标黄保留，错误按 src 记在占位上", async () => {
    const active = await createEditor(untransferredHtml(SRC))
    vi.mocked(uploadImage).mockRejectedValue(
      new ApiError(413, "too large", "FILE_TOO_LARGE")
    )

    dispatchCaptured(captureDetail(SRC))

    await vi.waitFor(() => {
      expect(useImageBridgeStore.getState().errors[SRC]).toBe(
        "图片超过 10MB，请压缩后再上传。"
      )
    })
    expect(imageAttrs(active)[0]).toMatchObject({
      src: null,
      originalSrc: SRC,
      confluenceImg: true
    })
    expect(useImageBridgeStore.getState().pending[SRC]).toBeUndefined()
  })
})
