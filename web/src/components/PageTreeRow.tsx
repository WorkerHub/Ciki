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
import { useTranslation } from "react-i18next"
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
  | "move"

export function PageTreeRow({
  row,
  readOnly = false,
  expanded,
  active,
  canMoveUp,
  canMoveDown,
  dropLine,
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
  /** 拖动中的落点预览：线画在这行的上沿或下沿，按落点层级缩进。 */
  dropLine?: { position: "before" | "after"; depth: number }
  onToggle: () => void
  onOpen: () => void
  onAction: (action: TreeRowAction) => void
}) {
  const { t } = useTranslation()
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
      {dropLine ? (
        <span
          aria-hidden="true"
          data-drop-preview=""
          className="pointer-events-none absolute z-20 h-0.5 rounded-full bg-primary"
          style={{
            left: dropLine.depth * INDENT_WIDTH + 2,
            right: 4,
            ...(dropLine.position === "before" ? { top: -1 } : { bottom: -1 })
          }}
        />
      ) : null}
      <div
        className={cn(
          "group relative flex items-center gap-0.5 rounded-md pr-0.5 max-sm:min-h-10",
          active ? "bg-accent text-accent-foreground" : "hover:bg-accent"
        )}
        style={{ paddingLeft: row.depth * INDENT_WIDTH + 2 }}
      >
        {row.hasChildren ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={
              expanded ? t("shell.tree.collapse") : t("shell.tree.expand")
            }
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
          {row.title || t("shell.tree.unnamed")}
        </button>
        {readOnly ? null : (
          // 控件组退出 flex 流、悬浮在行右端：标题吃满整行，hover 前后标题盒子零变化。
          // 底色跟随行态（常态侧栏底 / hover 与选中行 accent），右 80% 纯色盖住控件，
          // 左侧 ≈12px（pl-3）渐隐，不透出底下的标题文字。
          <div
            className={cn(
              "pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r-md bg-linear-to-l from-sidebar via-sidebar via-80% to-transparent pl-3 pr-0.5 opacity-0 transition-opacity",
              "group-hover:pointer-events-auto group-hover:opacity-100 group-hover:from-accent group-hover:via-accent",
              "group-focus-within:pointer-events-auto group-focus-within:opacity-100",
              "group-has-[[data-state=open]]:pointer-events-auto group-has-[[data-state=open]]:opacity-100",
              active && "from-accent via-accent"
            )}
          >
            <button
              type="button"
              {...attributes}
              {...listeners}
              aria-label={t("shell.tree.drag")}
              title={t("shell.tree.drag")}
              className="cursor-grab touch-none rounded p-1 text-muted-foreground active:cursor-grabbing"
            >
              <GripVertical className="size-3.5" aria-hidden="true" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t("shell.tree.rowActions", { title: row.title })}
                  className="text-muted-foreground"
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                <DropdownMenuItem onSelect={() => onAction("add-child")}>
                  <Plus aria-hidden="true" />
                  {t("shell.tree.addChild")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAction("rename")}>
                  <Pencil aria-hidden="true" />
                  {t("shell.tree.rename")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAction("move")}>
                  <ArrowRightLeft aria-hidden="true" />
                  {t("shell.tree.move")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!canMoveUp}
                  onSelect={() => onAction("move-up")}
                >
                  {t("shell.tree.moveUp")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canMoveDown}
                  onSelect={() => onAction("move-down")}
                >
                  {t("shell.tree.moveDown")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => onAction("delete")}
                >
                  <Trash2 aria-hidden="true" />
                  {t("shell.tree.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
    </li>
  )
}
