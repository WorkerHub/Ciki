import { EditorContent, useEditor } from "@tiptap/react"
import { useMemo } from "react"
import { createExtensions } from "@/editor/extensions"
import { applyColWidthsFromColgroup } from "@/lib/table-columns"

/**
 * 阅读态：用同一套 TipTap 扩展渲染服务端消毒后的 content_html（editable:false），
 * 所以代码块角标/复制按钮、表格列宽、未转存图片占位与编辑态完全一致。
 * 渲染前把 <colgroup> 的列宽还原成单元格 colwidth（服务端白名单不保留 td[colwidth]）。
 */
export function ReadView({ html }: { html: string }) {
  const prepared = useMemo(() => applyColWidthsFromColgroup(html), [html])

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

  return <EditorContent editor={editor} />
}
