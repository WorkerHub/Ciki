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
import { describeApiError } from "@/lib/api"
import { canEdit, editableSpaces } from "@/lib/space"
import {
  flattenVisible,
  projectDrop,
  siblingsOf,
  type TreeRow
} from "@/lib/tree"
import { usePagesStore } from "@/stores/pages"
import { useSpaceRole } from "@/hooks/useSpaceRole"
import { useAuthStore } from "@/stores/auth"
import { useSpacesStore } from "@/stores/spaces"

/** 侧边栏页面树：展开/收起、点击进页面、拖拽改层级与排序、行内菜单做增删改。 */
export function PageTree({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate()
  const params = useParams<{ pageId?: string }>()
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
  const [activeId, setActiveId] = useState<string | null>(null)
  const [offsetLeft, setOffsetLeft] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [createParent, setCreateParent] = useState<TreeRow | null>(null)
  const [renameTarget, setRenameTarget] = useState<TreeRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<TreeRow | null>(null)
  const [moveTarget, setMoveTarget] = useState<TreeRow | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState("")
  const [actionNotice, setActionNotice] = useState("")

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
    navigate(`/p/${row.id}`)
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
    setActionNotice("")
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
    setActiveId(String(event.active.id))
    setOffsetLeft(0)
  }

  const handleDragMove = (event: DragMoveEvent) => {
    setOffsetLeft(event.delta.x)
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    const active = String(event.active.id)
    const over = event.over ? String(event.over.id) : null
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
        重试
      </Button>
    </div>
  ) : loading && rows.length === 0 ? (
    <div className="space-y-2 p-2" role="status" aria-label="页面树加载中">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="h-6 animate-pulse rounded bg-muted" />
      ))}
    </div>
  ) : tree.length === 0 ? (
    <Empty
      icon={<FilePlus2 />}
      title={spaceName ? `「${spaceName}」还没有页面` : "还没有页面"}
      description={
        readOnly
          ? "你在这个空间是只读成员，可以让空间管理员添加页面。"
          : "从新建一个页面开始，或直接把 Confluence 内容粘贴进编辑器。"
      }
      contents={
        readOnly ? undefined : (
          <Button size="sm" variant="outline" onClick={() => openCreate(null)}>
            <FilePlus2 aria-hidden="true" />
            新建页面
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
      {actionNotice ? (
        <p
          role="status"
          className="mx-2 rounded bg-muted px-2 py-1 text-xs text-muted-foreground"
        >
          {actionNotice}
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
                    active={params.pageId === row.id}
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
        onCreated={(page) => navigate(`/p/${page.id}/edit`)}
      />

      <MovePageDialog
        pageId={moveTarget?.id ?? ""}
        pageTitle={moveTarget?.title ?? ""}
        sourceSpaceId={currentSpaceId ?? ""}
        open={moveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setMoveTarget(null)
        }}
        onMoved={(targetSpaceId) => {
          const name =
            moveTargets.find((space) => space.id === targetSpaceId)?.name ??
            "目标空间"
          setActionNotice(`已移动到「${name}」。`)
          if (params.pageId === moveTarget?.id) navigate("/")
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
            <DialogTitle>重命名页面</DialogTitle>
            <DialogDescription>
              只改标题，正文与版本历史不变。
            </DialogDescription>
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
              <Label htmlFor="rename-page-title">标题</Label>
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
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                保存
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
            <AlertDialogTitle>删除「{deleteTarget?.title}」？</AlertDialogTitle>
            <AlertDialogDescription>
              页面会连同全部子页面一起移入回收站，之后可以在回收站里恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!deleteTarget) return
                setBusy(true)
                try {
                  await removePage(deleteTarget.id)
                  if (params.pageId === deleteTarget.id) navigate("/")
                  setDeleteTarget(null)
                } catch (error) {
                  setActionError(describeApiError(error))
                } finally {
                  setBusy(false)
                }
              }}
            >
              移入回收站
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
