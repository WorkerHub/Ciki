import { Empty } from "@cloudflare/kumo/components/empty"
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from "@dnd-kit/sortable"
import { FilePlus2, GripVertical } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate, useParams } from "react-router"
import { CreatePageDialog } from "@/components/CreatePageDialog"
import { MovePageDialog } from "@/components/MovePageDialog"
import { PageTreeRow, type TreeRowAction } from "@/components/PageTreeRow"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useSpaceRole } from "@/hooks/useSpaceRole"
import { describeApiError } from "@/lib/api"
import { pageEditPath, pagePath, parseIdParam } from "@/lib/routes"
import { canEdit, editableSpaces } from "@/lib/space"
import {
  flattenVisible,
  projectDrop,
  siblingsOf,
  type TreeRow
} from "@/lib/tree"
import { useAuthStore } from "@/stores/auth"
import { usePagesStore } from "@/stores/pages"
import { useSpacesStore } from "@/stores/spaces"

/** 侧边栏页面树：展开/收起、点击进页面、拖拽改层级与排序、行内菜单做增删改。 */
export function PageTree({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const params = useParams<{ pageId?: string }>()
  const activePageId = parseIdParam(params.pageId)
  const tree = usePagesStore((state) => state.tree)
  const loading = usePagesStore((state) => state.loading)
  const error = usePagesStore((state) => state.error)
  const loadTree = usePagesStore((state) => state.load)
  const currentSpaceId = useSpacesStore((state) => state.currentId)
  const spaces = useSpacesStore((state) => state.spaces)
  const spaceName =
    spaces.find((space) => space.id === currentSpaceId)?.name ?? null
  const readOnly = !canEdit(useSpaceRole(currentSpaceId))
  const isSiteAdmin = useAuthStore((state) => state.user?.role === "admin")
  const moveTargets = editableSpaces(spaces, isSiteAdmin, currentSpaceId)
  const expanded = usePagesStore((state) => state.expanded)
  const toggle = usePagesStore((state) => state.toggle)
  const expandTo = usePagesStore((state) => state.expandTo)
  const movePage = usePagesStore((state) => state.movePage)
  const removePage = usePagesStore((state) => state.removePage)
  const renamePage = usePagesStore((state) => state.renamePage)

  const rows = useMemo(
    () => flattenVisible(tree, new Set(expanded)),
    [tree, expanded]
  )
  const [activeId, setActiveId] = useState<number | null>(null)
  const [offsetLeft, setOffsetLeft] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [createParent, setCreateParent] = useState<TreeRow | null>(null)
  const [renameTarget, setRenameTarget] = useState<TreeRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<TreeRow | null>(null)
  const [moveTarget, setMoveTarget] = useState<TreeRow | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState("")
  /** 移动成功后要提示的目标空间名；存名字而不是拼好的句子，切语言时提示跟着变。 */
  const [movedTo, setMovedTo] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const activeRow = rows.find((row) => row.id === activeId) ?? null

  const openCreate = (parent: TreeRow | null) => {
    setCreateParent(parent)
    setCreateOpen(true)
  }

  const openPage = (row: TreeRow) => {
    expandTo(row.id)
    navigate(pagePath(row.id))
    onNavigate?.()
  }

  const moveBy = async (row: TreeRow, delta: number) => {
    const siblings = siblingsOf(tree, row.parentId)
    const index = siblings.findIndex((sibling) => sibling.id === row.id)
    const next = index + delta
    if (index < 0 || next < 0 || next >= siblings.length) return
    setActionError("")
    try {
      await movePage(row.id, row.parentId, next)
    } catch (error) {
      setActionError(describeApiError(error))
    }
  }

  const handleAction = (row: TreeRow, action: TreeRowAction) => {
    if (readOnly) return
    setActionError("")
    setMovedTo(null)
    switch (action) {
      case "add-child":
        openCreate(row)
        break
      case "rename":
        setRenameValue(row.title)
        setRenameTarget(row)
        break
      case "move-to-space":
        setMoveTarget(row)
        break
      case "delete":
        setDeleteTarget(row)
        break
      case "move-up":
        void moveBy(row, -1)
        break
      case "move-down":
        void moveBy(row, 1)
        break
      default:
        break
    }
  }

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(Number(event.active.id))
    setOffsetLeft(0)
  }

  const handleDragMove = (event: DragMoveEvent) => {
    setOffsetLeft(event.delta.x)
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    const active = Number(event.active.id)
    const over = event.over ? Number(event.over.id) : null
    setActiveId(null)
    setOffsetLeft(0)
    if (!over || readOnly) return
    const target = projectDrop(rows, active, over, offsetLeft)
    if (!target) return
    setActionError("")
    try {
      await movePage(active, target.parentId, target.sortOrder)
    } catch (error) {
      setActionError(describeApiError(error))
    }
  }

  const content = error ? (
    <div
      role="alert"
      className="mx-2 space-y-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
    >
      <p>{error}</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void loadTree(currentSpaceId)}
      >
        {t("common.retry")}
      </Button>
    </div>
  ) : loading && rows.length === 0 ? (
    <div
      className="space-y-2 p-2"
      role="status"
      aria-label={t("shell.tree.loading")}
    >
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="h-6 animate-pulse rounded bg-muted" />
      ))}
    </div>
  ) : tree.length === 0 ? (
    <Empty
      icon={<FilePlus2 />}
      title={
        spaceName
          ? t("shell.tree.emptyNamed", { spaceName })
          : t("shell.tree.empty")
      }
      description={
        readOnly ? t("shell.tree.emptyReadOnly") : t("shell.tree.emptyHint")
      }
      contents={
        readOnly ? undefined : (
          <Button size="sm" variant="outline" onClick={() => openCreate(null)}>
            <FilePlus2 aria-hidden="true" />
            {t("shell.newPage")}
          </Button>
        )
      }
    />
  ) : null

  return (
    <div className="flex min-h-0 flex-col gap-1">
      {actionError ? (
        <p
          role="alert"
          className="mx-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive"
        >
          {actionError}
        </p>
      ) : null}
      {movedTo ? (
        <p
          role="status"
          className="mx-2 rounded bg-muted px-2 py-1 text-xs text-muted-foreground"
        >
          {t("shell.tree.movedTo", { name: movedTo })}
        </p>
      ) : null}
      {content}
      {tree.length > 0 ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragEnd={handleDragEnd}
          onDragCancel={() => {
            setActiveId(null)
            setOffsetLeft(0)
          }}
        >
          <SortableContext
            items={rows.map((row) => row.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="space-y-px">
              {rows.map((row) => {
                const siblings = siblingsOf(tree, row.parentId)
                const index = siblings.findIndex(
                  (sibling) => sibling.id === row.id
                )
                return (
                  <PageTreeRow
                    key={row.id}
                    row={row}
                    readOnly={readOnly}
                    expanded={expanded.includes(row.id)}
                    active={activePageId === row.id}
                    canMoveUp={index > 0}
                    canMoveDown={index >= 0 && index < siblings.length - 1}
                    canMoveToSpace={!readOnly && moveTargets.length > 0}
                    onToggle={() => toggle(row.id)}
                    onOpen={() => openPage(row)}
                    onAction={(action) => handleAction(row, action)}
                  />
                )
              })}
            </ul>
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {activeRow ? (
              <div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1.5 text-[13px] shadow-md">
                <GripVertical
                  className="size-3.5 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="truncate">{activeRow.title}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : null}

      {/* 弹窗放在提前返回之外：空树状态下「新建页面」也要能打开它 */}
      <CreatePageDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) setCreateParent(null)
        }}
        parentId={createParent?.id ?? null}
        parentTitle={createParent?.title}
        onCreated={(page) => navigate(pageEditPath(page.id))}
      />

      <MovePageDialog
        pageId={moveTarget?.id ?? 0}
        pageTitle={moveTarget?.title ?? ""}
        sourceSpaceId={currentSpaceId ?? 0}
        open={moveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setMoveTarget(null)
        }}
        onMoved={(targetSpaceId) => {
          const name =
            moveTargets.find((space) => space.id === targetSpaceId)?.name ??
            t("shell.tree.targetSpace")
          setMovedTo(name)
          if (activePageId === moveTarget?.id) navigate("/")
          setMoveTarget(null)
        }}
      />

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("shell.tree.renameTitle")}</DialogTitle>
            <DialogDescription>{t("shell.tree.renameHint")}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault()
              if (!renameTarget) return
              const value = renameValue.trim()
              if (!value) return
              setBusy(true)
              try {
                await renamePage(renameTarget.id, value)
                setRenameTarget(null)
              } catch (error) {
                setActionError(describeApiError(error))
              } finally {
                setBusy(false)
              }
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="rename-page-title">
                {t("shell.tree.titleLabel")}
              </Label>
              <Input
                id="rename-page-title"
                name="page-title"
                autoFocus
                value={renameValue}
                maxLength={255}
                onChange={(event) => setRenameValue(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setRenameTarget(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("shell.tree.deleteTitle", { title: deleteTarget?.title })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("shell.tree.deleteHint")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!deleteTarget) return
                setBusy(true)
                try {
                  await removePage(deleteTarget.id)
                  if (activePageId === deleteTarget.id) navigate("/")
                  setDeleteTarget(null)
                } catch (error) {
                  setActionError(describeApiError(error))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {t("shell.tree.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
