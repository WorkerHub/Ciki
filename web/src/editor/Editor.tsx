import type { JSONContent } from "@tiptap/core"
import { type Editor, EditorContent, useEditor } from "@tiptap/react"
import { type ReactNode, useMemo, useRef } from "react"
import { UntransferredImageBridge } from "@/editor/bridge/extension"
import { EditorToolbar } from "@/editor/EditorToolbar"
import { createExtensions } from "@/editor/extensions"
import { ConfluencePaste } from "@/editor/paste/paste-plugin"

export interface EditorPayload {
  contentJson: string
  contentHtml: string
  contentText: string
}

/** 编辑器内容 → 保存接口要的三件套（契约 pages.contentJson/contentHtml/contentText）。 */
export function editorPayload(editor: Editor): EditorPayload {
  return {
    contentJson: JSON.stringify(editor.getJSON()),
    contentHtml: editor.getHTML(),
    contentText: editor.getText({ blockSeparator: "\n" })
  }
}

export function parseContentJson(contentJson: string): JSONContent | null {
  if (!contentJson.trim()) return null
  try {
    return JSON.parse(contentJson) as JSONContent
  } catch {
    return null
  }
}

interface UseWikiEditorOptions {
  contentJson: string
  onUpdate: () => void
  onError: (message: string) => void
}

/** 编辑态编辑器：共用扩展集 + 粘贴管线 + 空文档占位。 */
export function useWikiEditor({
  contentJson,
  onUpdate,
  onError
}: UseWikiEditorOptions) {
  const content = useMemo(() => parseContentJson(contentJson), [contentJson])
  // 把 onError 放进 ref：扩展只建一次，但回调始终是最新的那个
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const extensions = useMemo(
    () => [
      ...createExtensions("edit"),
      ConfluencePaste.configure({
        onError: (message) => onErrorRef.current(message)
      }),
      // 插件补抓事件桥：只在编辑页挂（阅读态是只读的，替换必须落在可保存的模型里）
      UntransferredImageBridge
    ],
    []
  )

  return useEditor(
    {
      extensions,
      content: content ?? "",
      editorProps: {
        attributes: {
          class: "wiki-content",
          spellcheck: "false",
          "aria-label": "页面正文"
        }
      },
      onUpdate: () => onUpdate()
    },
    [content]
  )
}

/** 编辑区外壳：吸顶的工具条 + 正文容器。 */
export function WikiEditorSurface({
  editor,
  error,
  onError,
  actions
}: {
  editor: Editor | null
  error?: string
  onError?: (message: string) => void
  /** 工具条行尾的操作，主要是保存状态与保存按钮 */
  actions?: ReactNode
}) {
  if (!editor) {
    return (
      <div className="min-h-[40vh] animate-pulse rounded-xl border border-border bg-muted/40" />
    )
  }
  return (
    <div className="flex flex-col gap-3">
      {/*
        吸顶条：父级是这个 flex 列（底边即页面内容底边），滚到文末也不会被顶出去。
        偏移 0 就是应用顶栏下沿——滚动发生在 AppShell 的 main panel 内部，顶栏在滚动容器之外。
        不透明底色铺满整列，正文滚动时不会从圆角/边框缝里透出；z-30 低于弹层（z-50）。
      */}
      <div
        data-editor-sticky-bar=""
        className="sticky top-0 z-30 bg-background pt-2"
      >
        <EditorToolbar editor={editor} onError={onError} actions={actions} />
        {error ? (
          <p
            role="alert"
            className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>
      <div className="min-h-[45vh] rounded-xl border border-border bg-card px-4 py-4 shadow-xs sm:px-6 sm:py-5">
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
