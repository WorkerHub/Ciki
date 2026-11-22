import { type Editor, useEditorState } from "@tiptap/react"
import { Check, Minus, Plus } from "lucide-react"
import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import {
  canStepFontSize,
  selectionFontSize,
  setFontSize,
  stepFontSize
} from "@/editor/font-size/commands"
import { ALLOWED_FONT_SIZES, type AllowedFontSize } from "@/lib/font-size"

export const FONT_SIZE_OPTIONS = [
  { value: "default", labelKey: "editor.fontSize.default" },
  ...ALLOWED_FONT_SIZES.map((size) => ({
    value: size,
    label: size.replace("px", "")
  }))
] as const

/**
 * 行内字号控件（紧凑步进数字框 + 刻度下拉）：
 * - 两侧 − / + 沿固定刻度逐档增减，顺序 默认 ↔ 12 ↔ 14 ↔ 16 ↔ 18 ↔ 20 ↔ 24 ↔ 32；
 * - 框内直接显示选区字号数字（如 24）、无显式字号显示「默认」、混排显示「—」；
 * - 点数字弹出刻度列表（默认 + 7 档），选项一律纯数字、同字号渲染，当前档打勾；
 * - 总宽度严格控制在 84px（w-[5.25rem]），不超过原 88px（w-[5.5rem]）。
 */
export function FontSizeMenu({ editor }: { editor: Editor }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const keepFocusInEditor = useRef(false)

  const fontSizeState = useEditorState({
    editor,
    selector: ({ editor }) => ({
      ...selectionFontSize(editor),
      canDown: canStepFontSize(editor, "down"),
      canUp: canStepFontSize(editor, "up")
    })
  })

  const displayText = fontSizeState.isMixed
    ? "—"
    : fontSizeState.size
      ? fontSizeState.size.replace("px", "")
      : t("editor.fontSize.default")

  const handleSelect = (size: AllowedFontSize | null) => {
    keepFocusInEditor.current = true
    setFontSize(editor, size)
    setOpen(false)
  }

  return (
    <div className="inline-flex h-7 w-[5.25rem] items-stretch rounded-lg border border-input bg-transparent text-xs select-none">
      <button
        type="button"
        aria-label={t("editor.fontSize.decrease")}
        title={t("editor.fontSize.decrease")}
        disabled={!fontSizeState.canDown}
        onClick={() => stepFontSize(editor, "down")}
        className="flex h-full w-5 shrink-0 items-center justify-center rounded-l-[inherit] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
      >
        <Minus className="size-3" aria-hidden="true" />
      </button>

      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("editor.fontSize.label")}
            title={t("editor.fontSize.label")}
            className="flex h-full min-w-0 flex-1 items-center justify-center border-x border-input/50 px-0.5 text-xs font-normal transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span className="truncate">{displayText}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="center"
          className="w-28 min-w-0 p-1"
          onCloseAutoFocus={(event) => {
            if (!keepFocusInEditor.current) return
            keepFocusInEditor.current = false
            event.preventDefault()
            editor.commands.focus()
          }}
        >
          <DropdownMenuItem
            key="default"
            onSelect={() => handleSelect(null)}
            className="flex items-center justify-between px-2 py-1 text-xs"
          >
            <span>{t("editor.fontSize.default")}</span>
            {!fontSizeState.isMixed && fontSizeState.size === null ? (
              <Check className="size-3.5" aria-hidden="true" />
            ) : null}
          </DropdownMenuItem>
          {ALLOWED_FONT_SIZES.map((size) => {
            const isSelected =
              !fontSizeState.isMixed && fontSizeState.size === size
            return (
              <DropdownMenuItem
                key={size}
                onSelect={() => handleSelect(size)}
                className="flex items-center justify-between px-2 py-1 text-xs"
              >
                <span>{size.replace("px", "")}</span>
                {isSelected ? (
                  <Check className="size-3.5" aria-hidden="true" />
                ) : null}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        type="button"
        aria-label={t("editor.fontSize.increase")}
        title={t("editor.fontSize.increase")}
        disabled={!fontSizeState.canUp}
        onClick={() => stepFontSize(editor, "up")}
        className="flex h-full w-5 shrink-0 items-center justify-center rounded-r-[inherit] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
      >
        <Plus className="size-3" aria-hidden="true" />
      </button>
    </div>
  )
}
