import { type Editor, Extension } from "@tiptap/core"
import { Plugin } from "@tiptap/pm/state"
import { cleanConfluenceHtml } from "@/editor/paste/cleaner"
import { describeApiError } from "@/lib/api"
import { applyColWidthsFromColgroup } from "@/lib/table-columns"
import { imageFilesFrom, uploadImage } from "@/lib/upload"

export interface ConfluencePasteOptions {
  onError: (message: string) => void
}

async function insertImageFiles(
  editor: Editor,
  files: File[],
  onError: (message: string) => void
) {
  for (const file of files) {
    try {
      const uploaded = await uploadImage(file)
      editor
        .chain()
        .focus()
        .setImage({ src: uploaded.url, alt: file.name })
        .run()
    } catch (error) {
      onError(describeApiError(error))
    }
  }
}

/**
 * 粘贴管线入口（规格 §5）：
 * - 剪贴板带图片文件（截图、从文件管理器复制的图）→ 直传 /api/files 再插入；
 * - 带 text/html → 过 Confluence 清洗管线，补列宽，再交给 TipTap 解析；
 * - 纯文本交给 ProseMirror 原生处理（不干预更稳）。
 * 清洗只是让内容更干净，安全边界在服务端保存时的二次消毒。
 */
export const ConfluencePaste = Extension.create<ConfluencePasteOptions>({
  name: "confluencePaste",

  addOptions() {
    return { onError: () => {} }
  },

  addProseMirrorPlugins() {
    const editor = this.editor
    const { onError } = this.options

    return [
      new Plugin({
        props: {
          handlePaste: (_view, event) => {
            const data = event.clipboardData
            if (!data) return false

            const files = imageFilesFrom(data.files)
            if (files.length) {
              void insertImageFiles(editor, files, onError)
              return true
            }

            const html = data.getData("text/html")
            if (!html.trim()) return false

            const cleaned = cleanConfluenceHtml(html)
            if (!cleaned.trim()) return false

            editor
              .chain()
              .focus()
              .insertContent(applyColWidthsFromColgroup(cleaned))
              .run()
            return true
          }
        }
      })
    ]
  }
})
