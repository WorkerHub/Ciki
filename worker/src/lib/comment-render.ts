/**
 * 评论正文的 Markdown 渲染（规格「页尾评论」§三）。
 *
 * 只有一条链：`marked`（Workers 兼容的现成库，规格点名的就是它）→
 * `sanitizeCommentHtml()`（与正文同一份白名单，只放开 `img[src]` 的站内/https 口径）。
 * 存储只存 Markdown 原文，HTML 不落库：列表、预览、发表返回的 DTO 全部现算，
 * 前端不做二次渲染、也不引新的前端 MD 库。
 *
 * 不信任 Markdown 里的原始 HTML（marked 默认原样透传）：`<script>`、事件属性、
 * `javascript:` 链接都由消毒器按白名单剥掉。`breaks: true` 让评论里的单个换行
 * 也算换行（评论是短文本，与聊天一致），`gfm: true` 保留表格、删除线等 GFM 语法。
 */
import { marked } from "marked"
import { sanitizeCommentHtml } from "./sanitize"

export function renderCommentHtml(bodyMd: string): string {
  if (!bodyMd) return ""
  const rendered = marked.parse(bodyMd, {
    gfm: true,
    breaks: true,
    async: false
  })
  return sanitizeCommentHtml(rendered)
}
