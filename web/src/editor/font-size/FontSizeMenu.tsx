import { type Editor, useEditorState } from "@tiptap/react"
import { useTranslation } from "react-i18next"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { currentFontSize, setFontSize } from "@/editor/font-size/commands"
import { ALLOWED_FONT_SIZES, type AllowedFontSize } from "@/lib/font-size"

export const FONT_SIZE_OPTIONS = [
  { value: "default", labelKey: "editor.fontSize.default" },
  ...ALLOWED_FONT_SIZES.map((size) => ({ value: size }))
] as const

/**
 * 行内字号下拉菜单：
 * 支持 7 档固定刻度（12px、14px、16px、18px、20px、24px、32px）与「默认」清除项。
 * 通过 useEditorState 实时响应选区光标位置字号变化。
 */
export function FontSizeMenu({ editor }: { editor: Editor }) {
  const { t } = useTranslation()
  const fontSize = useEditorState({
    editor,
    selector: ({ editor }) => currentFontSize(editor)
  })

  const selectedValue = fontSize ?? "default"

  return (
    <Select
      value={selectedValue}
      onValueChange={(value) => {
        if (value === "default") {
          setFontSize(editor, null)
        } else {
          setFontSize(editor, value as AllowedFontSize)
        }
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={t("editor.fontSize.label")}
        className="h-7 w-[5.5rem] border-transparent bg-transparent text-xs"
      >
        <SelectValue>
          {selectedValue === "default"
            ? t("editor.fontSize.default")
            : selectedValue}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="wiki-font-size-menu">
        <SelectItem
          value="default"
          data-font-size="default"
          className="wiki-font-size-item"
        >
          {t("editor.fontSize.default")}
        </SelectItem>
        {ALLOWED_FONT_SIZES.map((size) => (
          <SelectItem
            key={size}
            value={size}
            data-font-size={size}
            style={{ fontSize: size }}
            className="wiki-font-size-item"
          >
            {size}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
