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
  Strikethrough,
  Underline as UnderlineIcon,
  Undo2
} from "lucide-react"
import { type ReactNode, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
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
import { ParagraphStyleMenu } from "@/editor/ParagraphStyleMenu"
import { TableMenu } from "@/editor/table/TableMenu"
import { describeApiError } from "@/lib/api"
import { ACCEPT_IMAGE_ATTR, uploadImage } from "@/lib/upload"

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
  const { t } = useTranslation()

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
      aria-label={t("editor.toolbar.label")}
      className="flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-card p-1"
    >
      <ParagraphStyleMenu editor={editor} />

      <Separator orientation="vertical" className="mx-1 !h-5" />

      <Toggle
        size="sm"
        aria-label={t("editor.toolbar.bold.label")}
        title={t("editor.toolbar.bold.hint")}
        pressed={editor.isActive("bold")}
        onPressedChange={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold aria-hidden="true" />
      </Toggle>
      <Toggle
        size="sm"
        aria-label={t("editor.toolbar.italic.label")}
        title={t("editor.toolbar.italic.hint")}
        pressed={editor.isActive("italic")}
        onPressedChange={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic aria-hidden="true" />
      </Toggle>
      <Toggle
        size="sm"
        aria-label={t("editor.toolbar.underline.label")}
        title={t("editor.toolbar.underline.hint")}
        pressed={editor.isActive("underline")}
        onPressedChange={() => editor.chain().focus().toggleUnderline().run()}
      >
        <UnderlineIcon aria-hidden="true" />
      </Toggle>
      <Toggle
        size="sm"
        aria-label={t("editor.toolbar.strike")}
        title={t("editor.toolbar.strike")}
        pressed={editor.isActive("strike")}
        onPressedChange={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough aria-hidden="true" />
      </Toggle>
      <ColorMenu
        label={t("editor.toolbar.textColor")}
        icon={Baseline}
        colors={TEXT_COLORS}
        activeColor={currentTextColor(editor)}
        onPick={(color) => setTextColor(editor, color)}
      />
      <ColorMenu
        label={t("editor.toolbar.highlight")}
        icon={Highlighter}
        colors={HIGHLIGHT_COLORS}
        activeColor={currentHighlight(editor)}
        onPick={(color) => setHighlight(editor, color)}
      />

      <Separator orientation="vertical" className="mx-1 !h-5" />

      <Toggle
        size="sm"
        aria-label={t("editor.toolbar.bulletList")}
        title={t("editor.toolbar.bulletList")}
        pressed={editor.isActive("bulletList")}
        onPressedChange={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List aria-hidden="true" />
      </Toggle>
      <Toggle
        size="sm"
        aria-label={t("editor.toolbar.orderedList")}
        title={t("editor.toolbar.orderedList")}
        pressed={editor.isActive("orderedList")}
        onPressedChange={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered aria-hidden="true" />
      </Toggle>
      <Toggle
        size="sm"
        aria-label={t("editor.toolbar.taskList")}
        title={t("editor.toolbar.taskList")}
        pressed={editor.isActive("taskList")}
        onPressedChange={() => editor.chain().focus().toggleTaskList().run()}
      >
        <ListChecks aria-hidden="true" />
      </Toggle>
      <Toggle
        size="sm"
        aria-label={t("editor.toolbar.blockquote")}
        title={t("editor.toolbar.blockquote")}
        pressed={editor.isActive("blockquote")}
        onPressedChange={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote aria-hidden="true" />
      </Toggle>
      <Toggle
        size="sm"
        aria-label={t("editor.toolbar.codeBlock")}
        title={t("editor.toolbar.codeBlock")}
        pressed={editor.isActive("codeBlock")}
        onPressedChange={() => editor.chain().focus().toggleCodeBlock().run()}
      >
        <Code2 aria-hidden="true" />
      </Toggle>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t("editor.toolbar.divider")}
        title={t("editor.toolbar.divider")}
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      >
        <Minus aria-hidden="true" />
      </Button>

      <Separator orientation="vertical" className="mx-1 !h-5" />

      <TableMenu editor={editor} />

      {editor.isActive("table") ? (
        <ColorMenu
          label={t("editor.toolbar.cellBackground")}
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
        aria-label={t("editor.toolbar.link")}
        title={t("editor.toolbar.link")}
        onClick={openLinkDialog}
      >
        <Link2 aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t("editor.toolbar.image")}
        title={t("editor.toolbar.image")}
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
        aria-label={t("editor.toolbar.undo.label")}
        title={t("editor.toolbar.undo.hint")}
        disabled={!editor.can().chain().focus().undo().run()}
        onClick={() => editor.chain().focus().undo().run()}
      >
        <Undo2 aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t("editor.toolbar.redo.label")}
        title={t("editor.toolbar.redo.hint")}
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
            <DialogTitle>{t("editor.toolbar.linkDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("editor.toolbar.linkDialog.description")}
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
              aria-label={t("editor.toolbar.linkDialog.urlLabel")}
              name="link-href"
            />
            <DialogFooter>
              <Button type="submit" size="sm">
                {t("editor.toolbar.linkDialog.apply")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
