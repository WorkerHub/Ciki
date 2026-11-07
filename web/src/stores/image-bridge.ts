import { create } from "zustand"
import { dispatchCaptureRequest } from "@/editor/bridge/contract"

/**
 * 未转存图片的补抓状态：按原图地址（src）记「补抓中」与错误文案，
 * 供 ImageBlock 的占位就地渲染。状态键用 src 而不是节点位置，
 * 因为插件递来的是 { 原 src, 字节 }，同一个 src 在文档里可能出现多次。
 */

/** 点了「重试自动转存」后等插件回话的上限。 */
export const CAPTURE_TIMEOUT_MS = 15_000

export const CAPTURE_TIMEOUT_MESSAGE = "没等到 Ciki 插件补抓，请手动上传替换。"

/** 计时器不进 state，避免参与渲染比较。 */
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function clearTimer(src: string) {
  const timer = timers.get(src)
  if (timer === undefined) return
  clearTimeout(timer)
  timers.delete(src)
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

interface ImageBridgeState {
  pending: Record<string, true>
  errors: Record<string, string>
  markPending: (src: string) => void
  succeed: (src: string) => void
  fail: (src: string, message: string) => void
  requestCapture: (src: string) => void
  reset: () => void
}

export const useImageBridgeStore = create<ImageBridgeState>((set, get) => ({
  pending: {},
  errors: {},

  markPending: (src) => {
    if (!src) return
    clearTimer(src)
    set((state) => ({
      pending: { ...state.pending, [src]: true },
      errors: without(state.errors, src)
    }))
  },

  succeed: (src) => {
    clearTimer(src)
    set((state) => ({
      pending: without(state.pending, src),
      errors: without(state.errors, src)
    }))
  },

  fail: (src, message) => {
    clearTimer(src)
    set((state) => ({
      pending: without(state.pending, src),
      errors: { ...state.errors, [src]: message }
    }))
  },

  /**
   * 「重试自动转存」：先立 pending 再派发事件（插件可能在同一个 tick 回话），
   * 15 秒没有 captured 就落一条错误，标黄保持原样。
   */
  requestCapture: (src) => {
    if (!src) return
    get().markPending(src)
    timers.set(
      src,
      setTimeout(() => {
        timers.delete(src)
        get().fail(src, CAPTURE_TIMEOUT_MESSAGE)
      }, CAPTURE_TIMEOUT_MS)
    )
    dispatchCaptureRequest(src)
  },

  reset: () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    set({ pending: {}, errors: {} })
  }
}))
