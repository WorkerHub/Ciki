import { Empty } from "@cloudflare/kumo/components/empty"
import { RotateCcw, Trash2, TrashIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router"
import { SpaceSwitcher } from "@/components/SpaceSwitcher"
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
import { useSpaceRole } from "@/hooks/useSpaceRole"
import { describeApiError, pagesApi, type TrashNode } from "@/lib/api"
import { formatDateTime, formatRelative } from "@/lib/format"
import { spaceTrashPath } from "@/lib/routes"
import { canEdit } from "@/lib/space"
import { usePagesStore } from "@/stores/pages"
import { useSpacesStore } from "@/stores/spaces"

/** 回收站：恢复整批删除的子树，或彻底删除（不可恢复）。 */
export function TrashPage() {
  const { t } = useTranslation()
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
        {/* 回收站按空间隔离，页头直接给切换入口（切完留在本页按新空间重拉列表）；
            宽度收窄成控件尺寸，-ml-2 抵消切换器自身的水平内边距，左边缘与标题对齐 */}
        <div className="-ml-2 max-w-64">
          <SpaceSwitcher switchPath={(space) => spaceTrashPath(space.slug)} />
        </div>
        <h1 className="flex items-center gap-2 font-heading text-xl font-semibold tracking-tight">
          <Trash2 className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("trash.title")}
        </h1>
        {/* 三段分句各成一个元素：英文句子之间靠外边距留白，中文 textContent
            与拆开前逐字一致（不插入空白字符） */}
        <p className="text-xs text-muted-foreground">
          {spaceName ? (
            <span className="mr-1">
              {t("trash.currentSpace", { name: spaceName })}
            </span>
          ) : null}
          {t("trash.description")}
          {readOnly ? (
            <span className="ml-1">{t("trash.readOnly")}</span>
          ) : null}
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
        <div
          className="space-y-2"
          role="status"
          aria-label={t("trash.loadingLabel")}
        >
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
          title={t("trash.empty.title")}
          description={t("trash.empty.description")}
          contents={
            <Button asChild size="sm" variant="outline">
              <Link to="/">{t("trash.empty.action")}</Link>
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
                  {t("trash.deletedAt", {
                    relative: formatRelative(item.deletedAt),
                    absolute: formatDateTime(item.deletedAt)
                  })}
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
                      {t("trash.restore")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => setPurgeTarget(item)}
                    >
                      {t("trash.purge")}
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
              {t("trash.purgeDialog.title", {
                title: purgeTarget?.title ?? ""
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("trash.purgeDialog.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
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
              {t("trash.purge")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
