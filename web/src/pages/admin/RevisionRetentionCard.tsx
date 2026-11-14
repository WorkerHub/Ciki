import { Scissors } from "lucide-react"
import { useEffect, useState } from "react"
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
import { Input } from "@/components/ui/input"
import {
  adminApi,
  describeApiError,
  type RevisionRetentionPreview,
  type SiteSettings
} from "@/lib/api"

const INVALID_LIMIT_HINT_KEY = "admin.retention.invalid"

/**
 * 历史版本保留数（全站一个值）＋ 按当前设置修剪全部页面。
 * 留空 = 不限，与后端「空串/缺行 = 不限」同一口径；0 只是接口层的宽容值，界面不接受。
 */
export function RevisionRetentionCard({
  limit,
  disabled,
  onSaved
}: {
  limit: number | null
  disabled?: boolean
  /** 保存成功后把服务端返回值交回页面，保证展示与落库一致。 */
  onSaved: (settings: SiteSettings) => void
}) {
  const [draft, setDraft] = useState(limit === null ? "" : String(limit))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [pruneOpen, setPruneOpen] = useState(false)
  const [preview, setPreview] = useState<RevisionRetentionPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState("")
  const [pruning, setPruning] = useState(false)
  const { t } = useTranslation()

  const locked = Boolean(disabled) || saving

  useEffect(() => {
    setDraft(limit === null ? "" : String(limit))
  }, [limit])

  /**
   * 预览只在「设置已保存完」之后才读：输入框失焦会先提交保存，
   * 立刻发预览请求会读到旧值，确认文案就与实际修剪口径不一致。
   */
  useEffect(() => {
    if (!pruneOpen || saving) return
    let alive = true
    setPreviewing(true)
    setPreview(null)
    setPreviewError("")
    adminApi
      .revisionRetention()
      .then((value) => {
        if (alive) setPreview(value)
      })
      .catch((loadError: unknown) => {
        if (alive) setPreviewError(describeApiError(loadError))
      })
      .finally(() => {
        if (alive) setPreviewing(false)
      })
    return () => {
      alive = false
    }
  }, [pruneOpen, saving])

  const save = async (value: number | null) => {
    const current = limit === null ? "" : String(limit)
    setSaving(true)
    setError("")
    setNotice("")
    try {
      await adminApi.saveSettings({ revisionRetentionLimit: value })
      // 回读一次确认真的落库：旧后端会忽略未知字段并回 200
      const saved = await adminApi.settings()
      const raw: unknown = saved.revisionRetentionLimit
      const savedLimit = typeof raw === "number" ? raw : null
      if (raw === undefined || savedLimit !== value) {
        setDraft(current)
        setError(t("admin.retention.notSaved"))
        return
      }
      onSaved(saved)
      setNotice(
        value === null
          ? t("admin.retention.savedUnlimited")
          : t("admin.retention.saved", { count: value })
      )
    } catch (saveError: unknown) {
      setDraft(current)
      setError(describeApiError(saveError))
    } finally {
      setSaving(false)
    }
  }

  const commit = () => {
    if (locked) return
    const current = limit === null ? "" : String(limit)
    const next = draft.trim()
    if (next === current) {
      setDraft(current)
      return
    }
    setError("")
    setNotice("")
    if (next === "") {
      void save(null)
      return
    }
    if (!/^\d+$/.test(next) || Number(next) < 1) {
      setDraft(current)
      setError(t(INVALID_LIMIT_HINT_KEY))
      return
    }
    void save(Number(next))
  }

  const runPrune = async () => {
    setPruning(true)
    setError("")
    setNotice("")
    try {
      const { deleted } = await adminApi.pruneAllRevisions()
      setNotice(
        deleted > 0
          ? t("admin.retention.deleted", { count: deleted })
          : t("admin.retention.nothingToDelete")
      )
    } catch (pruneError: unknown) {
      setError(describeApiError(pruneError))
    } finally {
      setPruning(false)
      setPruneOpen(false)
    }
  }

  const confirmable =
    preview !== null && preview.limit !== null && preview.prunableRevisions > 0

  const pruneDescription = (() => {
    if (previewing) return t("admin.retention.previewing")
    if (previewError) return previewError
    if (!preview) return t("admin.retention.previewing")
    if (preview.limit === null) return t("admin.retention.unlimited")
    if (preview.prunableRevisions === 0) {
      return t("admin.retention.nothingToPrune")
    }
    return t("admin.retention.preview", {
      count: preview.prunableRevisions,
      limit: preview.limit
    })
  })()

  return (
    <div className="space-y-2">
      {error ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
        >
          {notice}
        </p>
      ) : null}

      <div className="rounded-xl border border-border px-4">
        <div className="flex flex-col gap-2 border-b border-border py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">
              {t("admin.retention.limit.label")}
            </p>
            <p className="max-w-prose text-xs text-muted-foreground">
              {t("admin.retention.limit.description")}
            </p>
          </div>
          <Input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder={t("admin.retention.limit.placeholder")}
            aria-label={t("admin.retention.limit.label")}
            className="h-8 w-full sm:w-56"
            value={draft}
            disabled={locked}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commit()
              }
              if (event.key === "Escape") {
                event.preventDefault()
                setDraft(limit === null ? "" : String(limit))
              }
            }}
          />
        </div>
        <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <p className="max-w-prose text-xs text-muted-foreground">
            {t("admin.retention.pruneDescription")}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={locked || pruning || limit === null}
            onClick={() => setPruneOpen(true)}
          >
            <Scissors aria-hidden="true" />
            {t("admin.retention.prune")}
          </Button>
        </div>
      </div>

      <AlertDialog open={pruneOpen} onOpenChange={setPruneOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("admin.retention.pruneTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>{pruneDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pruning}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!confirmable || pruning}
              onClick={() => void runPrune()}
            >
              {t("admin.retention.pruneConfirm", {
                count: preview ? preview.prunableRevisions : 0
              })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
