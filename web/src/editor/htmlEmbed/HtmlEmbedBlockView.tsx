import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react"
import {
  AlertCircle,
  AppWindow,
  Loader2,
  RefreshCw,
  Trash2
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { describeApiError } from "@/lib/api"
import { uploadEmbed } from "@/lib/upload"
import { useThemeStore } from "@/stores/theme"
import {
  DEFAULT_HTML_EMBED_HEIGHT,
  MAX_HTML_EMBED_MANUAL_HEIGHT,
  MIN_HTML_EMBED_MANUAL_HEIGHT,
  clampAutoHtmlEmbedHeight,
  clampManualHtmlEmbedHeight
} from "./extension"
import {
  CIKI_EMBED_HEIGHT_MESSAGE_TYPE,
  CIKI_EMBED_THEME_MESSAGE_TYPE,
  type CikiEmbedThemeMessage,
  type HtmlEmbedNodeAttrs
} from "./types"

export function HtmlEmbedBlockView({
  node,
  updateAttributes,
  deleteNode,
  editor,
  getPos
}: NodeViewProps) {
  const { t } = useTranslation()
  const attrs = node.attrs as HtmlEmbedNodeAttrs
  const { key, name, height } = attrs
  const fixedHeight = clampManualHtmlEmbedHeight(height)
  const isAuto = fixedHeight === null
  const isEditable = editor.isEditable
  const resolved = useThemeStore((state) =>
    isEditable ? "light" : state.resolved
  )
  const style = useThemeStore((state) => (isEditable ? "nova" : state.style))

  const [isIframeLoaded, setIsIframeLoaded] = useState(false)
  const [initialEmbedParams, setInitialEmbedParams] = useState(() => ({
    resolved,
    style
  }))
  const [prevKey, setPrevKey] = useState(key)
  if (prevKey !== key) {
    setPrevKey(key)
    setIsIframeLoaded(false)
    setInitialEmbedParams({ resolved, style })
  }

  const [autoHeight, setAutoHeight] = useState<number>(
    DEFAULT_HTML_EMBED_HEIGHT
  )
  const [heightInput, setHeightInput] = useState(() => {
    return fixedHeight !== null ? String(fixedHeight) : ""
  })
  const [isUploading, setIsUploading] = useState(false)
  const [hasError, setHasError] = useState(!key)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const fixed = clampManualHtmlEmbedHeight(attrs.height)
    setHeightInput(fixed !== null ? String(fixed) : "")
  }, [attrs.height])

  // 阅读态：检测资源是否可用或下发异常
  useEffect(() => {
    if (editor.isEditable) return
    if (!key) {
      setHasError(true)
      return
    }
    let cancelled = false
    setHasError(false)

    fetch(`/api/files/${key}`, {
      method: "HEAD",
      credentials: "include"
    })
      .then((res) => {
        if (cancelled) return
        if (!res.ok && res.status !== 405) {
          setHasError(true)
        }
      })
      .catch(() => {
        if (cancelled) return
      })

    return () => {
      cancelled = true
    }
  }, [editor.isEditable, key])

  // 阅读态：接收 iframe 高度上报并自动贴合
  useEffect(() => {
    if (editor.isEditable) return

    const handleMessage = (event: MessageEvent) => {
      // 1. 只接受 event.source 等于本 iframe contentWindow 的消息（沙箱 origin 为 opaque，不验 origin 验 source）
      const iframe = iframeRef.current
      if (!iframe?.contentWindow || event.source !== iframe.contentWindow) {
        return
      }

      // 2. 仅当该节点处于「自动」模式时应用上报值（固定高度路径不受上报干扰）
      if (fixedHeight !== null) {
        return
      }

      // 3. 只处理 ciki-embed-height 一种消息，其余丢弃
      const data = event.data
      if (!data || typeof data !== "object") {
        return
      }
      if (data.type !== CIKI_EMBED_HEIGHT_MESSAGE_TYPE) {
        return
      }

      // 4. 高度取数值后钳制到 200–4000 再应用
      const rawHeight = data.height
      if (typeof rawHeight !== "number" || !Number.isFinite(rawHeight)) {
        return
      }

      const clamped = clampAutoHtmlEmbedHeight(rawHeight)
      setAutoHeight(clamped)
    }

    window.addEventListener("message", handleMessage)
    return () => {
      window.removeEventListener("message", handleMessage)
    }
  }, [editor.isEditable, fixedHeight])

  // 阅读态：向 iframe contentWindow 下发当前主题与风格
  const sendThemeMessage = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    const message: CikiEmbedThemeMessage = {
      type: CIKI_EMBED_THEME_MESSAGE_TYPE,
      mode: resolved,
      style
    }
    iframe.contentWindow.postMessage(message, "*")
  }, [resolved, style])

  const handleIframeLoad = useCallback(() => {
    setIsIframeLoaded(true)
    sendThemeMessage()
  }, [sendThemeMessage])

  useEffect(() => {
    if (editor.isEditable) return
    if (isIframeLoaded) {
      sendThemeMessage()
    } else {
      setInitialEmbedParams({ resolved, style })
    }
  }, [editor.isEditable, isIframeLoaded, resolved, style, sendThemeMessage])

  const commitHeight = (val: string) => {
    const trimmed = val.trim()
    if (!trimmed) {
      setHeightInput("")
      if (attrs.height !== null) {
        updateAttributes({ height: null })
      }
      return
    }
    const clamped = clampManualHtmlEmbedHeight(trimmed)
    if (clamped === null) {
      setHeightInput("")
      if (attrs.height !== null) {
        updateAttributes({ height: null })
      }
    } else {
      setHeightInput(String(clamped))
      if (clamped !== attrs.height) {
        updateAttributes({ height: clamped })
      }
    }
  }

  const handleReplace = async (file: File | undefined) => {
    if (!file) return
    setIsUploading(true)
    try {
      const uploaded = await uploadEmbed(file)
      updateAttributes({
        key: uploaded.key,
        name: file.name
      })
      toast.success(t("editor.htmlEmbed.replaceSuccess"))
    } catch (err) {
      toast.error(describeApiError(err))
    } finally {
      setIsUploading(false)
      if (replaceInputRef.current) {
        replaceInputRef.current.value = ""
      }
    }
  }

  const handleDelete = () => {
    if (typeof deleteNode === "function") {
      deleteNode()
    } else if (typeof getPos === "function") {
      const pos = getPos()
      if (typeof pos === "number") {
        editor
          .chain()
          .focus()
          .deleteRange({ from: pos, to: pos + node.nodeSize })
          .run()
      }
    }
  }

  // 计算当前阅读态渲染高度：固定高度手填 200–2000，自动贴合 clamp 200–4000
  const displayHeight = isAuto
    ? clampAutoHtmlEmbedHeight(autoHeight)
    : fixedHeight

  // 1. 阅读态渲染：仅 iframe（无额外权限）或错误占位卡
  if (!editor.isEditable) {
    if (!key || hasError) {
      return (
        <NodeViewWrapper
          as="figure"
          className="my-4 w-full"
          data-html-embed-block=""
        >
          <div
            className="flex flex-col items-center justify-center rounded-lg border border-dashed border-destructive/40 bg-destructive/5 p-6 text-center text-xs text-muted-foreground"
            style={{ minHeight: "120px", height: `${displayHeight}px` }}
            data-html-embed-error=""
          >
            <AlertCircle className="mb-2 h-6 w-6 text-destructive" />
            <span className="mb-1 font-medium text-foreground">
              {name || t("editor.htmlEmbed.loadFailed")}
            </span>
            <span className="text-muted-foreground">
              {t("editor.htmlEmbed.loadFailedDesc")}
            </span>
          </div>
        </NodeViewWrapper>
      )
    }

    return (
      <NodeViewWrapper
        as="figure"
        className="my-4 w-full"
        data-html-embed-block=""
      >
        <iframe
          ref={iframeRef}
          src={`/api/files/${key}?mode=${encodeURIComponent(initialEmbedParams.resolved)}&style=${encodeURIComponent(initialEmbedParams.style)}`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          title={name || t("editor.htmlEmbed.title")}
          className="w-full rounded-md border border-border/50 bg-background"
          style={{
            width: "100%",
            height: `${displayHeight}px`,
            display: "block"
          }}
          onLoad={handleIframeLoad}
          onError={() => setHasError(true)}
          data-html-embed-iframe=""
        />
      </NodeViewWrapper>
    )
  }

  // 2. 编辑器渲染：纯静态占位卡，不执行脚本
  const posId = typeof getPos === "function" ? getPos() : "input"
  return (
    <NodeViewWrapper
      as="div"
      className="my-4 select-none"
      data-html-embed-block=""
    >
      <div
        className="flex flex-col justify-between gap-3 rounded-lg border border-border bg-card p-4 shadow-xs sm:flex-row sm:items-center"
        data-html-embed-card=""
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <AppWindow className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-sm font-medium text-foreground"
              title={name || t("editor.htmlEmbed.unnamed")}
              data-html-embed-name=""
            >
              {name || t("editor.htmlEmbed.unnamed")}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center rounded bg-muted/80 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                HTML Embed
              </span>
              <span className="max-w-[200px] truncate sm:max-w-[280px]">
                {key || t("editor.htmlEmbed.noFile")}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-2 sm:border-t-0 sm:pt-0">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <label htmlFor={`embed-height-${posId}`}>
              {t("editor.htmlEmbed.height")}:
            </label>
            <Input
              id={`embed-height-${posId}`}
              type="number"
              min={MIN_HTML_EMBED_MANUAL_HEIGHT}
              max={MAX_HTML_EMBED_MANUAL_HEIGHT}
              step={10}
              placeholder={t("editor.htmlEmbed.auto")}
              value={heightInput}
              onChange={(e) => setHeightInput(e.target.value)}
              onBlur={() => commitHeight(heightInput)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  commitHeight(heightInput)
                }
              }}
              className="h-8 w-20 px-2 text-xs"
              data-html-embed-action=""
              data-html-embed-height-input=""
            />
            <span>px</span>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            disabled={isUploading}
            onClick={() => replaceInputRef.current?.click()}
            data-html-embed-action=""
            data-html-embed-replace=""
          >
            {isUploading ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t("editor.htmlEmbed.replace")}
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={handleDelete}
            data-html-embed-action=""
            data-html-embed-delete=""
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {t("editor.htmlEmbed.delete")}
          </Button>

          <input
            ref={replaceInputRef}
            type="file"
            accept=".html,text/html"
            className="hidden"
            onChange={(e) => void handleReplace(e.target.files?.[0])}
            data-html-embed-action=""
          />
        </div>
      </div>
    </NodeViewWrapper>
  )
}
