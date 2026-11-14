import type { Editor, JSONContent } from "@tiptap/core"

/**
 * TipTap v3 的 `editor.getJSON()` 返回类型把子节点标成 `NodeType | TextType`，
 * 而 text 节点没有 `content`，断言文档形态时每次都要先收窄。
 * 文档形态本身是 TipTap 文档化的 `JSONContent`（content 递归同型），
 * 所以测试里统一从这里读，取 `.content` 不必逐个收窄。
 */
export function docJson(editor: Editor): JSONContent {
  return editor.getJSON()
}
