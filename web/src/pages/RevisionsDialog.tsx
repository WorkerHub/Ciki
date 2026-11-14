import { RotateCcw, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ReadView } from "@/editor/ReadView"
import {
  ApiError,
  describeApiError,
  type PageDetail,
  pagesApi,
  type RevisionDetail,
  type RevisionSummary
} from "@/lib/api"
import { formatDateTime, formatRelative } from "@/lib/format"

/** 删除成功的轻提示：浮在弹窗之上，约 3 秒自动消失，不占版面。 */
const TOAST_DURATION = 3000

/**
 * 版本历史：列表 + 旧版预览 + 回滚（回滚本身会生成一条新版本），
 * 以及删除单条版本 / 按页只保留最新一条（权限与回滚同档：能编辑该页才渲染入口）。
 *
 * 骨架只有两段：标题栏 + 主体。主体左列表右预览，各自栏内滚动；
 * 没有独立页脚——回滚按钮挂在预览栏头部，批量入口挂在列表栏头部。
 */
export function RevisionsDialog({
  pageId,
  open,
  onOpenChange,
  readOnly = false,
  onRestored
}: {
  pageId: number
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 只读空间：可以看历史，但不渲染回滚与删除入口。 */
  readOnly?: boolean
  onRestored: (page: PageDetail) => void
}) {
  const [revisions, setRevisions] = useState<RevisionSummary[]>([])
  const [selected, setSelected] = useState<RevisionDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [restoring, setRestoring] = useState(false)
  // 删除与批量修剪共用：任一请求在飞时锁住全部删除入口
  const [busy, setBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<RevisionSummary | null>(null)
  const [pruneOpen, setPruneOpen] = useState(false)
  const { t } = useTranslation()

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setError("")
    setSelected(null)
    setDeleteTarget(null)
    setPruneOpen(false)
    pagesApi
      .revisions(pageId)
      .then((list) => {
        if (!alive) return
        setRevisions(list)
      })
      .catch((loadError: unknown) => {
        if (alive) setError(describeApiError(loadError))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open, pageId])

  /** 409/404 之后重拉一次：让「最新」重新指向服务端认定的那一条。 */
  const refreshList = async () => {
    try {
      setRevisions(await pagesApi.revisions(pageId))
    } catch (loadError) {
      setError(describeApiError(loadError))
    }
  }

  const preview = async (versionNo: number) => {
    setError("")
    try {
      const detail = await pagesApi.revision(pageId, versionNo)
      setSelected(detail)
    } catch (previewError) {
      setError(describeApiError(previewError))
    }
  }

  const restore = async () => {
    if (!selected) return
    setRestoring(true)
    setError("")
    try {
      const updated = await pagesApi.restoreRevision(pageId, selected.versionNo)
      onRestored(updated)
      onOpenChange(false)
    } catch (restoreError) {
      setError(describeApiError(restoreError))
    } finally {
      setRestoring(false)
    }
  }

  const removeRevision = async () => {
    if (!deleteTarget) return
    const targetVersion = deleteTarget.versionNo
    setBusy(true)
    setError("")
    try {
      await pagesApi.deleteRevision(pageId, targetVersion)
      // 只删这一条版本行：其余版本、页面当前内容都不受影响，本地去掉即可
      setRevisions((prev) =>
        prev.filter((revision) => revision.versionNo !== targetVersion)
      )
      setSelected((prev) => (prev?.versionNo === targetVersion ? null : prev))
      toast.success(t("page.revisions.deleted"), { duration: TOAST_DURATION })
    } catch (deleteError: unknown) {
      setError(describeApiError(deleteError))
      // 别处刚保存过（目标不再是最新）或已被删除：重拉列表纠正「最新」的落点
      if (
        deleteError instanceof ApiError &&
        (deleteError.code === "REVISION_IS_LATEST" ||
          deleteError.status === 404)
      ) {
        await refreshList()
      }
    } finally {
      setBusy(false)
      setDeleteTarget(null)
    }
  }

  const pruneRest = async () => {
    setBusy(true)
    setError("")
    try {
      const { deleted } = await pagesApi.pruneRevisions(pageId)
      const kept = revisions[0] ?? null
      setRevisions(kept ? [kept] : [])
      setSelected((prev) =>
        prev && kept && prev.versionNo === kept.versionNo ? prev : null
      )
      if (deleted > 0) {
        toast.success(t("page.revisions.deletedCount", { count: deleted }), {
          duration: TOAST_DURATION
        })
      } else {
        toast(t("page.revisions.nothingToDelete"), {
          duration: TOAST_DURATION
        })
      }
    } catch (pruneError: unknown) {
      setError(describeApiError(pruneError))
    } finally {
      setBusy(false)
      setPruneOpen(false)
    }
  }

  // 列表按 version_no DESC 排序，首项就是最新的一条
  const latestVersion = revisions[0]?.versionNo
  const prunableCount = Math.max(revisions.length - 1, 0)
  // 未选中、或选中的就是最新一条：不渲染回滚按钮（连禁用态都不留）
  const canRestore =
    !readOnly && selected !== null && selected.versionNo !== latestVersion

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] w-full flex-col gap-3 overflow-hidden p-5 sm:max-w-[900px] sm:p-6">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>{t("page.revisions.title")}</DialogTitle>
        </DialogHeader>

        {error ? (
          <p
            role="alert"
            className="shrink-0 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[288px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]">
          <section
            aria-label={t("page.revisions.listLabel")}
            className="flex max-h-[30vh] min-h-0 flex-col overflow-hidden rounded-lg border border-border md:max-h-none"
          >
            <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border pr-1.5 pl-3">
              <span className="text-xs text-muted-foreground">
                {loading
                  ? t("page.revisions.loading")
                  : t("page.revisions.count", { count: revisions.length })}
              </span>
              {!readOnly && prunableCount > 0 ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setPruneOpen(true)}
                >
                  <Trash2 aria-hidden="true" />
                  {t("page.revisions.keepLatest")}
                </Button>
              ) : null}
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <ul className="divide-y divide-border">
                {loading ? (
                  <li className="px-3 py-4 text-sm text-muted-foreground">
                    {t("page.revisions.loading")}
                  </li>
                ) : revisions.length === 0 ? (
                  <li className="px-3 py-4 text-sm text-muted-foreground">
                    {t("page.revisions.empty")}
                  </li>
                ) : (
                  revisions.map((revision) => {
                    const isLatest = revision.versionNo === latestVersion
                    const isSelected =
                      selected?.versionNo === revision.versionNo
                    return (
                      <li key={revision.versionNo} className="relative">
                        <button
                          type="button"
                          onClick={() => void preview(revision.versionNo)}
                          aria-current={isSelected ? "true" : undefined}
                          className={`flex w-full min-w-0 flex-col items-start gap-0.5 py-3 pr-9 pl-3 text-left transition-colors hover:bg-accent ${
                            isSelected ? "bg-accent" : ""
                          }`}
                        >
                          <span className="flex w-full items-center gap-1.5">
                            <span className="truncate text-sm font-medium">
                              {t("page.revisions.versionNo", {
                                no: revision.versionNo
                              })}
                            </span>
                            {isLatest ? (
                              <Badge
                                variant="secondary"
                                className="h-4 shrink-0 rounded px-1.5 text-[0.65rem]"
                              >
                                {t("page.revisions.latest")}
                              </Badge>
                            ) : null}
                          </span>
                          <span className="max-w-full truncate text-xs text-muted-foreground">
                            {formatDateTime(revision.createdAt)} ·{" "}
                            {formatRelative(revision.createdAt)}
                          </span>
                        </button>
                        {isSelected ? (
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-primary"
                          />
                        ) : null}
                        {!readOnly && !isLatest ? (
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground hover:text-destructive"
                            aria-label={t("page.revisions.deleteOneLabel")}
                            title={t("page.revisions.deleteOneLabel")}
                            disabled={busy}
                            onClick={() => setDeleteTarget(revision)}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        ) : null}
                      </li>
                    )
                  })
                )}
              </ul>
            </ScrollArea>
          </section>

          <section
            aria-label={t("page.revisions.previewLabel")}
            className="flex max-h-[34vh] min-h-[7rem] flex-col overflow-hidden rounded-lg border border-border md:max-h-none md:min-h-0"
          >
            {selected ? (
              <>
                <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border pr-1.5 pl-3">
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {t("page.revisions.previewVersion", {
                      no: selected.versionNo,
                      time: formatDateTime(selected.createdAt)
                    })}
                  </span>
                  {canRestore ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={restoring}
                      onClick={() => void restore()}
                    >
                      <RotateCcw aria-hidden="true" />
                      {restoring
                        ? t("page.revisions.restoring")
                        : t("page.revisions.restore")}
                    </Button>
                  ) : null}
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="px-4 py-3">
                    <ReadView html={selected.contentHtml} />
                  </div>
                </ScrollArea>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center px-6 py-8">
                <p className="text-xs text-muted-foreground">
                  {t("page.revisions.selectHint")}
                </p>
              </div>
            )}
          </section>
        </div>
      </DialogContent>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("page.revisions.deleteDialog.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("page.revisions.deleteDialog.description", {
                target: deleteTarget
                  ? t("page.revisions.deleteDialog.target", {
                      no: deleteTarget.versionNo,
                      time: formatDateTime(deleteTarget.createdAt)
                    })
                  : t("page.revisions.deleteDialog.targetFallback")
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void removeRevision()}
            >
              {t("page.revisions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pruneOpen} onOpenChange={setPruneOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("page.revisions.pruneDialog.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("page.revisions.pruneDialog.description", {
                count: prunableCount
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void pruneRest()}
            >
              {t("page.revisions.pruneDialog.confirm", {
                count: prunableCount
              })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
