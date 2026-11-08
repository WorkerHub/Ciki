import { describe, expect, it, vi } from "vitest"
import {
  dispatchBridgeHello,
  dispatchBridgeReady,
  dispatchCaptureRequest,
  filenameFromSource,
  IMAGE_BRIDGE_CAPTURED,
  IMAGE_BRIDGE_CAPTURE,
  IMAGE_BRIDGE_HELLO,
  IMAGE_BRIDGE_PLUGIN_HELLO,
  readCapturedDetail
} from "@/editor/bridge/contract"

/** 1×1 PNG，够过 data:image 白名单。 */
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="

const SRC = "https://confluence.example.com/download/attachments/1/arch.png"

function capturedEvent(detail: unknown): Event {
  return new CustomEvent(IMAGE_BRIDGE_CAPTURED, { detail })
}

function listen(eventName: string) {
  const listener = vi.fn()
  window.addEventListener(eventName, listener)
  return {
    listener,
    detail: () => (listener.mock.calls[0][0] as CustomEvent).detail,
    stop: () => window.removeEventListener(eventName, listener)
  }
}

describe("事件桥契约（页面派发侧）", () => {
  it("hello 带上待补抓清单", () => {
    const hello = listen(IMAGE_BRIDGE_HELLO)
    dispatchBridgeHello([SRC])
    expect(hello.detail()).toEqual({ sources: [SRC] })
    hello.stop()
  })

  it("capture 只带原 src", () => {
    const capture = listen(IMAGE_BRIDGE_CAPTURE)
    dispatchCaptureRequest(SRC)
    expect(capture.detail()).toEqual({ src: SRC })
    capture.stop()
  })

  it("plugin-hello 没有 detail 内容（插件报到）", () => {
    const ready = listen(IMAGE_BRIDGE_PLUGIN_HELLO)
    dispatchBridgeReady()
    expect(ready.detail()).toEqual({})
    ready.stop()
  })
})

describe("readCapturedDetail 校验插件递来的字节", () => {
  const valid = {
    src: SRC,
    dataUrl: PNG_DATA_URL,
    filename: "arch.png",
    contentType: "image/png"
  }

  it("合格时原样返回并归一化协议", () => {
    expect(readCapturedDetail(capturedEvent(valid))).toEqual(valid)
  })

  it("src 只认 http(s) 与根相对路径", () => {
    expect(
      readCapturedDetail(
        capturedEvent({ ...valid, src: "javascript:alert(1)" })
      )
    ).toBeNull()
    expect(
      readCapturedDetail(
        capturedEvent({ ...valid, src: "data:text/html;base64,PHNjcmlwdD4=" })
      )
    ).toBeNull()
    expect(
      readCapturedDetail(capturedEvent({ ...valid, src: "/download/a.png" }))
    ).toMatchObject({ src: "/download/a.png" })
  })

  it("dataUrl 只认 data:image 白名单，拒 svg 与文本", () => {
    for (const dataUrl of [
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:text/html;base64,PHNjcmlwdD4=",
      "/api/files/0f3c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b.png",
      ""
    ]) {
      expect(
        readCapturedDetail(capturedEvent({ ...valid, dataUrl }))
      ).toBeNull()
    }
  })

  it("contentType 必须在上传白名单里", () => {
    expect(
      readCapturedDetail(
        capturedEvent({ ...valid, contentType: "image/svg+xml" })
      )
    ).toBeNull()
    expect(
      readCapturedDetail(
        capturedEvent({
          ...valid,
          dataUrl: PNG_DATA_URL.replace("image/png", "image/webp"),
          contentType: "image/webp"
        })
      )
    ).toMatchObject({ contentType: "image/webp" })
  })

  it("dataUrl 与 contentType 必须描述同一份字节", () => {
    expect(
      readCapturedDetail(
        capturedEvent({
          ...valid,
          dataUrl: PNG_DATA_URL,
          contentType: "image/webp"
        })
      )
    ).toBeNull()
    expect(
      readCapturedDetail(
        capturedEvent({
          ...valid,
          dataUrl: PNG_DATA_URL.replace("image/png", "image/jpeg")
        })
      )
    ).toBeNull()
    // image/jpg 与 image/jpeg 是同一个类型，不算冲突
    expect(
      readCapturedDetail(
        capturedEvent({
          ...valid,
          dataUrl: PNG_DATA_URL.replace("image/png", "image/jpg"),
          contentType: "image/jpeg"
        })
      )
    ).toMatchObject({ contentType: "image/jpeg" })
  })

  it("字段缺失或 detail 不是对象时返回 null", () => {
    expect(readCapturedDetail(capturedEvent(null))).toBeNull()
    expect(readCapturedDetail(capturedEvent("x"))).toBeNull()
    expect(readCapturedDetail(capturedEvent({ ...valid, src: 42 }))).toBeNull()
    expect(readCapturedDetail(new Event("x"))).toBeNull()
  })

  it("文件名缺省从原图地址推，去掉路径分隔符", () => {
    expect(
      readCapturedDetail(capturedEvent({ ...valid, filename: "" }))
    ).toMatchObject({ filename: "arch.png" })
    expect(
      readCapturedDetail(
        capturedEvent({ ...valid, filename: "../../etc/passwd" })
      )
    ).toMatchObject({ filename: "passwd" })
  })

  it("地址没有扩展名时按 contentType 补一个", () => {
    expect(filenameFromSource("https://x.test/a/b", "image/webp")).toBe(
      "b.webp"
    )
    expect(filenameFromSource("https://x.test/", "image/gif")).toBe("image.gif")
  })
})
