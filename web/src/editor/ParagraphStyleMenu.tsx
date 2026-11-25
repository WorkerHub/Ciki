import { type Editor, useEditorState } from "@tiptap/react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
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
 * 文案只存 key，实际文字在渲染时由 t() 给出（切语言即时生效）。
 */
export const PARAGRAPH_STYLES: {
  value: string
  labelKey: string
  level?: number
}[] = [
  { value: "p", labelKey: "editor.paragraph.body" },
  ...HEADING_LEVELS.map((level) => ({
    value: `h${level}`,
    labelKey: "editor.paragraph.heading",
    level
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
  const { t } = useTranslation()
  // 正文到位前 useEditor 会重建一次编辑器实例（空文档 → 真实内容）。useEditorState 在这
  // 个换手窗口仍可能读到旧实例的快照，而新实例默认 selection 落在文首——文首若是标题，
  // 标签就会随机闪成「标题 N」（#210）。以「当前实例的第一笔事务」作为落定信号：换实例时
  // 把基线记到当时的 transactionNumber，事务发生前一律显示「正文」占位，落定后才如实反映选区。
  // 注意：落定信号依赖 @tiptap/react 的 transactionNumber 为内部全局计数且跨实例不重置；
  // 后续升级 @tiptap/react 时需重点验证此假设依然成立。
  const [baseline, setBaseline] = useState<{ editor: Editor; tx: number }>({
    editor,
    tx: -1
  })
  const { heading, tx } = useEditorState({
    editor,
    selector: ({ editor, transactionNumber }) => ({
      heading: currentHeading(editor),
      tx: transactionNumber
    })
  })
  if (baseline.editor !== editor) {
    setBaseline({ editor, tx })
  }
  // 换实例首帧 heading 仍可能是旧实例快照，全靠 isSettled 三元表达式兜住（未落定时固定回落 "p"）；
  // 严禁跳过 isSettled 直接消费 heading，防后续误改导致初始化闪烁回归。
  const isSettled = baseline.editor === editor && tx > baseline.tx
  const value = isSettled ? heading : "p"
  return (
    <Select
      value={value}
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
        aria-label={t("editor.paragraph.label")}
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
            {t(style.labelKey, { level: style.level })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
