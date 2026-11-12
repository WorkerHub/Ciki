import { type Editor, Extension } from "@tiptap/core"
import {
  type BridgeCapturedDetail,
  dispatchBridgeHello,
  listenBridge
} from "@/editor/bridge/contract"
import { ApiError, describeApiError } from "@/lib/api"
import { safeExternalUrl } from "@/lib/media"
import { uploadImage } from "@/lib/upload"
import i18n from "@/i18n"
import { useImageBridgeStore } from "@/stores/image-bridge"

/** 正文变化后多久再喊一次清单（粘贴/撤销都走这条路，避免每个按键都发事件）。 */
const ANNOUNCE_DEBOUNCE_MS = 300

/** 文档里所有未转存图的原图地址（去重、只留安全协议）。 */
export function untransferredSources(editor: Editor): string[] {
  const seen = new Set<string>()
  editor.state.doc.descendants((node) => {
    if (node.type.name !== "image") return
    const src = safeExternalUrl((node.attrs.originalSrc as string | null) ?? "")
    if (src) seen.add(src)
  })
  return [...seen]
}

function hasSource(editor: Editor, src: string): boolean {
  let found = false
  editor.state.doc.descendants((node) => {
    if (found || node.type.name !== "image") return
    if (((node.attrs.originalSrc as string | null) ?? "") === src) found = true
  })
  return found
}

/**
 * 把该 src 的所有未转存图片节点换成上传后的本站图 —— 必须在 TipTap 模型里做：
 * 一次事务、按节点位置 setNodeMarkup，不碰编辑器 DOM。位置在调用时现扫现取，
 * 所以上传期间用户改过正文也不会错位；图片是叶子节点，换属性不改变文档长度，
 * 同一事务里换多处是安全的。
 */
export function replaceCapturedImage(
  editor: Editor,
  originalSrc: string,
  url: string
): number {
  const { tr } = editor.state
  let replaced = 0
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "image") return
    if (((node.attrs.originalSrc as string | null) ?? "") !== originalSrc)
      return
    tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      src: url,
      originalSrc: null,
      confluenceImg: false
    })
    replaced += 1
  })
  if (replaced > 0) editor.view.dispatch(tr)
  return replaced
}

async function blobFromDataUrl(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl)
  if (!response.ok) {
    throw new ApiError(
      400,
      i18n.t("editor.image.captureInvalid"),
      "INVALID_CAPTURE"
    )
  }
  return response.blob()
}

interface BridgeStorage {
  unlisten?: () => void
  cancelAnnounce?: () => void
  scheduleAnnounce?: () => void
}

/**
 * 补抓事件桥（只在编辑页挂）：插件把原图字节递进来，这里解码 → 走现有
 * `uploadImage`（POST /api/files，会话 Cookie，校验与 R2 落盘都在后端既有
 * 实现里）→ 在 TipTap 模型里替换节点。失败只写进占位上的错误行，
 * 标黄保持原样，「重试自动转存」可再来一次。
 */
export const UntransferredImageBridge = Extension.create<
  unknown,
  BridgeStorage
>({
  name: "untransferredImageBridge",

  onCreate() {
    const editor = this.editor
    let timer: ReturnType<typeof setTimeout> | null = null
    // 正在上传的 src：纯上传互斥，与 UI 的 pending 标记分开
    const inFlight = new Set<string>()

    const announce = () => {
      if (editor.isDestroyed) return
      const sources = untransferredSources(editor)
      if (!sources.length) return
      dispatchBridgeHello(sources)
    }

    const scheduleAnnounce = () => {
      if (this.storage.cancelAnnounce) this.storage.cancelAnnounce()
      timer = setTimeout(() => {
        timer = null
        announce()
      }, ANNOUNCE_DEBOUNCE_MS)
    }

    const onCaptured = (detail: BridgeCapturedDetail) => {
      void (async () => {
        const { src, dataUrl, filename, contentType } = detail
        if (editor.isDestroyed || !editor.isEditable) return
        // 上传互斥用自己的集合，不能借 store.pending：那个标记还承担着 UI（补抓中…）
        // 与「重试自动转存」15 秒超时的职责，点重试时它已经是 true，会把自己的回话全丢掉。
        if (inFlight.has(src)) return
        if (!hasSource(editor, src)) return

        inFlight.add(src)
        const store = useImageBridgeStore.getState()
        store.markPending(src)
        try {
          const blob = await blobFromDataUrl(dataUrl)
          if (!blob.size) {
            throw new ApiError(
              400,
              i18n.t("editor.image.captureEmpty"),
              "EMPTY_CAPTURE"
            )
          }
          if (editor.isDestroyed) return
          const uploaded = await uploadImage(
            new File([blob], filename, { type: contentType })
          )
          if (editor.isDestroyed) return
          replaceCapturedImage(editor, src, uploaded.url)
          useImageBridgeStore.getState().succeed(src)
        } catch (error) {
          useImageBridgeStore.getState().fail(src, describeApiError(error))
        } finally {
          inFlight.delete(src)
        }
      })()
    }

    this.storage.unlisten = listenBridge({
      // 插件报到（含它比编辑器晚加载的情况）：把当前清单再发一遍
      onPluginHello: announce,
      onCaptured
    })
    this.storage.cancelAnnounce = () => {
      if (timer === null) return
      clearTimeout(timer)
      timer = null
    }
    this.storage.scheduleAnnounce = scheduleAnnounce

    announce()
  },

  onUpdate() {
    // 正文变了（粘贴进来新的标黄图、撤销回标黄）就重新喊一次清单
    this.storage.scheduleAnnounce?.()
  },

  onDestroy() {
    this.storage.unlisten?.()
    this.storage.cancelAnnounce?.()
    useImageBridgeStore.getState().reset()
  }
})
