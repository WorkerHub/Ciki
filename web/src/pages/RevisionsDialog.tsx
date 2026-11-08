import { History, RotateCcw } from "lucide-react"
import { useEffect, useState } from "react"
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
  describeApiError,
  type PageDetail,
  pagesApi,
  type RevisionDetail,
  type RevisionSummary
} from "@/lib/api"
import { formatDateTime, formatRelative } from "@/lib/format"

/** 版本历史：列表 + 旧版预览 + 回滚（回滚本身会生成一条新版本）。 */
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
  /** 只读空间：可以看历史，但不渲染回滚入口。 */
  readOnly?: boolean
  onRestored: (page: PageDetail) => void
}) {
  const [revisions, setRevisions] = useState<RevisionSummary[]>([])
  const [selected, setSelected] = useState<RevisionDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setError("")
    setSelected(null)
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[80vh] max-h-[80vh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>版本历史</DialogTitle>
          <DialogDescription>
            每次保存都会留下一条记录。回滚会用旧版内容写回页面，并生成一条新记录。
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
                revisions.map((revision) => (
                  <li key={revision.id}>
                    <button
                      type="button"
                      onClick={() => void preview(revision.id)}
                      className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
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
                  </li>
                ))
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

        <DialogFooter className="items-center justify-between sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {readOnly
              ? "只读成员可以查看历史，回滚需要编辑权限。"
              : "回滚会用旧版内容写回页面，并生成一条新记录。"}
          </span>
          {readOnly ? null : (
            <Button
              type="button"
              size="sm"
              onClick={() => void restore()}
              disabled={!selected || restoring}
            >
              <RotateCcw aria-hidden="true" />
              {restoring ? "回滚中…" : "回滚到这个版本"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
