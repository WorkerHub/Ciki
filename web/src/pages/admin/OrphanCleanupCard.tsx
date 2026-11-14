import type { TFunction } from "i18next"
import { ScanSearch, Trash2 } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  ApiError,
  adminApi,
  describeApiError,
  type R2CleanupRunResult
} from "@/lib/api"
import { formatBytes } from "@/lib/format"

const MISSING_COUNTS_HINT_KEY = "admin.orphan.missingCounts"

/** 锁剩余时长的口语表达：一分钟以上按分钟圆整，不摆 1800 秒这种数。 */
function waitLabel(seconds: number, t: TFunction): string {
  return seconds >= 60
    ? t("admin.orphan.waitMinutes", { count: Math.ceil(seconds / 60) })
    : t("admin.orphan.waitSeconds", { count: seconds })
}

/**
 * 孤儿图片的两步清理：先 dry run 只算不删，再由管理员二次确认后实跑。
 * 清理判定、可清理数与删除全部来自 POST /admin/r2-cleanup，页面不另算一套。
 */
export function OrphanCleanupCard({
  runningSeconds,
  onBlocked,
  onRefresh
}: {
  /** 服务端此刻的清理锁剩余秒数；null = 没人在跑。 */
  runningSeconds: number | null
  /** 撞 409 时把「进行中」置到页面级状态（秒数取服务端 retryAfter）。 */
  onBlocked: (retryAfterSeconds: number) => void
  /** 实跑结束后重拉 GET：最近一轮摘要与运行态一起刷新。 */
  onRefresh: () => void
}) {
  const [scanning, setScanning] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [scan, setScan] = useState<R2CleanupRunResult | null>(null)
  const [run, setRun] = useState<R2CleanupRunResult | null>(null)
  const [error, setError] = useState("")
  const [confirmOpen, setConfirmOpen] = useState(false)
  const { t } = useTranslation()

  const locked = runningSeconds !== null
  const busy = scanning || cleaning
  const prunable = scan?.prunable ?? 0
  const prunableBytes = scan?.prunableBytes ?? 0

  const scanNow = async () => {
    setScanning(true)
    setError("")
    setRun(null)
    try {
      const result = await adminApi.runR2Cleanup(true)
      // 契约漂移（没有可清理数）时不拿 0 或 deleted 顶替，宁可不给第二步
      if (
        typeof result.prunable !== "number" ||
        typeof result.prunableBytes !== "number"
      ) {
        setScan(null)
        setError(t(MISSING_COUNTS_HINT_KEY))
        return
      }
      setScan(result)
    } catch (scanError: unknown) {
      if (
        scanError instanceof ApiError &&
        scanError.code === "CLEANUP_IN_PROGRESS"
      ) {
        onBlocked(scanError.retryAfter ?? 30)
        return
      }
      setError(describeApiError(scanError))
    } finally {
      setScanning(false)
    }
  }

  const cleanNow = async () => {
    setCleaning(true)
    setError("")
    try {
      const result = await adminApi.runR2Cleanup(false)
      // 扫出来的可清理数已被这一轮消耗：要再删一次必须重新扫描，
      // 这样确认框里的数量与将要删的量始终是同一份扫描结果。
      setScan(null)
      setRun(result)
    } catch (cleanError: unknown) {
      if (
        cleanError instanceof ApiError &&
        cleanError.code === "CLEANUP_IN_PROGRESS"
      ) {
        onBlocked(cleanError.retryAfter ?? 30)
        return
      }
      setError(describeApiError(cleanError))
    } finally {
      setCleaning(false)
      setConfirmOpen(false)
      // 实跑无论成败都写了日志行，摘要行跟着刷
      onRefresh()
    }
  }

  return (
    <section className="rounded-xl border border-border p-4">
      <h3 className="text-sm font-medium">{t("admin.orphan.title")}</h3>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || locked}
          onClick={() => void scanNow()}
        >
          <ScanSearch aria-hidden="true" />
          {scanning ? t("admin.orphan.scanning") : t("admin.orphan.scan")}
        </Button>
        {prunable > 0 ? (
          <Button
            type="button"
            size="sm"
            disabled={busy || locked}
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 aria-hidden="true" />
            {cleaning ? t("admin.orphan.cleaning") : t("admin.orphan.clean")}
          </Button>
        ) : null}
      </div>

      {runningSeconds !== null ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("admin.orphan.running", { wait: waitLabel(runningSeconds, t) })}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {scan ? (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          {t("admin.orphan.scanResult", {
            scanned: scan.scanned,
            referenced: scan.referenced,
            prunable,
            bytes: formatBytes(prunableBytes),
            skipped: scan.youngSkipped
          })}
        </p>
      ) : null}

      {run ? (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          {t("admin.orphan.runResult", {
            deleted: run.deleted,
            failed: run.failed
          })}
          {run.truncated ? t("admin.orphan.runRemaining") : ""}
        </p>
      ) : null}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("admin.orphan.confirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin.orphan.confirmDescription", {
                count: prunable,
                bytes: formatBytes(prunableBytes)
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cleaning}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={cleaning || locked}
              onClick={() => void cleanNow()}
            >
              {t("admin.orphan.confirm", { count: prunable })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
