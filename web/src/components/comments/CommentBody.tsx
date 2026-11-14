/**
 * 评论正文：服务端已经把 Markdown 渲染成 HTML 并过完站内净化白名单
 * （与 content_html 同一条链），这里只负责呈现，不再加工。
 *
 * 刻意不走 ReadView：那是给页面正文用的 TipTap 阅读器，每条评论起一个编辑器
 * 实例既没必要，也违背「前端不做二次渲染」的约定；样式靠 .wiki-content 复用
 * 正文一套排版，评论独有的只有代码围栏的框（见 index.css 的 .comment-body）。
 */
export function CommentBody({ html }: { html: string }) {
  return (
    <div
      className="wiki-content comment-body"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: 服务端 Markdown 渲染并过完站内净化白名单后下发
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
