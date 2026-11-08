import { Empty } from "@cloudflare/kumo/components/empty"
import { RotateCcw, Trash2, TrashIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router"
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
import { describeApiError, pagesApi, type TrashNode } from "@/lib/api"
import { formatDateTime, formatRelative } from "@/lib/format"
import { canEdit } from "@/lib/space"
import { useSpaceRole } from "@/hooks/useSpaceRole"
import { usePagesStore } from "@/stores/pages"
import { useSpacesStore } from "@/stores/spaces"

/** 回收站：恢复整批删除的子树，或彻底删除（不可恢复）。 */
export function TrashPage() {
  const restorePage = usePagesStore((state) => state.restorePage)
  const purgePage = usePagesStore((state) => state.purgePage)
  const currentSpaceId = useSpacesStore((state) => state.currentId)
  const spaces = useSpacesStore((state) => state.spaces)
  const spaceName =
    spaces.find((space) => space.id === currentSpaceId)?.name ?? null
  const readOnly = !canEdit(useSpaceRole(currentSpaceId))
  const [items, setItems] = useState<TrashNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [purgeTarget, setPurgeTarget] = useState<TrashNode | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      setItems(await pagesApi.trash(currentSpaceId))
    } catch (loadError) {
      setError(describeApiError(loadError))
    } finally {
      setLoading(false)
    }
  }, [currentSpaceId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 font-heading text-xl font-semibold tracking-tight">
          <Trash2 className="size-4 text-muted-foreground" aria-hidden="true" />
          回收站
        </h1>
        <p className="text-xs text-muted-foreground">
          {spaceName ? `当前空间：${spaceName}。` : ""}
          软删除的页面会连同子页面一起停在这里；彻底删除会连版本历史一起清掉，无法恢复。
          {readOnly ? "你是只读成员，只能查看。" : ""}
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="space-y-2" role="status" aria-label="回收站加载中">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="h-12 animate-pulse rounded-lg bg-muted/60"
            />
          ))}
        </div>
      ) : items.length === 0 ? (
        <Empty
          icon={<TrashIcon />}
          title="回收站是空的"
          description="被删除的页面会先到这里，可以恢复或彻底删除。"
          contents={
            <Button asChild size="sm" variant="outline">
              <Link to="/">回到页面</Link>
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-2 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{item.title}</p>
                <p className="text-[11px] text-muted-foreground">
                  删除于 {formatRelative(item.deletedAt)}（
                  {formatDateTime(item.deletedAt)}）
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                {readOnly ? null : (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true)
                        setError("")
                        try {
                          await restorePage(item.id)
                          await load()
                        } catch (restoreError) {
                          setError(describeApiError(restoreError))
                        } finally {
                          setBusy(false)
                        }
                      }}
                    >
                      <RotateCcw aria-hidden="true" />
                      恢复
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => setPurgeTarget(item)}
                    >
                      彻底删除
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog
        open={purgeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPurgeTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              彻底删除「{purgeTarget?.title}」？
            </AlertDialogTitle>
            <AlertDialogDescription>
              页面与它的全部版本记录会被永久删除，无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!purgeTarget) return
                setBusy(true)
                try {
                  await purgePage(purgeTarget.id)
                  setPurgeTarget(null)
                  await load()
                } catch (purgeError) {
                  setError(describeApiError(purgeError))
                } finally {
                  setBusy(false)
                }
              }}
            >
              彻底删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
