import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react"
import { ImageOff, RefreshCw, Upload } from "lucide-react"
import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { imageWidth } from "@/editor/image-view"
import { describeApiError } from "@/lib/api"
import { isSafeExternalUrl } from "@/lib/media"
import { ACCEPT_IMAGE_ATTR, uploadImage } from "@/lib/upload"
import { useImageBridgeStore } from "@/stores/image-bridge"

/**
 * 图片节点：本站 /api/files 的图片直接显示；Confluence 附件或其它外链图在清洗时
 * 已经把 src 换成了 data-original-src，这里渲染成「未转存」占位，并提供两条出路：
 * 装了 Ciki 插件就让插件补抓（走 bridge 事件），否则手动上传替换（规格 §5.7）。
 * 阅读态只展示提示与原始链接，两个替换动作都在编辑页完成。
 *
 * alt 只作为 <img> 的无障碍文本，不再渲染成可见图注：剪藏导入的图片 alt 兜底取的是
 * 附件文件名，渲染成图注就等于在图下反复念文件名。
 */
export function ImageBlock({ node, updateAttributes, editor }: NodeViewProps) {
  const src = (node.attrs.src as string | null) || ""
  const originalSrc = (node.attrs.originalSrc as string | null) || ""
  const alt = (node.attrs.alt as string | null) || ""
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState("")
  // 事件桥的补抓状态按原图地址记（同一张图可能在正文里出现多次）
  const capturePending = useImageBridgeStore((state) =>
    originalSrc ? Boolean(state.pending[originalSrc]) : false
  )
  const captureError = useImageBridgeStore((state) =>
    originalSrc ? (state.errors[originalSrc] ?? "") : ""
  )
  const requestCapture = useImageBridgeStore((state) => state.requestCapture)

  if (src) {
    return (
      <NodeViewWrapper as="figure" className="my-4" data-image-block="">
        <img
          src={src}
          alt={alt}
          title={(node.attrs.title as string | null) || undefined}
          width={imageWidth(node.attrs) ?? undefined}
        />
      </NodeViewWrapper>
    )
  }

  const pickFile = () => {
    setError("")
    inputRef.current?.click()
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setUploading(true)
    setError("")
    try {
      const uploaded = await uploadImage(file)
      updateAttributes({
        src: uploaded.url,
        originalSrc: null,
        confluenceImg: false,
        alt: alt || file.name
      })
    } catch (uploadError) {
      setError(describeApiError(uploadError))
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  return (
    <NodeViewWrapper
      as="div"
      className="my-4 rounded-lg border border-amber-400/70 bg-amber-50 px-3 py-2.5 text-amber-950 dark:border-amber-500/50 dark:bg-amber-950/30 dark:text-amber-100"
      data-image-block=""
      data-untransferred-image=""
    >
      <div className="flex items-center gap-1 text-xs font-medium">
        <ImageOff className="size-3.5" aria-hidden="true" />
        未转存的图片
      </div>
      {originalSrc ? (
        <p className="mt-1 truncate text-xs opacity-80" title={originalSrc}>
          原地址：
          {/* 只有 http(s)/根相对路径才给链接：contentJson 里的 originalSrc 来自他人编辑，
              绝不能把 javascript:/data:text/html 变成可点击的 href */}
          {isSafeExternalUrl(originalSrc) ? (
            <a
              href={originalSrc}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            >
              {originalSrc}
            </a>
          ) : (
            <span>{originalSrc}</span>
          )}
        </p>
      ) : null}
      {editor.isEditable ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {originalSrc ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => requestCapture(originalSrc)}
              disabled={uploading || capturePending}
            >
              <RefreshCw aria-hidden="true" />
              {capturePending ? "补抓中…" : "重试自动转存"}
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={pickFile}
            disabled={uploading}
          >
            <Upload aria-hidden="true" />
            {uploading ? "上传中…" : "上传替换"}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT_IMAGE_ATTR}
            className="hidden"
            onChange={(event) => void onFile(event.target.files?.[0])}
          />
          {error || captureError ? (
            <span className="text-xs text-destructive">
              {error || captureError}
            </span>
          ) : null}
        </div>
      ) : (
        <p className="mt-1 text-xs opacity-80">
          点右上角「编辑」进入编辑页即可上传替换。
        </p>
      )}
    </NodeViewWrapper>
  )
}
