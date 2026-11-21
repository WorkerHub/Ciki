import { type Editor, useEditorState } from "@tiptap/react"
import { cn } from "cn"
import { Rows3, Table2, Trash2 } from "lucide-react"
import { type ReactNode, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { TableSizePicker } from "@/editor/table/TableSizePicker"

/** 「当前表格」里的一行操作，外观对齐被替换掉的菜单项。 */
function TableAction({
  icon: Icon,
  disabled,
  destructive,
  onSelect,
  children
}: {
  icon?: typeof Rows3
  disabled?: boolean
  destructive?: boolean
  onSelect: () => void
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "w-full justify-start gap-1.5 px-1.5 font-normal",
        destructive &&
          "text-destructive hover:bg-destructive/10 hover:text-destructive"
      )}
    >
      {Icon ? <Icon aria-hidden="true" /> : null}
      {children}
    </Button>
  )
}

/**
 * 表格面板：上半是行列网格选择器；光标在表格内时下半是「当前表格」一组操作。
 * 面板用 Popover（非模态、Tab 不被困住）而不是 DropdownMenu——菜单里塞 15×20 个格子
 * 只能变成 300 个菜单项、方向键线性游走，键盘路径就不成立了。
 */
export function TableMenu({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false)
  const { t } = useTranslation()
  // 插入或执行表格操作完成后阻止 Radix 把焦点抢回触发器，光标留在表格内
  const keepFocusInEditor = useRef(false)

  // 光标是否在表格内、增删行列是否可用：useEditorState 订阅事务变化，
  // 光标移进/移出表格（纯选区变化、不改内容）也会实时刷新这一组。
  const tableState = useEditorState({
    editor,
    selector: ({ editor }) => ({
      inTable: editor.isActive("table"),
      canAddRowAfter: editor.can().addRowAfter(),
      canAddColumnAfter: editor.can().addColumnAfter()
    })
  })

  const run = (command: () => void) => {
    keepFocusInEditor.current = true
    command()
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant={tableState.inTable ? "secondary" : "ghost"}
          aria-label={t("editor.table.label")}
          title={t("editor.table.label")}
        >
          <Table2 aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={t("editor.table.label")}
        className="w-max p-1"
        onCloseAutoFocus={(event) => {
          if (!keepFocusInEditor.current) return
          keepFocusInEditor.current = false
          event.preventDefault()
        }}
      >
        <TableSizePicker
          onPick={(rows, cols) => {
            run(() =>
              editor
                .chain()
                .focus()
                .insertTable({ rows, cols, withHeaderRow: true })
                .run()
            )
          }}
        />

        {tableState.inTable ? (
          <>
            <Separator className="my-1" />
            <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">
              {t("editor.table.current")}
            </div>
            <TableAction
              icon={Rows3}
              disabled={!tableState.canAddRowAfter}
              onSelect={() =>
                run(() => editor.chain().focus().addRowAfter().run())
              }
            >
              {t("editor.table.insertRowBelow")}
            </TableAction>
            <TableAction
              disabled={!tableState.canAddColumnAfter}
              onSelect={() =>
                run(() => editor.chain().focus().addColumnAfter().run())
              }
            >
              {t("editor.table.insertColumnRight")}
            </TableAction>
            <TableAction
              disabled={!tableState.inTable}
              onSelect={() =>
                run(() => editor.chain().focus().deleteRow().run())
              }
            >
              {t("editor.table.deleteRow")}
            </TableAction>
            <TableAction
              disabled={!tableState.inTable}
              onSelect={() =>
                run(() => editor.chain().focus().deleteColumn().run())
              }
            >
              {t("editor.table.deleteColumn")}
            </TableAction>
            <TableAction
              icon={Trash2}
              destructive
              disabled={!tableState.inTable}
              onSelect={() =>
                run(() => editor.chain().focus().deleteTable().run())
              }
            >
              {t("editor.table.deleteTable")}
            </TableAction>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
