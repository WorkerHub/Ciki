/**
 * 评论正文的统一校验与规范化（`/api/pages/:id/comments` 的发表/编辑/预览共用）。
 *
 * 与 `lib/page-input.ts` 同一个形状（`{ok:true,value} | {ok:false,error,code}`），
 * 但只收一件东西：Markdown 原文。HTML 永远由服务端现算（见 `lib/comment-render.ts`），
 * 客户端送来的 HTML 一概不看，也不落库。
 *
 * 体积以**消毒后**的字节数为准：Markdown 转 HTML 会放大输出（表格、代码块），
 * 先按原文放行会让大段文本在响应体里翻几倍。
 */
import { renderCommentHtml } from "./comment-render"
import { utf8Length } from "./page-input"

/** 正文原文上限（码点）：评论是短文本，留足引用/代码片段的余量。 */
export const MAX_COMMENT_BODY_LENGTH = 20_000
/** 消毒后 HTML 上限（字节）：防止 Markdown 放大把响应体撑爆。 */
export const MAX_COMMENT_HTML_BYTES = 200_000

export interface CommentBody {
  /** 归一后的 Markdown 原文（`\r\n` → `\n`、去首尾空白），入库与回填都用它。 */
  bodyMd: string
  /** 当下的渲染结果；不落库，列表/预览/DTO 每次现算。 */
  html: string
}

export type CommentBodyResult =
  | { ok: true; value: CommentBody }
  | { ok: false; error: string; code?: string }

function payloadTooLarge(): CommentBodyResult {
  return { ok: false, error: "Payload too large", code: "PAYLOAD_TOO_LARGE" }
}

/**
 * `bodyMd` → 归一原文 + 渲染 HTML。空正文按 `COMMENT_EMPTY` 拒（前端也会禁用按钮，
 * 这里是不信任客户端的那道）；超限一律 413 口径的 `PAYLOAD_TOO_LARGE`。
 */
export function normalizeCommentBody(raw: unknown): CommentBodyResult {
  if (typeof raw !== "string") {
    return { ok: false, error: "bodyMd required" }
  }
  const bodyMd = raw.replace(/\r\n?/g, "\n").trim()
  if (!bodyMd) {
    return { ok: false, error: "Comment body required", code: "COMMENT_EMPTY" }
  }
  if ([...bodyMd].length > MAX_COMMENT_BODY_LENGTH) return payloadTooLarge()

  const html = renderCommentHtml(bodyMd)
  if (utf8Length(html) > MAX_COMMENT_HTML_BYTES) return payloadTooLarge()
  return { ok: true, value: { bodyMd, html } }
}

/**
 * 预览专用：与发表同一条归一 + 渲染链，只是允许空正文（空串照原样回空串）——
 * 「空正文不许提交」由发表接口与前端按钮把关，预览不该把它当错误。
 */
export function previewCommentBody(
  raw: unknown
): { ok: true; html: string } | { ok: false; error: string; code?: string } {
  if (raw === undefined || raw === null) return { ok: true, html: "" }
  if (typeof raw !== "string") {
    return { ok: false, error: "bodyMd required" }
  }
  const bodyMd = raw.replace(/\r\n?/g, "\n").trim()
  if (!bodyMd) return { ok: true, html: "" }
  if ([...bodyMd].length > MAX_COMMENT_BODY_LENGTH) {
    return { ok: false, error: "Payload too large", code: "PAYLOAD_TOO_LARGE" }
  }
  const html = renderCommentHtml(bodyMd)
  if (utf8Length(html) > MAX_COMMENT_HTML_BYTES) {
    return { ok: false, error: "Payload too large", code: "PAYLOAD_TOO_LARGE" }
  }
  return { ok: true, html }
}
