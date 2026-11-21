import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react"
import { Loader2, Palette } from "lucide-react"
import { Suspense, lazy, useState } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { imageWidth } from "@/editor/image-attributes"
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
  const [modalOpen, setModalOpen] = useState(false)
  const attrs = node.attrs as ExcalidrawNodeAttrs
  const { previewKey, sceneKey, extractedText } = attrs
  const width = imageWidth(node.attrs)

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

  // 1. 阅读态（或非可编辑状态）：纯静态 <img>，不挂手柄，不挂任何编辑弹窗组件
  if (!editor.isEditable) {
    if (!previewKey) return null
    return (
      <NodeViewWrapper as="figure" className="my-4" data-excalidraw-block="">
        <img
          src={`/api/files/${previewKey}`}
          alt={extractedText || ""}
          width={width ?? undefined}
          data-type="excalidraw"
          data-scene-key={sceneKey}
          data-preview-key={previewKey}
        />
      </NodeViewWrapper>
    )
  }

  // 2. 编辑态：
  // 2.1 若已有预览图，展示可缩放预览图 + 浮层「编辑画布」按钮
  // 2.2 若为空块（无 previewKey），展示占位卡片提示打开全屏编辑器
  return (
    <NodeViewWrapper as="figure" className="my-4" data-excalidraw-block="">
      {previewKey ? (
        <div className="relative group/canvas inline-block max-w-full min-w-[120px]">
          <ResizableExcalidraw
            node={node}
            editor={editor}
            getPos={getPos}
            updateAttributes={updateAttributes}
            onDoubleClick={() => setModalOpen(true)}
          />
          <div className="absolute top-2 right-2 opacity-0 group-hover/canvas:opacity-100 transition-opacity z-10">
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
                sceneKey={sceneKey || undefined}
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
