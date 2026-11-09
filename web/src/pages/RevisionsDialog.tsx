import { History, RotateCcw, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
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

/**
 * 版本历史：列表 + 旧版预览 + 回滚（回滚本身会生成一条新版本），
 * 以及删除单条版本 / 按页只保留最新一条（权限与回滚同档：能编辑该页才渲染入口）。
 */
export function RevisionsDialog({
  pageId,
  open,
  onOpenChange,
  readOnly = false,
  onRestored
}: {
  pageId: string
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
  const [notice, setNotice] = useState("")
  const [restoring, setRestoring] = useState(false)
  // 删除与批量修剪共用：任一请求在飞时锁住全部删除入口
  const [busy, setBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<RevisionSummary | null>(null)
  const [pruneOpen, setPruneOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setError("")
    setNotice("")
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

  const preview = async (revisionId: string) => {
    setError("")
    try {
      const detail = await pagesApi.revision(pageId, revisionId)
      setSelected(detail)
    } catch (previewError) {
      setError(describeApiError(previewError))
    }
  }

  const restore = async () => {
    if (!selected) return
    setRestoring(true)
    setError("")
    setNotice("")
    try {
      const updated = await pagesApi.restoreRevision(pageId, selected.id)
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
    const targetId = deleteTarget.id
    setBusy(true)
    setError("")
    setNotice("")
    try {
      await pagesApi.deleteRevision(pageId, targetId)
      // 只删这一条版本行：其余版本、页面当前内容都不受影响，本地去掉即可
      setRevisions((prev) =>
        prev.filter((revision) => revision.id !== targetId)
      )
      setSelected((prev) => (prev?.id === targetId ? null : prev))
      setNotice("版本已删除。")
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
    setNotice("")
    try {
      const { deleted } = await pagesApi.pruneRevisions(pageId)
      const kept = revisions[0] ?? null
      setRevisions(kept ? [kept] : [])
      setSelected((prev) => (prev && kept && prev.id === kept.id ? prev : null))
      setNotice(
        deleted > 0 ? `已删除 ${deleted} 条版本。` : "没有可删除的版本。"
      )
    } catch (pruneError: unknown) {
      setError(describeApiError(pruneError))
    } finally {
      setBusy(false)
      setPruneOpen(false)
    }
  }

  // 列表按 created_at DESC, rowid DESC 排序，首项就是最新的一条
  const latestId = revisions[0]?.id
  const prunableCount = Math.max(revisions.length - 1, 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[80vh] max-h-[80vh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>版本历史</DialogTitle>
          <DialogDescription>
            每次保存都会留下一条记录。最新的那条版本不能删除；回滚会用旧版内容写回页面，并生成一条新记录。
          </DialogDescription>
        </DialogHeader>

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

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[15rem_1fr]">
          <ScrollArea className="h-full min-h-0 rounded-md border border-border">
            <ul className="divide-y divide-border">
              {loading ? (
                <li className="px-3 py-4 text-sm text-muted-foreground">
                  加载中…
                </li>
              ) : revisions.length === 0 ? (
                <li className="px-3 py-4 text-sm text-muted-foreground">
                  还没有版本记录。
                </li>
              ) : (
                revisions.map((revision) => {
                  const canDelete = !readOnly && revision.id !== latestId
                  return (
                    <li key={revision.id} className="flex items-stretch">
                      <button
                        type="button"
                        onClick={() => void preview(revision.id)}
                        className={`flex min-w-0 flex-1 flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
                          selected?.id === revision.id ? "bg-accent" : ""
                        }`}
                      >
                        <span className="font-medium">
                          {formatDateTime(revision.createdAt)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatRelative(revision.createdAt)} ·{" "}
                          {revision.editorId.slice(0, 8)}
                        </span>
                      </button>
                      {canDelete ? (
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          className="my-1 mr-1 shrink-0 text-muted-foreground hover:text-destructive"
                          aria-label="删除这个版本"
                          title="删除这个版本"
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

          <div className="flex min-h-0 flex-col rounded-md border border-border">
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <History className="size-3.5" aria-hidden="true" />
                {selected ? `${selected.title}` : "选择左侧任一版本查看内容"}
              </span>
            </div>
            <Separator />
            <ScrollArea className="min-h-0 flex-1 p-3">
              {selected ? <ReadView html={selected.contentHtml} /> : null}
            </ScrollArea>
          </div>
        </div>

        <DialogFooter className="items-center justify-between gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {readOnly
              ? "只读成员可以查看历史，删除与回滚需要编辑权限。"
              : "删除版本不可恢复；每页最新的一条不能删。"}
          </span>
          <div className="flex items-center gap-2">
            {readOnly ? null : (
              <>
                {prunableCount > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setPruneOpen(true)}
                  >
                    <Trash2 aria-hidden="true" />
                    只保留最新一条
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void restore()}
                  disabled={!selected || restoring}
                >
                  <RotateCcw aria-hidden="true" />
                  {restoring ? "回滚中…" : "回滚到这个版本"}
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这个版本？</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `${formatDateTime(deleteTarget.createdAt)} 的版本`
                : "这个版本"}
              将被永久删除，无法恢复。页面当前内容与其他版本不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void removeRevision()}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pruneOpen} onOpenChange={setPruneOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>只保留最新的一条版本？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除其余 {prunableCount}{" "}
              条版本，删除后无法恢复。页面当前内容与最新的一条版本不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void pruneRest()}
            >
              删除 {prunableCount} 条
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
