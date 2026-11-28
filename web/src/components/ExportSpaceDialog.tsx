import { AlertCircle, CheckCircle2, Download } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { pagesApi } from "@/lib/api"
import { exportSpaceArchive, flattenPageTree } from "@/lib/space-archive/export"
import type { ExportProgress } from "@/lib/space-archive/types"

export interface ExportSpaceDialogProps {
  spaceId: number | null
  spaceName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ExportSpaceDialog({
  spaceId,
  spaceName,
  open,
  onOpenChange
}: ExportSpaceDialogProps) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<"idle" | "exporting" | "done" | "error">(
    "idle"
  )
  const [estimating, setEstimating] = useState(false)
  const [estimatedPages, setEstimatedPages] = useState(0)
  const [estimatedRequests, setEstimatedRequests] = useState(0)
  const [estimatedBytes, setEstimatedBytes] = useState(0)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [errorMessage, setErrorMessage] = useState("")
  const [exportedFilename, setExportedFilename] = useState("")
  const [warnings, setWarnings] = useState<string[]>([])

  const abortControllerRef = useRef<AbortController | null>(null)

  // 打开时初始化预估
  const estimate = useCallback(async (id: number) => {
    setEstimating(true)
    setErrorMessage("")
    try {
      const tree = await pagesApi.tree(id)
      const flat = flattenPageTree(tree)
      const pageCount = flat.length
      setEstimatedPages(pageCount)
      // 请求数基线估算：页数 × 2
      setEstimatedRequests(pageCount * 2)
      // 体积粗估（平均每页含图约 500KB 估算）
      setEstimatedBytes(pageCount * 500 * 1024)
    } catch (err) {
      console.warn("Failed to estimate export size:", err)
    } finally {
      setEstimating(false)
    }
  }, [])

  useEffect(() => {
    if (open && spaceId !== null) {
      setStatus("idle")
      setProgress(null)
      setErrorMessage("")
      setExportedFilename("")
      setWarnings([])
      void estimate(spaceId)
    } else {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
        abortControllerRef.current = null
      }
    }
  }, [open, spaceId, estimate])

  const startExport = async () => {
    if (!spaceId) return
    setStatus("exporting")
    setErrorMessage("")
    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      const result = await exportSpaceArchive(spaceId, {
        signal: controller.signal,
        onProgress: (p) => setProgress(p)
      })
      setExportedFilename(result.filename)
      setWarnings(result.manifest.warnings || [])
      setStatus("done")
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        setStatus("idle")
      } else {
        setStatus("error")
        setErrorMessage(
          err instanceof Error ? err.message : t("space.export.errorGeneric")
        )
      }
    } finally {
      abortControllerRef.current = null
    }
  }

  const cancelExport = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setStatus("idle")
  }

  const isLargePackage = estimatedBytes > 200 * 1024 * 1024

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (status === "exporting") return
        onOpenChange(v)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("space.export.title")}</DialogTitle>
          <DialogDescription className="truncate">
            {spaceName}
          </DialogDescription>
        </DialogHeader>

        {status === "idle" && (
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3 rounded-lg border p-3 text-sm">
              <div>
                <span className="text-xs text-muted-foreground">
                  {t("space.export.estimatedPages")}
                </span>
                <p className="text-lg font-semibold tabular-nums">
                  {estimating ? "…" : estimatedPages}
                </p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">
                  {t("space.export.estimatedRequests")}
                </span>
                <p className="text-lg font-semibold tabular-nums">
                  {estimating ? "…" : `~${estimatedRequests}`}
                </p>
              </div>
            </div>

            {isLargePackage && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-800 dark:text-yellow-200"
              >
                <AlertCircle className="size-4 shrink-0 mt-0.5" />
                <span>{t("space.export.largePackageHint")}</span>
              </div>
            )}
          </div>
        )}

        {status === "exporting" && (
          <div className="space-y-4 py-3">
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>
                  {progress?.phase === "fetching_pages"
                    ? t("space.export.phasePages")
                    : progress?.phase === "fetching_files"
                      ? t("space.export.phaseFiles")
                      : progress?.phase === "assembling"
                        ? t("space.export.phaseAssembling")
                        : t("space.export.phaseSaving")}
                </span>
                <span className="tabular-nums">
                  {progress?.completedPages ?? 0} /{" "}
                  {progress?.totalPages ?? estimatedPages}{" "}
                  {t("space.export.pagesCount")} ·{" "}
                  {progress?.completedFiles ?? 0} / {progress?.totalFiles ?? 0}{" "}
                  {t("space.export.filesCount")}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round(
                        (((progress?.completedPages ?? 0) +
                          (progress?.completedFiles ?? 0)) /
                          Math.max(
                            1,
                            (progress?.totalPages ?? 1) +
                              (progress?.totalFiles ?? 1)
                          )) *
                          100
                      )
                    )}%`
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {status === "done" && (
          <div className="space-y-3 py-3">
            <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
              <CheckCircle2 className="size-5 shrink-0" />
              <span className="font-medium">{t("space.export.success")}</span>
            </div>
            <div className="rounded-md border p-2 text-xs font-mono text-muted-foreground truncate">
              {exportedFilename}
            </div>
            {warnings.length > 0 && (
              <div className="space-y-1 max-h-32 overflow-y-auto rounded-md bg-muted p-2 text-xs">
                <span className="font-medium text-muted-foreground">
                  {t("space.export.warningsCount", { count: warnings.length })}
                </span>
                {warnings.map((w, idx) => (
                  <p
                    key={`warning-${idx}-${w.slice(0, 10)}`}
                    className="truncate text-muted-foreground"
                  >
                    • {w}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {status === "error" && (
          <div className="space-y-3 py-2">
            <p role="alert" className="text-xs text-destructive">
              {errorMessage}
            </p>
          </div>
        )}

        <DialogFooter>
          {status === "idle" && (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                onClick={() => void startExport()}
                disabled={estimating || estimatedPages === 0}
              >
                <Download className="mr-1.5 size-4" />
                {t("space.export.start")}
              </Button>
            </>
          )}

          {status === "exporting" && (
            <Button type="button" variant="outline" onClick={cancelExport}>
              {t("common.cancel")}
            </Button>
          )}

          {status === "done" && (
            <Button type="button" onClick={() => onOpenChange(false)}>
              {t("common.confirm")}
            </Button>
          )}

          {status === "error" && (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="button" onClick={() => void startExport()}>
                {t("common.retry")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
