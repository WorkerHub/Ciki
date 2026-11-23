import type { JSONContent } from "@tiptap/core"
import { type Editor, EditorContent, useEditor } from "@tiptap/react"
import { type ReactNode, useMemo, useRef } from "react"
import { UntransferredImageBridge } from "@/editor/bridge/extension"
import { EditorToolbar } from "@/editor/EditorToolbar"
import { createExtensions } from "@/editor/extensions"
import { clampHtmlEmbedHeight } from "@/editor/htmlEmbed/extension"
import { ConfluencePaste } from "@/editor/paste/paste-plugin"
import i18n from "@/i18n"
import { stripSingleColumnColwidths } from "@/lib/table-columns"

export interface EditorPayload {
  contentJson: string
  contentHtml: string
  contentText: string
}

/**
 * 剔除编辑器文档中未绘制（sceneKey 为空）的空白 excalidraw 节点。
 * 避免保存到服务端时触发 sceneKey 必填校验（400 INVALID_CONTENT_JSON），
 * 交互口径：未绘制的画布在保存后自动从文档中消失。
 */
export function removeEmptyExcalidrawNodes(editor: Editor): void {
  if (!editor || editor.isDestroyed) return
  const { doc, tr } = editor.state
  const positions: { from: number; to: number }[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === "excalidraw") {
      const sceneKey = node.attrs?.sceneKey
      if (!sceneKey || (typeof sceneKey === "string" && !sceneKey.trim())) {
        positions.push({ from: pos, to: pos + node.nodeSize })
      }
    }
  })
  if (positions.length > 0) {
    for (let i = positions.length - 1; i >= 0; i--) {
      tr.delete(positions[i].from, positions[i].to)
    }
    editor.view.dispatch(tr)
  }
}

/**
 * 递归剥离 JSONContent 结构中 sceneKey 为空的空白 excalidraw 节点。
 */
export function stripEmptyExcalidrawNodes(node: JSONContent): JSONContent {
  const next: JSONContent = { ...node }
  if (next.content) {
    next.content = next.content
      .filter((child) => {
        if (child.type === "excalidraw") {
          const sceneKey = child.attrs?.sceneKey
          return Boolean(
            sceneKey && typeof sceneKey === "string" && sceneKey.trim()
          )
        }
        return true
      })
      .map(stripEmptyExcalidrawNodes)
  }
  return next
}

/**
 * 剔除编辑器文档中未上传或 key 为空的空白 htmlEmbed 节点。
 */
export function removeEmptyHtmlEmbedNodes(editor: Editor): void {
  if (!editor || editor.isDestroyed) return
  const { doc, tr } = editor.state
  const positions: { from: number; to: number }[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === "htmlEmbed") {
      const key = node.attrs?.key
      if (!key || (typeof key === "string" && !key.trim())) {
        positions.push({ from: pos, to: pos + node.nodeSize })
      }
    }
  })
  if (positions.length > 0) {
    for (let i = positions.length - 1; i >= 0; i--) {
      tr.delete(positions[i].from, positions[i].to)
    }
    editor.view.dispatch(tr)
  }
}

/**
 * 归一并 clamp htmlEmbed 节点的高度（200–2000px，默认 480px）。
 */
export function clampHtmlEmbedHeights(editor: Editor): void {
  if (!editor || editor.isDestroyed) return
  const { doc, tr } = editor.state
  let modified = false
  doc.descendants((node, pos) => {
    if (node.type.name === "htmlEmbed") {
      const clamped = clampHtmlEmbedHeight(node.attrs?.height)
      if (clamped !== node.attrs?.height) {
        tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          height: clamped
        })
        modified = true
      }
    }
  })
  if (modified) {
    editor.view.dispatch(tr)
  }
}

/**
 * 递归规范化 JSONContent 结构中 htmlEmbed 节点：剔除空 key 并 clamp 高度。
 */
export function normalizeHtmlEmbedNodes(node: JSONContent): JSONContent {
  const next: JSONContent = { ...node }
  if (next.content) {
    next.content = next.content
      .filter((child) => {
        if (child.type === "htmlEmbed") {
          const key = child.attrs?.key
          return Boolean(key && typeof key === "string" && key.trim())
        }
        return true
      })
      .map((child) => {
        if (child.type === "htmlEmbed") {
          return {
            ...child,
            attrs: {
              ...child.attrs,
              height: clampHtmlEmbedHeight(child.attrs?.height)
            }
          }
        }
        return normalizeHtmlEmbedNodes(child)
      })
  }
  return next
}

/**
 * 编辑器内容 → 保存接口要的三件套（契约 pages.contentJson/contentHtml/contentText）。
 *
 * 1. 未绘制的空白画布（sceneKey 为空）在保存前自动剔除，不落库、不触发服务端校验 400。
 * 2. 单列表格的 colwidth 在落库前再归一一次：载入时已经剥过，但会话里拖过列宽手柄的
 *    单列表格会重新长出 colwidth，保存口径不能因此回退（列宽对单列表格一律不生效）。
 */
export function editorPayload(editor: Editor): EditorPayload {
  removeEmptyExcalidrawNodes(editor)
  removeEmptyHtmlEmbedNodes(editor)
  clampHtmlEmbedHeights(editor)
  const normalizedJson = normalizeHtmlEmbedNodes(
    stripEmptyExcalidrawNodes(stripSingleColumnColwidths(editor.getJSON()))
  )
  return {
    contentJson: JSON.stringify(normalizedJson),
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
  // 存量页的 contentJson 里带着单列表格的 colwidth（窄条元凶），载入时归一成全宽口径
  const content = useMemo(() => {
    const parsed = parseContentJson(contentJson)
    return parsed ? stripSingleColumnColwidths(parsed) : null
  }, [contentJson])
  // 把 onError 放进 ref：扩展只建一次，但回调始终是最新的那个
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const extensions = useMemo(
    () => [
      // 占位文案只在创建时取一次：编辑页内不热切换语言（切语言要离开编辑页、重新挂载）
      ...createExtensions("edit", i18n.t("editor.placeholder")),
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
          "aria-label": i18n.t("editor.surface.label")
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
  actions,
  currentPageId
}: {
  editor: Editor | null
  error?: string
  onError?: (message: string) => void
  /** 工具条行尾的操作，主要是保存状态与保存按钮 */
  actions?: ReactNode
  /** 正在编辑的页面 id（链接对话框拿它把自己从站内页面候选里排掉） */
  currentPageId?: number | null
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
        <EditorToolbar
          editor={editor}
          onError={onError}
          actions={actions}
          currentPageId={currentPageId}
        />
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
