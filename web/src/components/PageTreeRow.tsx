import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { cn } from "cn"
import {
  ArrowRightLeft,
  ChevronRight,
  FileText,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { INDENT_WIDTH, type TreeRow } from "@/lib/tree"

export type TreeRowAction =
  | "add-child"
  | "rename"
  | "delete"
  | "move-up"
  | "move-down"
  | "move-to-space"

export function PageTreeRow({
  row,
  readOnly = false,
  expanded,
  active,
  canMoveUp,
  canMoveDown,
  canMoveToSpace = false,
  onToggle,
  onOpen,
  onAction
}: {
  row: TreeRow
  /** 只读空间：不渲染拖拽手柄与行内操作菜单。 */
  readOnly?: boolean
  expanded: boolean
  active: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  /** 有别的可编辑空间时才给「移动到空间」入口。 */
  canMoveToSpace?: boolean
  onToggle: () => void
  onOpen: () => void
  onAction: (action: TreeRowAction) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({
    id: row.id
  })

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("relative list-none", isDragging && "z-10 opacity-70")}
      data-tree-row={row.id}
    >
      <div
        className={cn(
          "group flex items-center gap-0.5 rounded-md pr-0.5 max-sm:min-h-10",
          active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
        )}
        style={{ paddingLeft: row.depth * INDENT_WIDTH + 2 }}
      >
        {row.hasChildren ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={expanded ? "收起子页面" : "展开子页面"}
            aria-expanded={expanded}
            onClick={onToggle}
            className="text-muted-foreground"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn("transition-transform", expanded && "rotate-90")}
            />
          </Button>
        ) : (
          <span className="inline-block size-6 shrink-0" aria-hidden="true" />
        )}
        <FileText
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <button
          type="button"
          onClick={onOpen}
          title={row.title}
          className={cn(
            "min-w-0 flex-1 truncate rounded px-1 py-1.5 text-left text-[13px] leading-5",
            active ? "font-medium" : "text-foreground/90"
          )}
        >
          {row.title || "未命名页面"}
        </button>
        {readOnly ? null : (
          <>
            <button
              type="button"
              {...attributes}
              {...listeners}
              aria-label="拖动调整位置"
              title="拖动调整位置"
              className="cursor-grab touch-none rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
            >
              <GripVertical className="size-3.5" aria-hidden="true" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`页面「${row.title}」操作`}
                  className="text-muted-foreground opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                <DropdownMenuItem onSelect={() => onAction("add-child")}>
                  <Plus aria-hidden="true" />
                  新建子页面
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAction("rename")}>
                  <Pencil aria-hidden="true" />
                  重命名
                </DropdownMenuItem>
                {canMoveToSpace ? (
                  <DropdownMenuItem onSelect={() => onAction("move-to-space")}>
                    <ArrowRightLeft aria-hidden="true" />
                    移动到空间…
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!canMoveUp}
                  onSelect={() => onAction("move-up")}
                >
                  上移
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canMoveDown}
                  onSelect={() => onAction("move-down")}
                >
                  下移
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => onAction("delete")}
                >
                  <Trash2 aria-hidden="true" />
                  删除（含子页面）
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </li>
  )
}
