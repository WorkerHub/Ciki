import { EditorContent, useEditor } from "@tiptap/react"
import { useEffect, useMemo, useRef } from "react"
import { createExtensions } from "@/editor/extensions"
import { applyColWidthsFromColgroup } from "@/lib/table-columns"
import { TOP_LEVEL_HEADINGS } from "@/lib/toc"

interface ReadViewProps {
  html: string
  /** 与正文标题同源同序的锚点 id；不传则不加锚点（如版本预览）。 */
  headingIds?: string[]
  /** 锚点补齐后回调，参数是正文根元素（供索引轨挂滚动观察器）。 */
  onReady?: (root: HTMLElement) => void
}

/**
 * 阅读态：用同一套 TipTap 扩展渲染服务端消毒后的 content_html（editable:false），
 * 所以代码块角标/复制按钮、表格列宽、未转存图片占位与编辑态完全一致。
 * 渲染前把 <colgroup> 的列宽还原成单元格 colwidth（服务端白名单不保留 td[colwidth]）。
 *
 * 锚点 id 由调用方从 contentJson 提取、按位置式生成；服务端消毒不保留 id，
 * 所以要在渲染就绪后按文档顺序补到顶层标题上——不够数的多余标题不拿 id，
 * 不会把后面的标题顶错位。
 */
export function ReadView({ html, headingIds, onReady }: ReadViewProps) {
  const prepared = useMemo(() => applyColWidthsFromColgroup(html), [html])
  // 回调放 ref：编辑器与效果只跟内容走，回调始终是最新那个
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  const editor = useEditor(
    {
      extensions: createExtensions("read"),
      content: prepared,
      editable: false,
      editorProps: {
        attributes: {
          class: "wiki-content",
          spellcheck: "false"
        }
      }
    },
    [prepared]
  )

  useEffect(() => {
    if (!editor) return
    const root = editor.view.dom as HTMLElement
    if (headingIds && headingIds.length > 0) {
      // 空标题在提取时被跳过（contentJson 里没有文字），DOM 里 TipTap 仍会渲染它，
      // 这里必须用同一判据跳过，否则空标题会抢走 heading-1、把后面的锚点顶偏一位。
      const headings = Array.from(
        root.querySelectorAll<HTMLElement>(TOP_LEVEL_HEADINGS)
      ).filter((heading) => Boolean(heading.textContent?.trim()))
      headingIds.forEach((id, index) => {
        const heading = headings[index]
        if (heading) heading.id = id
      })
    }
    onReadyRef.current?.(root)
  }, [editor, headingIds])

  return <EditorContent editor={editor} />
}
