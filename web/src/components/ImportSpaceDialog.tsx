import type { Space } from "@/lib/api"
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileArchive,
  Loader2
} from "lucide-react"
import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { spacePath } from "@/lib/routes"
import { calculateSha256 } from "@/lib/space-archive/checkpoint"
import {
  decompressZip,
  executeSpaceImport,
  preflightSpaceArchive
} from "@/lib/space-archive/import"
import type {
  ImportPreflightResult,
  ImportProgress,
  ImportReport
} from "@/lib/space-archive/types"
import { useSpacesStore } from "@/stores/spaces"

export interface ImportSpaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: (space?: Space) => void
}

export function ImportSpaceDialog({
  open,
  onOpenChange,
  onSuccess
}: ImportSpaceDialogProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const loadSpaces = useSpacesStore((s) => s.load)
  const selectSpace = useSpacesStore((s) => s.select)

  const [file, setFile] = useState<File | null>(null)
  const [entries, setEntries] = useState<Record<string, Uint8Array> | null>(
    null
  )
  const [sha256, setSha256] = useState("")
  const [phase, setPhase] = useState<
    | "select"
    | "preflighting"
    | "preflight_result"
    | "importing"
    | "report"
    | "error"
  >("select")
  const [preflightResult, setPreflightResult] =
    useState<ImportPreflightResult | null>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [errorMessage, setErrorMessage] = useState("")

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const reset = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setFile(null)
    setEntries(null)
    setSha256("")
    setPhase("select")
    setPreflightResult(null)
    setProgress(null)
    setReport(null)
    setErrorMessage("")
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0]
    if (!selected) return
    setFile(selected)
    setPhase("preflighting")
    setErrorMessage("")

    try {
      const [unzipped, hash] = await Promise.all([
        decompressZip(selected),
        calculateSha256(selected)
      ])
      setEntries(unzipped)
      setSha256(hash)

      const result = await preflightSpaceArchive(unzipped, hash)
      setPreflightResult(result)
      setPhase("preflight_result")
    } catch (err) {
      setPhase("error")
      setErrorMessage(
        err instanceof Error ? err.message : t("space.import.errorDecompress")
      )
    }
  }

  const runImport = async (resume: boolean) => {
    if (!entries || !preflightResult) return
    setPhase("importing")
    setErrorMessage("")

    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      const res = await executeSpaceImport(entries, preflightResult, sha256, {
        resume,
        signal: controller.signal,
        onProgress: (p) => setProgress(p)
      })
      setReport(res)
      setPhase("report")
      await loadSpaces()
      selectSpace(res.targetSpaceId)
      const currentSpace = useSpacesStore
        .getState()
        .spaces.find((s) => s.id === res.targetSpaceId)
      onSuccess?.(currentSpace)
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setPhase("preflight_result")
      } else {
        setPhase("error")
        setErrorMessage(
          err instanceof Error ? err.message : t("space.import.errorGeneric")
        )
      }
    } finally {
      abortControllerRef.current = null
    }
  }

  const cancelImport = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }

  const navigateToImportedSpace = () => {
    if (!report) return
    onOpenChange(false)
    navigate(spacePath(report.targetSpaceSlug))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (phase === "importing") return
        if (!v) reset()
        onOpenChange(v)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("space.import.title")}</DialogTitle>
          <DialogDescription>
            {phase === "select" && t("space.import.selectDescription")}
            {phase === "preflight_result" && file?.name}
            {phase === "importing" && t("space.import.importingDescription")}
            {phase === "report" && t("space.import.reportTitle")}
          </DialogDescription>
        </DialogHeader>

        {phase === "select" && (
          <div className="py-6">
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              className="hidden"
              onChange={handleFileChange}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-muted-foreground/30 p-8 text-center hover:border-primary/50 hover:bg-muted/40 cursor-pointer transition-colors"
            >
              <FileArchive className="size-10 text-muted-foreground" />
              <div className="space-y-1">
                <span className="text-sm font-medium">
                  {t("space.import.dropzone")}
                </span>
                <p className="text-xs text-muted-foreground">.zip</p>
              </div>
            </button>
          </div>
        )}

        {phase === "preflighting" && (
          <div className="flex flex-col items-center justify-center py-10 gap-3">
            <Loader2 className="size-8 animate-spin text-primary" />
            <span className="text-sm text-muted-foreground">
              {t("space.import.preflighting")}
            </span>
          </div>
        )}

        {phase === "preflight_result" && preflightResult && (
          <div className="space-y-4 py-2">
            {!preflightResult.valid ? (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                  <AlertTriangle className="size-4 shrink-0" />
                  <span>{t("space.import.fatalErrorsTitle")}</span>
                </div>
                <div className="max-h-48 overflow-y-auto rounded-lg border border-destructive/20 bg-destructive/10 p-3 space-y-1 text-xs text-destructive">
                  {preflightResult.fatalErrors.map((err, idx) => (
                    <p key={`fatal-${err.code}-${idx}`}>• {err.message}</p>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg border p-2.5">
                    <span className="text-muted-foreground">
                      {t("space.import.pagesCount")}
                    </span>
                    <p className="text-lg font-semibold tabular-nums mt-0.5">
                      {preflightResult.pageCount}
                    </p>
                  </div>
                  <div className="rounded-lg border p-2.5">
                    <span className="text-muted-foreground">
                      {t("space.import.filesCount")}
                    </span>
                    <p className="text-lg font-semibold tabular-nums mt-0.5">
                      {preflightResult.fileCounts.total}
                    </p>
                  </div>
                </div>

                <div className="rounded-lg border p-2.5 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                  <span>
                    {t("space.import.catImages")}:{" "}
                    <strong className="text-foreground">
                      {preflightResult.fileCounts.images}
                    </strong>
                  </span>
                  <span>
                    {t("space.import.catEmbeds")}:{" "}
                    <strong className="text-foreground">
                      {preflightResult.fileCounts.embeds}
                    </strong>
                  </span>
                  <span>
                    {t("space.import.catCanvases")}:{" "}
                    <strong className="text-foreground">
                      {preflightResult.fileCounts.canvases}
                    </strong>
                  </span>
                  <span>
                    {t("space.import.catFiles")}:{" "}
                    <strong className="text-foreground">
                      {preflightResult.fileCounts.files}
                    </strong>
                  </span>
                </div>

                {preflightResult.missingFilesCount > 0 && (
                  <div className="text-xs text-muted-foreground">
                    {t("space.import.missingCount", {
                      count: preflightResult.missingFilesCount
                    })}
                  </div>
                )}

                {/* 失败处置口径一句话提示 */}
                <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  {t("space.import.failureNotice")}
                </div>
              </div>
            )}
          </div>
        )}

        {phase === "importing" && (
          <div className="space-y-4 py-3">
            <div className="space-y-2 text-xs">
              <div className="flex justify-between text-muted-foreground">
                <span>
                  {progress?.stage === "uploading_files"
                    ? t("space.import.stageFiles")
                    : progress?.stage === "creating_skeleton"
                      ? t("space.import.stageSkeleton")
                      : t("space.import.stageContent")}
                </span>
                <span className="tabular-nums">
                  {progress?.stage === "uploading_files"
                    ? `${progress?.completedFiles ?? 0} / ${progress?.totalFiles ?? 0}`
                    : `${progress?.completedPages ?? 0} / ${progress?.totalPages ?? 0}`}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round(
                        progress?.stage === "uploading_files"
                          ? ((progress?.completedFiles ?? 0) /
                              Math.max(1, progress?.totalFiles ?? 1)) *
                              33
                          : progress?.stage === "creating_skeleton"
                            ? 33 +
                              ((progress?.completedPages ?? 0) /
                                Math.max(1, progress?.totalPages ?? 1)) *
                                33
                            : 66 +
                              ((progress?.completedPages ?? 0) /
                                Math.max(1, progress?.totalPages ?? 1)) *
                                34
                      )
                    )}%`
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {phase === "report" && report && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 font-medium">
              <CheckCircle2 className="size-5 shrink-0" />
              <span>{t("space.import.completedTitle")}</span>
            </div>

            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="rounded-lg border p-2.5">
                <span className="text-muted-foreground">
                  {t("space.import.targetSpaceId")}
                </span>
                <p className="text-lg font-semibold tabular-nums mt-0.5">
                  #{report.targetSpaceId}
                </p>
              </div>
              <div className="rounded-lg border p-2.5">
                <span className="text-muted-foreground">
                  {t("space.import.importedPages")}
                </span>
                <p className="text-lg font-semibold tabular-nums mt-0.5">
                  {report.pageCount}
                </p>
              </div>
              <div className="rounded-lg border p-2.5">
                <span className="text-muted-foreground">
                  {t("space.import.remappedLinks")}
                </span>
                <p className="text-lg font-semibold tabular-nums mt-0.5">
                  {report.remappedLinksCount}
                </p>
              </div>
            </div>

            <div className="rounded-lg border p-2.5 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
              <span>
                {t("space.import.catImages")}:{" "}
                <strong className="text-foreground">
                  {report.fileCounts.images}
                </strong>
              </span>
              <span>
                {t("space.import.catEmbeds")}:{" "}
                <strong className="text-foreground">
                  {report.fileCounts.embeds}
                </strong>
              </span>
              <span>
                {t("space.import.catCanvases")}:{" "}
                <strong className="text-foreground">
                  {report.fileCounts.canvases}
                </strong>
              </span>
              <span>
                {t("space.import.catFiles")}:{" "}
                <strong className="text-foreground">
                  {report.fileCounts.files}
                </strong>
              </span>
            </div>

            {report.missingFilesCount > 0 && (
              <div className="text-xs text-muted-foreground">
                {t("space.import.missingCount", {
                  count: report.missingFilesCount
                })}
              </div>
            )}

            {report.failedFiles.length > 0 && (
              <div className="space-y-1 max-h-28 overflow-y-auto rounded-lg border border-destructive/20 bg-destructive/10 p-2.5 text-xs text-destructive">
                <span className="font-medium">
                  {t("space.import.failedFilesCount", {
                    count: report.failedFiles.length
                  })}
                </span>
                {report.failedFiles.map((ff, idx) => (
                  <p key={`ff-${ff.originalKey}-${idx}`} className="truncate">
                    • {ff.originalKey} ({ff.reason})
                  </p>
                ))}
              </div>
            )}

            {report.warnings.length > 0 && (
              <div className="space-y-1 max-h-24 overflow-y-auto rounded-lg bg-muted p-2 text-xs text-muted-foreground">
                <span className="font-medium">
                  {t("space.import.transferredWarnings", {
                    count: report.warnings.length
                  })}
                </span>
                {report.warnings.map((w, idx) => (
                  <p key={`warn-${idx}-${w.slice(0, 15)}`} className="truncate">
                    • {w}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {phase === "error" && (
          <div className="space-y-2 py-2">
            <p role="alert" className="text-xs text-destructive">
              {errorMessage}
            </p>
          </div>
        )}

        <DialogFooter>
          {phase === "select" && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
          )}

          {phase === "preflight_result" && (
            <>
              <Button type="button" variant="ghost" onClick={reset}>
                {t("space.import.reselect")}
              </Button>
              {preflightResult?.valid ? (
                preflightResult.hasCheckpoint ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void runImport(false)}
                    >
                      {t("space.import.restart")}
                    </Button>
                    <Button type="button" onClick={() => void runImport(true)}>
                      {t("space.import.resume")}
                    </Button>
                  </>
                ) : (
                  <Button type="button" onClick={() => void runImport(false)}>
                    {t("space.import.start")}
                  </Button>
                )
              ) : null}
            </>
          )}

          {phase === "importing" && (
            <Button type="button" variant="outline" onClick={cancelImport}>
              {t("common.cancel")}
            </Button>
          )}

          {phase === "report" && (
            <Button type="button" onClick={navigateToImportedSpace}>
              {t("space.import.goToSpace")}
              <ArrowRight className="ml-1 size-4" />
            </Button>
          )}

          {phase === "error" && (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="button" onClick={reset}>
                {t("common.retry")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
