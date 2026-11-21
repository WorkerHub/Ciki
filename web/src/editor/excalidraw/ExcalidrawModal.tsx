import {
  DefaultSidebar,
  Excalidraw,
  exportToBlob,
  getTextFromElements,
  serializeAsJSON,
  MainMenu,
  WelcomeScreen
} from "@excalidraw/excalidraw"
import "@excalidraw/excalidraw/index.css"
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types"
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import { Loader2, Palette } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { api, describeApiError } from "@/lib/api"
import { useThemeStore } from "@/stores/theme"

if (typeof window !== "undefined") {
  ;(
    window as unknown as { EXCALIDRAW_ASSET_PATH: string }
  ).EXCALIDRAW_ASSET_PATH = "/"
}

interface ExcalidrawModalProps {
  sceneKey?: string
  onClose: () => void
  onSave: (data: {
    sceneKey: string
    previewKey: string
    extractedText: string
  }) => void
}

export function ExcalidrawModal({
  sceneKey,
  onClose,
  onSave
}: ExcalidrawModalProps) {
  const { t, i18n } = useTranslation()
  const resolvedTheme = useThemeStore((state) => state.resolved)
  const langCode = i18n.language.startsWith("zh") ? "zh-CN" : "en"

  const [excalidrawAPI, setExcalidrawAPI] =
    useState<ExcalidrawImperativeAPI | null>(null)
  const [loadingScene, setLoadingScene] = useState(Boolean(sceneKey))
  const [initialData, setInitialData] = useState<{
    elements?: readonly ExcalidrawElement[]
    appState?: Record<string, unknown>
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  // 按 sceneKey 加载已有场景，不存在时视为空白画布
  useEffect(() => {
    let cancelled = false
    if (!sceneKey) {
      setInitialData({
        elements: [],
        appState: {
          theme: resolvedTheme,
          isLoading: false
        }
      })
      setLoadingScene(false)
      return
    }

    setLoadingScene(true)
    setError("")

    fetch(`/api/files/${sceneKey}`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Failed to load scene: ${res.statusText}`)
        }
        return res.json()
      })
      .then((data) => {
        if (cancelled) return
        setInitialData({
          elements: data.elements || [],
          appState: {
            ...(data.appState || {}),
            theme: resolvedTheme,
            isLoading: false
          }
        })
      })
      .catch((err) => {
        if (cancelled) return
        setError(describeApiError(err))
        // 场景拉取失败以空白画布兜底，避免白屏卡死
        setInitialData({
          elements: [],
          appState: {
            theme: resolvedTheme,
            isLoading: false
          }
        })
      })
      .finally(() => {
        if (!cancelled) setLoadingScene(false)
      })

    return () => {
      cancelled = true
    }
  }, [sceneKey, resolvedTheme])

  // 按 Esc 键退出（保存中不响应；输入框编辑中优先让组件自身处理 Esc）
  useEffect(() => {
    const isInput = (el: EventTarget | null) => {
      if (!el || !(el instanceof Element)) return false
      const tag = el.tagName.toLowerCase()
      return (
        tag === "input" ||
        tag === "textarea" ||
        (el as HTMLElement).isContentEditable
      )
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) {
        if (isInput(e.target) || isInput(document.activeElement)) {
          return
        }
        onClose()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose, saving])

  const handleSave = async () => {
    if (!excalidrawAPI) return
    setSaving(true)
    setError("")
    try {
      const elements = excalidrawAPI.getSceneElements()
      const appState = excalidrawAPI.getAppState()
      const files = excalidrawAPI.getFiles()

      // 1. 提取文字供搜索索引与无障碍 fallback
      const extractedText = getTextFromElements(elements)

      // 2. 序列化场景 JSON
      const jsonString = serializeAsJSON(elements, appState, files, "local")
      const jsonBlob = new Blob([jsonString], { type: "application/json" })
      const jsonFile = new File([jsonBlob], "scene.json", {
        type: "application/json"
      })

      // 3. 导出 2x 预览 PNG
      const pngBlob = await exportToBlob({
        elements,
        appState: {
          ...appState,
          exportScale: 2,
          exportBackground: true
        },
        files,
        mimeType: "image/png"
      })
      const pngFile = new File([pngBlob], "preview.png", {
        type: "image/png"
      })

      // 4. 并行上传两份文件至 /api/files
      const [jsonRes, pngRes] = await Promise.all([
        api.upload(jsonFile),
        api.upload(pngFile)
      ])

      onSave({
        sceneKey: jsonRes.key,
        previewKey: pngRes.key,
        extractedText
      })
    } catch (err) {
      setError(describeApiError(err))
      setSaving(false)
    }
  }

  return (
    <div className="wiki-excalidraw-modal fixed inset-0 z-50 flex flex-col bg-background select-none">
      {/* 顶部工具栏 */}
      <div className="flex h-12 items-center justify-between border-b px-4 bg-background">
        <div className="flex items-center gap-2">
          <Palette className="h-5 w-5 text-primary" />
          <span className="text-sm font-semibold">
            {t("editor.excalidraw.modalTitle")}
          </span>
          {error ? (
            <span className="text-xs text-destructive ml-2">{error}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={saving}
          >
            {t("editor.excalidraw.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={saving || loadingScene}
          >
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                {t("editor.excalidraw.saving")}
              </>
            ) : (
              t("editor.excalidraw.save")
            )}
          </Button>
        </div>
      </div>

      {/* Excalidraw 画布区域 */}
      <div className="relative flex-1 w-full h-[calc(100%-3rem)]">
        {loadingScene ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : initialData ? (
          <Excalidraw
            excalidrawAPI={(api) => setExcalidrawAPI(api)}
            theme={resolvedTheme}
            langCode={langCode}
            initialData={initialData}
            validateEmbeddable={false}
            UIOptions={{
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                export: false,
                saveAsImage: false,
                toggleTheme: false
              },
              tools: {
                image: false
              }
            }}
          >
            <DefaultSidebar.Trigger
              title=""
              style={{ display: "none" }}
              className="hidden pointer-events-none"
            />
            <MainMenu>
              <MainMenu.DefaultItems.ClearCanvas />
              <MainMenu.DefaultItems.ChangeCanvasBackground />
            </MainMenu>
            <WelcomeScreen>
              <WelcomeScreen.Hints.ToolbarHint />
              <WelcomeScreen.Hints.MenuHint />
            </WelcomeScreen>
          </Excalidraw>
        ) : null}
      </div>
    </div>
  )
}

export default ExcalidrawModal
