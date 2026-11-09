import type { Editor } from "@tiptap/react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const

/**
 * 下拉项：value 同时是 CSS 的 data-style 钩子（p / h1…h6），
 * index.css 里 .wiki-style-item 按它取对应层级的字号。
 */
export const PARAGRAPH_STYLES: { value: string; label: string }[] = [
  { value: "p", label: "正文" },
  ...HEADING_LEVELS.map((level) => ({
    value: `h${level}`,
    label: `标题 ${level}`
  }))
]

function currentHeading(editor: Editor): string {
  const active = HEADING_LEVELS.find((level) =>
    editor.isActive("heading", { level })
  )
  return active ? `h${active}` : "p"
}

/**
 * 段落样式下拉：展开后每一项按正文对应层级的字号渲染（字号与 .wiki-content 的标题同一组刻度），
 * 触发器收起态仍是纯文字当前项——示范只出现在列表里。
 */
export function ParagraphStyleMenu({ editor }: { editor: Editor }) {
  return (
    <Select
      value={currentHeading(editor)}
      onValueChange={(value) => {
        if (value === "p") editor.chain().focus().setParagraph().run()
        else {
          const level = Number(
            value.slice(1)
          ) as (typeof HEADING_LEVELS)[number]
          editor.chain().focus().toggleHeading({ level }).run()
        }
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="段落样式"
        className="h-7 w-[6.5rem] border-transparent bg-transparent text-xs"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="wiki-style-menu">
        {PARAGRAPH_STYLES.map((style) => (
          <SelectItem
            key={style.value}
            value={style.value}
            data-style={style.value}
            className="wiki-style-item"
          >
            {style.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
