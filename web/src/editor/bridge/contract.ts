/**
 * Ciki ↔ 浏览器插件「粘贴补抓」事件桥 —— 冻结契约，本文件是唯一真相源。
 *
 * 背景：Confluence 外链图进编辑页后只有 data-original-src（标黄「未转存」占位），
 * 原图字节只有装在本机的插件才拿得到。插件不碰编辑器 DOM，只通过下面四个
 * window 事件和页面协作；上传与节点替换全部由 ciki 自己在 TipTap 模型里完成。
 *
 * 插件侧要实现的事（Ciki-extension 按此实现，改形状须先回 Chief 裁决）：
 *
 * 1. `ciki:image-bridge:plugin-hello`（插件 → 页面，detail `{}`）：插件脚本就绪时派发一次，
 *    包括 SPA 切路由后重新注入的情况。页面收到后会回一份 hello 清单。
 * 2. `ciki:image-bridge:hello`（页面 → 插件，detail `{ sources: string[] }`）：编辑页挂载、
 *    收到 plugin-hello、正文变化去抖后派发；`sources` 是当前文档里所有未转存图的原图地址
 *    （只含 http(s) 与根相对路径）。插件按这份清单补抓。
 * 3. `ciki:image-bridge:capture`（页面 → 插件，detail `{ src: string }`）：用户点了某张图的
 *    「重试自动转存」。插件必须重新抓这一张，不受去重影响。
 * 4. `ciki:image-bridge:captured`（插件 → 页面，detail
 *    `{ src: string, dataUrl: string, filename: string, contentType: string }`）：插件拿到原图
 *    字节后每张图派发一次。`dataUrl` 必须是 `data:image/(png|jpeg|gif|webp);base64,…`，
 *    `contentType` 与之一致，`filename` 只作上传文件名建议。
 *
 * 为什么是 dataUrl 而不是 Blob：插件 content script 跑在 isolated world、页面 React 跑在
 * MAIN world，Blob 句柄跨 world 传递不可靠；base64 字符串两端都稳。
 *
 * 插件侧约束：不得修改编辑器 DOM，也不得往页面注入按钮（「重试自动转存」入口是 ciki
 * 自己的 ImageBlock 渲染的，点击只派发 capture）；只读页面、只递原图字节；自动投递按
 * src 每个页面会话去重，capture 请求必须重新抓。
 */
import { isHostedImageSrc, safeExternalUrl } from "@/lib/media"
import { ACCEPTED_IMAGE_TYPES } from "@/lib/upload"

export const IMAGE_BRIDGE_PLUGIN_HELLO = "ciki:image-bridge:plugin-hello"
export const IMAGE_BRIDGE_HELLO = "ciki:image-bridge:hello"
export const IMAGE_BRIDGE_CAPTURE = "ciki:image-bridge:capture"
export const IMAGE_BRIDGE_CAPTURED = "ciki:image-bridge:captured"

export interface BridgeHelloDetail {
  sources: string[]
}

export interface BridgeCaptureDetail {
  src: string
}

export interface BridgeCapturedDetail {
  src: string
  dataUrl: string
  filename: string
  contentType: string
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp"
}

/** 插件→页面：请页面把当前待补抓清单发一遍（解决插件与编辑器的加载顺序）。 */
export function dispatchBridgeReady(): void {
  window.dispatchEvent(
    new CustomEvent<Record<string, never>>(IMAGE_BRIDGE_PLUGIN_HELLO, {
      detail: {}
    })
  )
}

/** 页面→插件：当前文档里所有未转存图的原图地址。 */
export function dispatchBridgeHello(sources: string[]): void {
  const detail: BridgeHelloDetail = { sources }
  window.dispatchEvent(
    new CustomEvent<BridgeHelloDetail>(IMAGE_BRIDGE_HELLO, { detail })
  )
}

/** 页面→插件：用户点了某张图的「重试自动转存」。 */
export function dispatchCaptureRequest(src: string): void {
  const detail: BridgeCaptureDetail = { src }
  window.dispatchEvent(
    new CustomEvent<BridgeCaptureDetail>(IMAGE_BRIDGE_CAPTURE, { detail })
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null
  return value as Record<string, unknown>
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === "string" ? value.trim() : ""
}

/** 文件名只做建议：去掉目录分隔符与控制字符，其余交给上传接口。 */
function normalizeFilename(suggested: string): string {
  const base = suggested.split(/[\\/]/).pop() ?? ""
  let cleaned = ""
  for (const char of base) {
    const code = char.codePointAt(0) ?? 0
    if (code < 32 || code === 127) continue
    cleaned += char
  }
  return cleaned.trim().slice(0, 120)
}

/** 插件没给文件名（或给的是空串）时，从原图地址凑一个像样的名字。 */
export function filenameFromSource(src: string, contentType: string): string {
  const ext = EXTENSIONS[contentType] ?? "png"
  const path = src.split(/[?#]/)[0] ?? ""
  const last = path.split("/").pop() ?? ""
  let decoded = last
  try {
    decoded = decodeURIComponent(last)
  } catch {
    /* 地址里有非法转义就退回原名 */
  }
  const cleaned = normalizeFilename(decoded)
  if (!cleaned) return `image.${ext}`
  return /\.[a-z0-9]{2,5}$/i.test(cleaned) ? cleaned : `${cleaned}.${ext}`
}

/**
 * 校验插件递来的 `captured` 事件，不合格返回 null：
 * - src 必须是 http(s) 或根相对路径（contentHtml 来自他人编辑，不能顺手递给插件）；
 * - dataUrl 必须是 data:image 白名单里的 base64（拒 svg / data:text/html）；
 * - contentType 必须与上传接口的白名单一致。
 */
export function readCapturedDetail(event: Event): BridgeCapturedDetail | null {
  const record = asRecord((event as CustomEvent<unknown>).detail)
  if (!record) return null
  const src = safeExternalUrl(readString(record, "src"))
  if (!src) return null
  const dataUrl = readString(record, "dataUrl")
  if (!dataUrl.startsWith("data:image/")) return null
  if (!isHostedImageSrc(dataUrl)) return null
  const contentType = readString(record, "contentType").toLowerCase()
  if (
    !ACCEPTED_IMAGE_TYPES.includes(
      contentType as (typeof ACCEPTED_IMAGE_TYPES)[number]
    )
  ) {
    return null
  }
  const filename =
    normalizeFilename(readString(record, "filename")) ||
    filenameFromSource(src, contentType)
  return { src, dataUrl, filename, contentType }
}

/**
 * 页面侧挂在 window 上的两个入口：插件报到（要清单）与投递字节。
 * 返回解绑函数，编辑页销毁时调用。
 */
export function listenBridge(handlers: {
  onPluginHello: () => void
  onCaptured: (detail: BridgeCapturedDetail) => void
}): () => void {
  const onReady = () => {
    handlers.onPluginHello()
  }
  const onCaptured = (event: Event) => {
    const detail = readCapturedDetail(event)
    if (detail) handlers.onCaptured(detail)
  }
  window.addEventListener(IMAGE_BRIDGE_PLUGIN_HELLO, onReady)
  window.addEventListener(IMAGE_BRIDGE_CAPTURED, onCaptured)
  return () => {
    window.removeEventListener(IMAGE_BRIDGE_PLUGIN_HELLO, onReady)
    window.removeEventListener(IMAGE_BRIDGE_CAPTURED, onCaptured)
  }
}
