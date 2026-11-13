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
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState
} from "react"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/ui/badge"
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
import { describeApiError, type SearchResult, searchApi } from "@/lib/api"
import { pagePath } from "@/lib/routes"
import { ACCEPT_IMAGE_ATTR, uploadImage } from "@/lib/upload"

/** 链接对话框里站内页面候选的取数条数（够看一眼，不铺满弹层）。 */
const PAGE_PICK_LIMIT = 8

/** 输入停顿多久才发搜索请求：逐字敲不会打出一串请求。 */
const PAGE_PICK_DEBOUNCE_MS = 250

/** 编辑器工具条：只放日常会用到的动作，其余交给 Markdown 快捷输入与粘贴。 */
export function EditorToolbar({
  editor,
  onError,
  actions,
  currentPageId
}: {
  editor: Editor
  onError?: (message: string) => void
  /** 行尾的额外操作（编辑页的保存状态 + 保存按钮），随工具条一起吸顶 */
  actions?: ReactNode
  /** 正在编辑的页面 id：自己不出现在站内页面候选里 */
  currentPageId?: number | null
}) {
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState("")
  const [pageQuery, setPageQuery] = useState("")
  const [candidates, setCandidates] = useState<SearchResult[]>([])
  // 已发起并拿到结果（决定「无匹配页面」这一行出不出现：未输入、搜索中都不出）
  const [searched, setSearched] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  // 应用/点选后把焦点交回编辑器：Radix 默认会把焦点还给触发器按钮
  const focusEditorOnClose = useRef(false)
  const imageInput = useRef<HTMLInputElement>(null)
  // 搜索失败要走既有的错误通道，但不该因为父组件回调换身份就重发请求
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const { t } = useTranslation()

  const resetPageSearch = () => {
    setPageQuery("")
    setCandidates([])
    setSearched(false)
    setActiveIndex(0)
  }

  const openLinkDialog = () => {
    setLinkValue(
      (editor.getAttributes("link").href as string | undefined) ?? ""
    )
    resetPageSearch()
    setLinkOpen(true)
  }

  /** 关闭对话框并把焦点交回编辑器（弹层的 onCloseAutoFocus 负责真正的 focus）。 */
  const closeAfterEdit = () => {
    focusEditorOnClose.current = true
    setLinkOpen(false)
  }

  const applyLink = () => {
    const raw = linkValue.trim()
    if (!raw) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run()
      closeAfterEdit()
      return
    }
    const href = /^(https?:|mailto:|\/|#)/i.test(raw) ? raw : `https://${raw}`
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run()
    closeAfterEdit()
  }

  /**
   * 点选 / Enter 选中的页面：href 一律取 pagePath，不拼字符串。
   * 有选区就把链接盖在选区文字上（文字不动），没选区就在光标处插入以目标标题为
   * 文字的链接——两种都走同一条 `editor.chain().focus()` 形态。
   */
  const pickPage = (page: SearchResult) => {
    const href = pagePath(page.pageId)
    const chain = editor.chain().focus()
    if (editor.state.selection.empty) {
      chain
        .insertContent({
          type: "text",
          text: page.title,
          marks: [{ type: "link", attrs: { href } }]
        })
        .run()
    } else {
      chain.extendMarkRange("link").setLink({ href }).run()
    }
    closeAfterEdit()
  }

  // 站内页面搜索：防抖后取候选，过期响应直接丢掉（与搜索页同一口径）
  useEffect(() => {
    const query = pageQuery.trim()
    if (!query) {
      setCandidates([])
      setSearched(false)
      return
    }
    let alive = true
    const timer = window.setTimeout(() => {
      searchApi
        .query(query, PAGE_PICK_LIMIT)
        .then((response) => {
          if (!alive) return
          setCandidates(
            response.results.filter((result) => result.pageId !== currentPageId)
          )
          setActiveIndex(0)
          setSearched(true)
        })
        .catch((error: unknown) => {
          if (!alive) return
          // 失败不当成「没搜到」：清空候选、交给工具条的既有错误条
          setCandidates([])
          setSearched(false)
          onErrorRef.current?.(describeApiError(error))
        })
    }, PAGE_PICK_DEBOUNCE_MS)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [pageQuery, currentPageId])

  const onPageQueryKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!candidates.length) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      setActiveIndex(
        (index) => (index + step + candidates.length) % candidates.length
      )
      return
    }
    if (event.key === "Enter") {
      // 别让回车冒泡去提交上面那条 URL 表单
      event.preventDefault()
      const target = candidates[activeIndex]
      if (target) pickPage(target)
    }
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

      <Dialog
        open={linkOpen}
        onOpenChange={(open) => {
          setLinkOpen(open)
          if (!open) resetPageSearch()
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          onCloseAutoFocus={(event) => {
            if (!focusEditorOnClose.current) return
            focusEditorOnClose.current = false
            // 写完接着敲：不把焦点还给工具条上的链接按钮
            event.preventDefault()
            editor.commands.focus()
          }}
        >
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

          {/* 站内页面：输入即搜、点选插入；不输入时这块一条文字都不占 */}
          <div className="space-y-1.5">
            <Input
              type="search"
              name="link-page-search"
              value={pageQuery}
              onChange={(event) => setPageQuery(event.target.value)}
              onKeyDown={onPageQueryKeyDown}
              placeholder={t("editor.toolbar.linkDialog.search.placeholder")}
              aria-label={t("editor.toolbar.linkDialog.search.label")}
              className="h-8"
            />
            {candidates.length ? (
              <ul className="max-h-56 overflow-y-auto rounded-md border border-border">
                {candidates.map((candidate, index) => (
                  <li key={candidate.pageId}>
                    <button
                      type="button"
                      onClick={() => pickPage(candidate)}
                      className={`flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent/60 ${
                        index === activeIndex ? "bg-accent/60" : ""
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {candidate.title}
                      </span>
                      {candidate.spaceName ? (
                        <Badge
                          variant="outline"
                          className="text-[10px] font-normal"
                        >
                          {candidate.spaceName}
                        </Badge>
                      ) : null}
                      <span className="text-xs text-muted-foreground tabular-nums">
                        #{candidate.pageId}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : searched ? (
              <p className="text-xs text-muted-foreground">
                {t("editor.toolbar.linkDialog.search.noMatch")}
              </p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
