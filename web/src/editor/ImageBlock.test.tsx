import { EditorContent, useEditor } from "@tiptap/react"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useEffect } from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { Editor } from "@tiptap/core"
import {
  IMAGE_BRIDGE_CAPTURE,
  IMAGE_BRIDGE_CAPTURED
} from "@/editor/bridge/contract"
import { UntransferredImageBridge } from "@/editor/bridge/extension"
import { createExtensions } from "@/editor/extensions"
import { uploadImage } from "@/lib/upload"
import { useImageBridgeStore } from "@/stores/image-bridge"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"

vi.mock("@/lib/upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/upload")>()
  return { ...actual, uploadImage: vi.fn() }
})

const SRC = "https://confluence.example.com/download/attachments/1/arch.png"
const UPLOADED = "/api/files/0f3c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b.png"

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="

const UNTRANSFERRED_HTML = `<p><img alt="架构图" data-original-src="${SRC}" data-confluence-img="true"></p>`

function Harness({
  content,
  onEditor
}: {
  content: string
  onEditor?: (editor: Editor) => void
}) {
  const editor = useEditor({
    extensions: [...createExtensions("edit"), UntransferredImageBridge],
    content
  })
  useEffect(() => {
    if (editor && onEditor) onEditor(editor)
  }, [editor, onEditor])
  return (
    <div>
      <EditorContent editor={editor} />
      <span data-testid="ready">{editor ? "yes" : "no"}</span>
    </div>
  )
}

function stubDataUrlFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const base64 = String(input).split(",")[1] ?? ""
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      return {
        ok: true,
        blob: async () => new Blob([bytes], { type: "image/png" })
      } as unknown as Response
    })
  )
}

describe("未转存图片占位的两条出路", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  afterEach(() => {
    useImageBridgeStore.getState().reset()
    vi.unstubAllGlobals()
    vi.mocked(uploadImage).mockReset()
  })

  it("编辑态同时给「重试自动转存」与「上传替换」", async () => {
    render(<Harness content={UNTRANSFERRED_HTML} />)
    expect(await screen.findByText("未转存的图片")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "重试自动转存" })
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "上传替换" })).toBeInTheDocument()
  })

  it("点「重试自动转存」派发 capture，并在等插件时显示补抓中", async () => {
    const listener = vi.fn()
    window.addEventListener(IMAGE_BRIDGE_CAPTURE, listener)
    render(<Harness content={UNTRANSFERRED_HTML} />)
    const retry = await screen.findByRole("button", { name: "重试自动转存" })

    await userEvent.click(retry)

    expect(listener).toHaveBeenCalledTimes(1)
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      src: SRC
    })
    const pending = await screen.findByRole("button", { name: "补抓中…" })
    expect(pending).toBeDisabled()
    window.removeEventListener(IMAGE_BRIDGE_CAPTURE, listener)
  })

  it("点重试后插件如约回话：占位换成图片，补抓中与错误都收掉", async () => {
    stubDataUrlFetch()
    vi.mocked(uploadImage).mockResolvedValue({
      key: "files/arch.png",
      url: UPLOADED,
      contentType: "image/png",
      size: 70
    })
    render(<Harness content={UNTRANSFERRED_HTML} />)

    await userEvent.click(
      await screen.findByRole("button", { name: "重试自动转存" })
    )
    expect(
      await screen.findByRole("button", { name: "补抓中…" })
    ).toBeDisabled()

    act(() => {
      window.dispatchEvent(
        new CustomEvent(IMAGE_BRIDGE_CAPTURED, {
          detail: {
            src: SRC,
            dataUrl: PNG_DATA_URL,
            filename: "arch.png",
            contentType: "image/png"
          }
        })
      )
    })

    await waitFor(() => {
      expect(screen.queryByText("未转存的图片")).toBeNull()
    })
    expect(screen.getByRole("img", { name: "架构图" })).toHaveAttribute(
      "src",
      UPLOADED
    )
    const state = useImageBridgeStore.getState()
    expect(state.pending[SRC]).toBeUndefined()
    expect(state.errors[SRC]).toBeUndefined()
  })

  it("插件递来字节后占位换成真正的图片", async () => {
    stubDataUrlFetch()
    vi.mocked(uploadImage).mockResolvedValue({
      key: "files/arch.png",
      url: UPLOADED,
      contentType: "image/png",
      size: 70
    })
    render(<Harness content={UNTRANSFERRED_HTML} />)
    expect(await screen.findByText("未转存的图片")).toBeInTheDocument()

    act(() => {
      window.dispatchEvent(
        new CustomEvent(IMAGE_BRIDGE_CAPTURED, {
          detail: {
            src: SRC,
            dataUrl: PNG_DATA_URL,
            filename: "arch.png",
            contentType: "image/png"
          }
        })
      )
    })

    await waitFor(() => {
      expect(screen.queryByText("未转存的图片")).toBeNull()
    })
    expect(screen.getByRole("img", { name: "架构图" })).toHaveAttribute(
      "src",
      UPLOADED
    )
  })

  it("补抓失败时错误就地显示，标黄保留", async () => {
    render(<Harness content={UNTRANSFERRED_HTML} />)
    expect(await screen.findByText("未转存的图片")).toBeInTheDocument()

    act(() => {
      useImageBridgeStore
        .getState()
        .fail(SRC, "没等到 Ciki 插件补抓，请手动上传替换。")
    })

    expect(
      await screen.findByText("没等到 Ciki 插件补抓，请手动上传替换。")
    ).toBeInTheDocument()
    expect(screen.getByText("未转存的图片")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "重试自动转存" })).toBeEnabled()
  })
})
