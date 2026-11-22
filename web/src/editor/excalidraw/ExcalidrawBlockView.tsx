import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react"
import { Loader2, Palette } from "lucide-react"
import { Suspense, lazy, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { imageWidth } from "@/editor/image-attributes"
import { api, pagesApi } from "@/lib/api"
import { useCanvasPageContext } from "./context"
import { exportSceneToBlob } from "./export"
import { ResizableExcalidraw } from "./ResizableExcalidraw"
import type { ExcalidrawNodeAttrs } from "./types"

const LazyExcalidrawModal = lazy(() =>
  import("./ExcalidrawModal").then((module) => ({
    default: module.ExcalidrawModal
  }))
)

export function ExcalidrawBlockView({
  node,
  updateAttributes,
  editor,
  getPos
}: NodeViewProps) {
  const { t } = useTranslation()
  const { pageId, canWrite } = useCanvasPageContext()
  const [modalOpen, setModalOpen] = useState(false)
  const attrs = node.attrs as ExcalidrawNodeAttrs
  const { sceneKey, extractedText } = attrs
  const [currentPreviewKey, setCurrentPreviewKey] = useState<string>(
    attrs.previewKey || ""
  )
  const [liveUrl, setLiveUrl] = useState<string | null>(null)
  const [liveStatus, setLiveStatus] = useState<
    "idle" | "loading" | "rendered" | "error"
  >("idle")
  const liveUrlRef = useRef<string | null>(null)
  const backfillStartedRef = useRef(false)
  const width = imageWidth(node.attrs)

  useEffect(() => {
    if (attrs.previewKey && attrs.previewKey !== currentPreviewKey) {
      setCurrentPreviewKey(attrs.previewKey)
    }
  }, [attrs.previewKey, currentPreviewKey])

  useEffect(() => {
    return () => {
      if (liveUrlRef.current) {
        URL.revokeObjectURL(liveUrlRef.current)
      }
    }
  }, [])

  const effectivePreviewKey = currentPreviewKey || attrs.previewKey || ""

  useEffect(() => {
    // 仅在非编辑态（阅读态）、缺失 previewKey 且存在 sceneKey 时触发现场渲染
    if (editor.isEditable || effectivePreviewKey || !sceneKey) return
    let cancelled = false
    setLiveStatus("loading")

    async function runLiveRender() {
      try {
        const res = await fetch(`/api/files/${sceneKey}`, {
          credentials: "include"
        })
        if (!res.ok) {
          throw new Error(`Failed to fetch scene: ${res.statusText}`)
        }
        const sceneData = await res.json()
        if (cancelled) return

        const blob = await exportSceneToBlob({
          elements: sceneData.elements || [],
          appState: sceneData.appState,
          files: sceneData.files
        })
        if (cancelled) return

        const objectUrl = URL.createObjectURL(blob)
        if (liveUrlRef.current) {
          URL.revokeObjectURL(liveUrlRef.current)
        }
        liveUrlRef.current = objectUrl
        setLiveUrl(objectUrl)
        setLiveStatus("rendered")

        // 回填触发：仅当查看者对该页有编辑权限 (canWrite) 且 pageId 存在时触发落盘回填
        if (
          canWrite &&
          typeof pageId === "number" &&
          !backfillStartedRef.current
        ) {
          backfillStartedRef.current = true
          void (async () => {
            try {
              const pngFile = new File([blob], "preview.png", {
                type: "image/png"
              })
              const uploadRes = await api.upload(pngFile)
              if (cancelled) return
              const newKey = uploadRes.key

              const previewRes = await pagesApi.canvasPreview(pageId, {
                sceneKey,
                previewKey: newKey
              })
              if (cancelled) return

              const effectiveKey =
                previewRes.status === "already_filled" && previewRes.previewKey
                  ? previewRes.previewKey
                  : newKey

              setCurrentPreviewKey(effectiveKey)
              updateAttributes({ previewKey: effectiveKey })
              if (liveUrlRef.current) {
                URL.revokeObjectURL(liveUrlRef.current)
                liveUrlRef.current = null
              }
              setLiveUrl(null)
            } catch (backfillErr) {
              console.error("Canvas preview backfill failed:", backfillErr)
            }
          })()
        }
      } catch (err) {
        if (cancelled) return
        console.error("Live canvas render failed:", err)
        setLiveStatus("error")
      }
    }

    void runLiveRender()

    return () => {
      cancelled = true
    }
  }, [
    editor.isEditable,
    effectivePreviewKey,
    sceneKey,
    canWrite,
    pageId,
    updateAttributes
  ])

  const handleSave = (data: {
    sceneKey: string
    previewKey: string
    extractedText: string
  }) => {
    updateAttributes({
      sceneKey: data.sceneKey,
      previewKey: data.previewKey,
      extractedText: data.extractedText
    })
    setModalOpen(false)
  }

  // 1. 阅读态（或非可编辑状态）：
  // 1.1 若已有预览图，直接输出静态 <img> 预览图
  // 1.2 若缺失 previewKey 且有 sceneKey，输出现场渲染状态（Loading Spinner / 现场渲染 Object URL / 失败兜底）
  // 1.3 若均缺失，空画布块在阅读态输出 null
  if (!editor.isEditable) {
    if (effectivePreviewKey) {
      return (
        <NodeViewWrapper as="figure" className="my-4" data-excalidraw-block="">
          <img
            src={`/api/files/${effectivePreviewKey}`}
            alt={extractedText || ""}
            width={width ?? undefined}
            data-type="excalidraw"
            data-scene-key={sceneKey}
            data-preview-key={effectivePreviewKey}
          />
        </NodeViewWrapper>
      )
    }

    if (!sceneKey) return null

    if (liveStatus === "loading") {
      return (
        <NodeViewWrapper as="figure" className="my-4" data-excalidraw-block="">
          <div
            className="flex items-center justify-center rounded-lg border border-border/50 bg-muted/20 py-12 text-muted-foreground"
            data-canvas-loading=""
            style={{
              width: width ? `${width}px` : undefined,
              maxWidth: "100%"
            }}
          >
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        </NodeViewWrapper>
      )
    }

    if (liveStatus === "error") {
      return (
        <NodeViewWrapper as="figure" className="my-4" data-excalidraw-block="">
          <div
            className="flex items-center justify-center rounded-lg border border-dashed border-destructive/40 bg-destructive/5 p-6 text-xs text-muted-foreground"
            style={{
              width: width ? `${width}px` : undefined,
              maxWidth: "100%"
            }}
          >
            {extractedText || t("editor.excalidraw.loadFailed")}
          </div>
        </NodeViewWrapper>
      )
    }

    if (liveUrl) {
      return (
        <NodeViewWrapper as="figure" className="my-4" data-excalidraw-block="">
          <img
            src={liveUrl}
            alt={extractedText || ""}
            width={width ?? undefined}
            data-type="excalidraw"
            data-scene-key={sceneKey}
            data-preview-key=""
          />
        </NodeViewWrapper>
      )
    }

    return null
  }

  // 2. 编辑态保持既有行为不变
  return (
    <NodeViewWrapper as="figure" className="my-4" data-excalidraw-block="">
      {effectivePreviewKey ? (
        <div className="relative group/canvas inline-block max-w-full">
          <ResizableExcalidraw
            node={node}
            editor={editor}
            getPos={getPos}
            updateAttributes={updateAttributes}
            onDoubleClick={() => setModalOpen(true)}
          />
          <div className="absolute top-2 right-2 opacity-0 group-hover/canvas:opacity-100 transition-opacity z-10 pointer-events-none group-hover/canvas:pointer-events-auto">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-8 shadow-sm bg-background/90 backdrop-blur hover:bg-background"
              onClick={() => setModalOpen(true)}
              data-excalidraw-action=""
            >
              <Palette className="h-3.5 w-3.5 mr-1.5" />
              {t("editor.excalidraw.edit")}
            </Button>
          </div>
        </div>
      ) : (
        <div
          className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-border bg-muted/20 p-8 text-center transition-colors hover:bg-muted/40"
          data-excalidraw-action=""
        >
          <Palette className="h-8 w-8 text-muted-foreground mb-2" />
          <div className="text-sm font-medium text-foreground mb-1">
            {t("editor.excalidraw.blankCanvas")}
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            {t("editor.excalidraw.clickToEdit")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setModalOpen(true)}
            data-excalidraw-action=""
          >
            <Palette className="h-3.5 w-3.5 mr-1.5" />
            {t("editor.excalidraw.edit")}
          </Button>
        </div>
      )}

      {modalOpen && typeof document !== "undefined"
        ? createPortal(
            <Suspense
              fallback={
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <LazyExcalidrawModal
                sceneKey={sceneKey}
                onClose={() => setModalOpen(false)}
                onSave={handleSave}
              />
            </Suspense>,
            document.body
          )
        : null}
    </NodeViewWrapper>
  )
}
