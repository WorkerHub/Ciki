import type { Editor } from "@tiptap/react"
import {
  Baseline,
  Bold,
  Code2,
  Highlighter,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  PaintBucket,
  Quote,
  Redo2,
  Rows3,
  Strikethrough,
  Table2,
  Trash2,
  Underline as UnderlineIcon,
  Undo2
} from "lucide-react"
import { type ReactNode, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Toggle } from "@/components/ui/toggle"
import { ColorMenu } from "@/editor/colors/ColorMenu"
import {
  currentCellBackground,
  currentHighlight,
  currentTextColor,
  setCellBackground,
  setHighlight,
  setTextColor
} from "@/editor/colors/commands"
import {
  CELL_COLORS,
  HIGHLIGHT_COLORS,
  TEXT_COLORS
} from "@/editor/colors/palette"
import { describeApiError } from "@/lib/api"
import { ACCEPT_IMAGE_ATTR, uploadImage } from "@/lib/upload"

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const

function currentHeading(editor: Editor): string {
  const active = HEADING_LEVELS.find((level) =>
    editor.isActive("heading", { level })
  )
  return active ? `h${active}` : "p"
}

/** 编辑器工具条：只放日常会用到的动作，其余交给 Markdown 快捷输入与粘贴。 */
export function EditorToolbar({
  editor,
  onError,
  actions
}: {
  editor: Editor
  onError?: (message: string) => void
  /** 行尾的额外操作（编辑页的保存状态 + 保存按钮），随工具条一起吸顶 */
  actions?: ReactNode
}) {
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState("")
  const imageInput = useRef<HTMLInputElement>(null)

  const openLinkDialog = () => {
    setLinkValue(
      (editor.getAttributes("link").href as string | undefined) ?? ""
    )
    setLinkOpen(true)
  }

  const applyLink = () => {
    const raw = linkValue.trim()
    if (!raw) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run()
      setLinkOpen(false)
      return
    }
    const href = /^(https?:|mailto:|\/|#)/i.test(raw) ? raw : `https://${raw}`
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run()
    setLinkOpen(false)
  }

  const onPickImage = async (file: File | undefined) => {
    if (!file) return
    try {
      const uploaded = await uploadImage(file)
      editor
        .chain()
        .focus()
        .setImage({ src: uploaded.url, alt: file.name })
        .run()
    } catch (error) {
      onError?.(describeApiError(error))
    } finally {
      if (imageInput.current) imageInput.current.value = ""
    }
  }

  return (
    <div
      role="toolbar"
      aria-label="编辑器工具条"
      className="flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-card p-1"
    >
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
        <SelectContent>
          <SelectItem value="p">正文</SelectItem>
          {HEADING_LEVELS.map((level) => (
            <SelectItem key={level} value={`h${level}`}>
              标题 {level}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Separator orientation="vertical" className="mx-1 !h-5" />

      <Toggle
        size="sm"
        aria-label="粗体"
        title="粗体（Ctrl/⌘ + B）"
        pressed={editor.isActive("bold")}
        onPressedChange={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold aria-hidden="true" />
      </Toggle>
      <Toggle
        size="sm"
        aria-label="斜体"
        title="斜体（Ctrl/⌘ + I）"
        pressed={editor.isActive("italic")}
        onPressedChange={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic aria-hidden="true" />
      </Toggle>
      <Toggle
        size="sm"
        aria-label="下划线"
        title="下划线（Ctrl/⌘ + U）"
        pressed={editor.isActive("underline")}
        onPressedChange={() => editor.chain().focus().toggleUnderline().run()}
      >
        <UnderlineIcon aria-hidden="true" />
      </Toggle>
      <Toggle
        size="sm"
        aria-label="删除线"
        title="删除线"
        pressed={editor.isActive("strike")}
        onPressedChange={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough aria-hidden="true" />
      </Toggle>
      <ColorMenu
        label="文字颜色"
        icon={Baseline}
        colors={TEXT_COLORS}
        activeColor={currentTextColor(editor)}
        onPick={(color) => setTextColor(editor, color)}
      />
      <ColorMenu
        label="高亮"
        icon={Highlighter}
        colors={HIGHLIGHT_COLORS}
        activeColor={currentHighlight(editor)}
        onPick={(color) => setHighlight(editor, color)}
      />

      <Separator orientation="vertical" className="mx-1 !h-5" />

      <Toggle
        size="sm"
        aria-label="无序列表"
        title="无序列表"
        pressed={editor.isActive("bulletList")}
        onPressedChange={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List aria-hidden="true" />
      </Toggle>
      <Toggle
        size="sm"
        aria-label="有序列表"
        title="有序列表"
        pressed={editor.isActive("orderedList")}
        onPressedChange={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered aria-hidden="true" />
      </Toggle>
      <Toggle
        size="sm"
        aria-label="任务列表"
        title="任务列表"
        pressed={editor.isActive("taskList")}
        onPressedChange={() => editor.chain().focus().toggleTaskList().run()}
      >
        <ListChecks aria-hidden="true" />
      </Toggle>
      <Toggle
        size="sm"
        aria-label="引用"
        title="引用"
        pressed={editor.isActive("blockquote")}
        onPressedChange={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote aria-hidden="true" />
      </Toggle>
      <Toggle
        size="sm"
        aria-label="代码块"
        title="代码块"
        pressed={editor.isActive("codeBlock")}
        onPressedChange={() => editor.chain().focus().toggleCodeBlock().run()}
      >
        <Code2 aria-hidden="true" />
      </Toggle>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="分割线"
        title="分割线"
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      >
        <Minus aria-hidden="true" />
      </Button>

      <Separator orientation="vertical" className="mx-1 !h-5" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant={editor.isActive("table") ? "secondary" : "ghost"}
            aria-label="表格"
            title="表格"
          >
            <Table2 aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuItem
            onSelect={() =>
              editor
                .chain()
                .focus()
                .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                .run()
            }
          >
            <Table2 aria-hidden="true" />
            插入表格（3×3）
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>当前表格</DropdownMenuLabel>
          <DropdownMenuItem
            disabled={!editor.can().addRowAfter()}
            onSelect={() => editor.chain().focus().addRowAfter().run()}
          >
            <Rows3 aria-hidden="true" />
            在下方插入行
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!editor.can().addColumnAfter()}
            onSelect={() => editor.chain().focus().addColumnAfter().run()}
          >
            在右侧插入列
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!editor.isActive("table")}
            onSelect={() => editor.chain().focus().deleteRow().run()}
          >
            删除当前行
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!editor.isActive("table")}
            onSelect={() => editor.chain().focus().deleteColumn().run()}
          >
            删除当前列
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!editor.isActive("table")}
            variant="destructive"
            onSelect={() => editor.chain().focus().deleteTable().run()}
          >
            <Trash2 aria-hidden="true" />
            删除表格
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {editor.isActive("table") ? (
        <ColorMenu
          label="单元格背景"
          icon={PaintBucket}
          colors={CELL_COLORS}
          activeColor={currentCellBackground(editor)}
          onPick={(color) => setCellBackground(editor, color)}
        />
      ) : null}

      <Button
        type="button"
        size="icon-sm"
        variant={editor.isActive("link") ? "secondary" : "ghost"}
        aria-label="插入链接"
        title="插入链接"
        onClick={openLinkDialog}
      >
        <Link2 aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="上传图片"
        title="上传图片"
        onClick={() => imageInput.current?.click()}
      >
        <ImagePlus aria-hidden="true" />
      </Button>
      <input
        ref={imageInput}
        type="file"
        accept={ACCEPT_IMAGE_ATTR}
        className="hidden"
        onChange={(event) => void onPickImage(event.target.files?.[0])}
      />

      <Separator orientation="vertical" className="mx-1 !h-5" />

      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="撤销"
        title="撤销（Ctrl/⌘ + Z）"
        disabled={!editor.can().chain().focus().undo().run()}
        onClick={() => editor.chain().focus().undo().run()}
      >
        <Undo2 aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="重做"
        title="重做（Ctrl/⌘ + Shift + Z）"
        disabled={!editor.can().chain().focus().redo().run()}
        onClick={() => editor.chain().focus().redo().run()}
      >
        <Redo2 aria-hidden="true" />
      </Button>

      {actions ? (
        <div className="ml-auto flex items-center gap-2 pl-1">{actions}</div>
      ) : null}

      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>插入链接</DialogTitle>
            <DialogDescription>
              留空并保存可移除当前文字的链接。
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              applyLink()
            }}
          >
            <Input
              autoFocus
              value={linkValue}
              onChange={(event) => setLinkValue(event.target.value)}
              placeholder="https://example.com"
              aria-label="链接地址"
              name="link-href"
            />
            <DialogFooter>
              <Button type="submit" size="sm">
                应用
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
