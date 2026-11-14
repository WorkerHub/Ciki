import { afterEach, describe, expect, it, vi } from "vitest"
import { IMAGE_BRIDGE_CAPTURE } from "@/editor/bridge/contract"
import {
  CAPTURE_TIMEOUT,
  CAPTURE_TIMEOUT_MS,
  useImageBridgeStore
} from "@/stores/image-bridge"

const SRC = "https://confluence.example.com/download/attachments/1/arch.png"

describe("补抓状态（按原图地址记）", () => {
  afterEach(() => {
    useImageBridgeStore.getState().reset()
    vi.useRealTimers()
  })

  it("点重试：立 pending、清旧错误、派发 capture", () => {
    const listener = vi.fn()
    window.addEventListener(IMAGE_BRIDGE_CAPTURE, listener)
    useImageBridgeStore.getState().fail(SRC, "上一轮失败")

    useImageBridgeStore.getState().requestCapture(SRC)

    expect(listener).toHaveBeenCalledTimes(1)
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      src: SRC
    })
    const state = useImageBridgeStore.getState()
    expect(state.pending[SRC]).toBe(true)
    expect(state.errors[SRC]).toBeUndefined()
    window.removeEventListener(IMAGE_BRIDGE_CAPTURE, listener)
  })

  it("15 秒没等到插件就落一条错误、pending 收掉", () => {
    vi.useFakeTimers()
    window.addEventListener(IMAGE_BRIDGE_CAPTURE, () => {})

    useImageBridgeStore.getState().requestCapture(SRC)
    vi.advanceTimersByTime(CAPTURE_TIMEOUT_MS - 1)
    expect(useImageBridgeStore.getState().errors[SRC]).toBeUndefined()

    vi.advanceTimersByTime(1)
    const state = useImageBridgeStore.getState()
    expect(state.pending[SRC]).toBeUndefined()
    expect(state.errors[SRC]).toBe(CAPTURE_TIMEOUT)
  })

  it("成功或失败都会收掉 pending，成功同时清错误", () => {
    useImageBridgeStore.getState().markPending(SRC)
    useImageBridgeStore.getState().succeed(SRC)
    expect(useImageBridgeStore.getState().pending[SRC]).toBeUndefined()

    useImageBridgeStore.getState().markPending(SRC)
    useImageBridgeStore.getState().fail(SRC, "上传失败")
    const state = useImageBridgeStore.getState()
    expect(state.pending[SRC]).toBeUndefined()
    expect(state.errors[SRC]).toBe("上传失败")
  })

  it("reset 清空所有状态并停掉计时器", () => {
    vi.useFakeTimers()
    window.addEventListener(IMAGE_BRIDGE_CAPTURE, () => {})
    useImageBridgeStore.getState().requestCapture(SRC)

    useImageBridgeStore.getState().reset()
    vi.advanceTimersByTime(CAPTURE_TIMEOUT_MS * 2)

    const state = useImageBridgeStore.getState()
    expect(state.pending).toEqual({})
    expect(state.errors).toEqual({})
  })
})
