import { Empty } from "@cloudflare/kumo/components/empty"
import { RotateCcw, Trash2, TrashIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router"
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
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"
import { describeApiError, pagesApi, type TrashNode } from "@/lib/api"
import { formatDateTime } from "@/lib/format"
import { canEdit, effectiveRole, roleForSpace } from "@/lib/space"
import { useAuthStore } from "@/stores/auth"
import { usePagesStore } from "@/stores/pages"
import { useSpacesStore } from "@/stores/spaces"

interface PurgeTarget {
  type: "single" | "batch" | "clear"
  items: TrashNode[]
}

/** 回收站：跨空间汇总表 + 批量清理，恢复整批删除的子树或彻底删除（不可恢复）。 */
export function TrashPage() {
  const { t } = useTranslation()
  const restorePage = usePagesStore((state) => state.restorePage)
  const purgePage = usePagesStore((state) => state.purgePage)
  const batchTrash = usePagesStore((state) => state.batchTrash)
  const spaces = useSpacesStore((state) => state.spaces)
  const isSiteAdmin = useAuthStore((state) => state.user?.role === "admin")

  const [selectedSpaceId, setSelectedSpaceId] = useState<string>("all")
  const [items, setItems] = useState<TrashNode[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [purgeTarget, setPurgeTarget] = useState<PurgeTarget | null>(null)
  const [busy, setBusy] = useState(false)

  const selectedSpace = useMemo(
    () => spaces.find((space) => String(space.id) === selectedSpaceId) ?? null,
    [spaces, selectedSpaceId]
  )

  const isCurrentFilteredReadOnly = useMemo(() => {
    if (selectedSpace) {
      return !canEdit(effectiveRole(selectedSpace, isSiteAdmin))
    }
    return (
      spaces.length > 0 &&
      spaces.every((space) => !canEdit(effectiveRole(space, isSiteAdmin)))
    )
  }, [selectedSpace, spaces, isSiteAdmin])

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const spaceId =
        selectedSpaceId === "all" ? undefined : Number(selectedSpaceId)
      const data = await pagesApi.trash(spaceId)
      setItems(data)
    } catch (loadError) {
      setError(describeApiError(loadError))
    } finally {
      setLoading(false)
    }
  }, [selectedSpaceId])

  useEffect(() => {
    void load()
  }, [load])

  const displayedItems = useMemo(() => {
    if (selectedSpaceId === "all") return items
    return items.filter(
      (item) => !item.spaceId || String(item.spaceId) === selectedSpaceId
    )
  }, [items, selectedSpaceId])

  const canEditItem = useCallback(
    (item: TrashNode) => {
      const role = roleForSpace(spaces, item.spaceId, isSiteAdmin)
      return canEdit(role)
    },
    [spaces, isSiteAdmin]
  )

  const editableItems = useMemo(
    () => displayedItems.filter((item) => canEditItem(item)),
    [displayedItems, canEditItem]
  )

  const selectedItems = useMemo(
    () => editableItems.filter((item) => selectedIds.has(item.id)),
    [editableItems, selectedIds]
  )

  const allSelected =
    editableItems.length > 0 &&
    editableItems.every((item) => selectedIds.has(item.id))
  const someSelected =
    !allSelected && editableItems.some((item) => selectedIds.has(item.id))

  const handleToggleAll = () => {
    if (allSelected) {
      const next = new Set(selectedIds)
      for (const item of editableItems) {
        next.delete(item.id)
      }
      setSelectedIds(next)
    } else {
      const next = new Set(selectedIds)
      for (const item of editableItems) {
        next.add(item.id)
      }
      setSelectedIds(next)
    }
  }

  const toggleSelectItem = (id: number, checked: boolean) => {
    const next = new Set(selectedIds)
    if (checked) {
      next.add(id)
    } else {
      next.delete(id)
    }
    setSelectedIds(next)
  }

  const handleSingleRestore = async (item: TrashNode) => {
    setBusy(true)
    setError("")
    try {
      await restorePage(item.id)
      if (selectedIds.has(item.id)) {
        const next = new Set(selectedIds)
        next.delete(item.id)
        setSelectedIds(next)
      }
      await load()
    } catch (restoreError) {
      setError(describeApiError(restoreError))
    } finally {
      setBusy(false)
    }
  }

  const handleBatchRestore = async () => {
    if (selectedItems.length === 0) return
    setBusy(true)
    setError("")
    try {
      const ids = selectedItems.map((item) => item.id)
      const res = await batchTrash("restore", ids)
      const okCount = res.results.filter((r) => r.ok).length
      const failCount = res.results.filter((r) => !r.ok).length
      const failedIds = new Set(
        res.results.filter((r) => !r.ok).map((r) => r.id)
      )

      if (failCount > 0) {
        toast(t("trash.batchResult", { success: okCount, failed: failCount }))
      } else {
        toast.success(t("trash.batchSuccess", { count: okCount }))
      }

      setSelectedIds(failedIds)
      await load()
    } catch (batchError) {
      setError(describeApiError(batchError))
    } finally {
      setBusy(false)
    }
  }

  const handleBatchPurge = () => {
    if (selectedItems.length === 0) return
    setPurgeTarget({
      type: "batch",
      items: selectedItems
    })
  }

  const handleClearTrash = () => {
    if (editableItems.length === 0) return
    setPurgeTarget({
      type: "clear",
      items: editableItems
    })
  }

  const handleConfirmPurge = async () => {
    if (!purgeTarget) return
    setBusy(true)
    setError("")
    try {
      if (purgeTarget.type === "single") {
        const item = purgeTarget.items[0]
        await purgePage(item.id)
        setPurgeTarget(null)
        if (selectedIds.has(item.id)) {
          const next = new Set(selectedIds)
          next.delete(item.id)
          setSelectedIds(next)
        }
        await load()
      } else {
        const ids = purgeTarget.items.map((it) => it.id)
        const res = await batchTrash("purge", ids)
        setPurgeTarget(null)
        const okCount = res.results.filter((r) => r.ok).length
        const failCount = res.results.filter((r) => !r.ok).length
        const failedIds = new Set(
          res.results.filter((r) => !r.ok).map((r) => r.id)
        )

        if (failCount > 0) {
          toast(
            t("trash.batchResult", { success: okCount, failed: failCount })
          )
        } else {
          toast.success(t("trash.batchSuccess", { count: okCount }))
        }

        setSelectedIds(failedIds)
        await load()
      }
    } catch (purgeError) {
      setError(describeApiError(purgeError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <h1 className="flex items-center gap-2 font-heading text-xl font-semibold tracking-tight">
          <Trash2 className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("trash.title")}
        </h1>
        <p className="text-xs text-muted-foreground">
          {selectedSpace ? (
            <span className="mr-1">
              {t("trash.currentSpace", { name: selectedSpace.name })}
            </span>
          ) : (
            <span className="mr-1">{t("trash.allSpacesSummary")}</span>
          )}
          {t("trash.description")}
          {isCurrentFilteredReadOnly ? (
            <span className="ml-1">{t("trash.readOnly")}</span>
          ) : null}
        </p>

        {/* 顶部空间筛选与清空回收站 */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-2">
            <Select
              value={selectedSpaceId}
              onValueChange={(val) => {
                setSelectedSpaceId(val)
                setSelectedIds(new Set())
              }}
            >
              <SelectTrigger
                className="w-48"
                aria-label={t("trash.columns.space")}
              >
                <SelectValue placeholder={t("trash.allSpaces")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("trash.allSpaces")}</SelectItem>
                {spaces.map((space) => (
                  <SelectItem key={space.id} value={String(space.id)}>
                    {space.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || editableItems.length === 0}
            onClick={handleClearTrash}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            {t("trash.clearTrash")}
          </Button>
        </div>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {/* 批量操作条 */}
      {selectedItems.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="font-medium">
            {t("trash.batch.selectedCount", { count: selectedItems.length })}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void handleBatchRestore()}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t("trash.batch.restore")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={handleBatchPurge}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {t("trash.batch.purge")}
            </Button>
          </div>
        </div>
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
      ) : displayedItems.length === 0 ? (
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
        <div className="rounded-xl border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={
                      allSelected
                        ? true
                        : someSelected
                          ? "indeterminate"
                          : false
                    }
                    disabled={editableItems.length === 0}
                    onCheckedChange={handleToggleAll}
                    aria-label={t("trash.selectAll")}
                  />
                </TableHead>
                <TableHead className="w-36">
                  {t("trash.columns.space")}
                </TableHead>
                <TableHead>{t("trash.columns.title")}</TableHead>
                <TableHead className="w-44">
                  {t("trash.columns.createdAt")}
                </TableHead>
                <TableHead className="w-44">
                  {t("trash.columns.deletedAt")}
                </TableHead>
                <TableHead className="w-36 text-right">
                  {t("trash.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayedItems.map((item) => {
                const editable = canEditItem(item)
                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      {editable ? (
                        <Checkbox
                          checked={selectedIds.has(item.id)}
                          onCheckedChange={(checked) =>
                            toggleSelectItem(item.id, !!checked)
                          }
                          aria-label={t("trash.selectItem", {
                            title: item.title
                          })}
                        />
                      ) : null}
                    </TableCell>
                    <TableCell className="font-medium text-xs text-muted-foreground">
                      {item.spaceName ??
                        spaces.find((s) => s.id === item.spaceId)?.name ??
                        "—"}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-foreground">
                        {item.title}
                      </div>
                      {item.childCount > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {t("trash.childCount", { count: item.childCount })}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">
                      {formatDateTime(item.createdAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">
                      {formatDateTime(item.deletedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {editable ? (
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void handleSingleRestore(item)}
                          >
                            <RotateCcw
                              className="size-3.5"
                              aria-hidden="true"
                            />
                            {t("trash.restore")}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={busy}
                            onClick={() =>
                              setPurgeTarget({
                                type: "single",
                                items: [item]
                              })
                            }
                          >
                            {t("trash.purge")}
                          </Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
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
              {purgeTarget?.type === "single"
                ? t("trash.purgeDialog.title", {
                    title: purgeTarget.items[0]?.title ?? ""
                  })
                : purgeTarget?.type === "clear"
                  ? t("trash.purgeDialog.clearTitle")
                  : t("trash.purgeDialog.batchTitle", {
                      count: purgeTarget?.items.length ?? 0
                    })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("trash.purgeDialog.description", {
                itemCount: purgeTarget?.items.length ?? 0,
                totalCount:
                  purgeTarget?.items.reduce(
                    (sum, item) => sum + (item.childCount ?? 0) + 1,
                    0
                  ) ?? 0
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void handleConfirmPurge()}
            >
              {t("trash.purge")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
