import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react"
import { ImageOff, Upload } from "lucide-react"
import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { describeApiError } from "@/lib/api"
import { ACCEPT_IMAGE_ATTR, uploadImage } from "@/lib/upload"

/**
 * 图片节点：本站 /api/files 的图片直接显示；Confluence 附件或其它外链图在清洗时
 * 已经把 src 换成了 data-original-src，这里渲染成「未转存」占位，并提供上传替换
 * 入口（规格 §5.7）。阅读态只展示提示与原始链接，替换动作在编辑页完成。
 */
export function ImageBlock({ node, updateAttributes, editor }: NodeViewProps) {
  const src = (node.attrs.src as string | null) || ""
  const originalSrc = (node.attrs.originalSrc as string | null) || ""
  const alt = (node.attrs.alt as string | null) || ""
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState("")

  if (src) {
    return (
      <NodeViewWrapper as="figure" className="my-4" data-image-block="">
        <img
          src={src}
          alt={alt}
          title={(node.attrs.title as string | null) || undefined}
        />
        {alt ? (
          <figcaption className="mt-1 text-xs text-muted-foreground">
            {alt}
          </figcaption>
        ) : null}
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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 text-xs font-medium">
          <ImageOff className="size-3.5" aria-hidden="true" />
          未转存的图片
        </span>
        <span className="text-xs opacity-80">
          这份 Confluence 图片没有随剪贴板过来，需要手动上传到图床后再替换。
        </span>
      </div>
      {originalSrc ? (
        <p className="mt-1 truncate text-xs opacity-80" title={originalSrc}>
          原地址：
          <a
            href={originalSrc}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2"
          >
            {originalSrc}
          </a>
        </p>
      ) : null}
      {editor.isEditable ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
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
          {error ? (
            <span className="text-xs text-destructive">{error}</span>
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
