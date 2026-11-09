/**
 * 读一条历史版本的正文（查看单个版本、回滚共用）。
 *
 * 新形态的行只有一份 gzip 的 `content_json`，HTML 与纯文本按需生成：走的是导入
 * 接口那条已验证的链（`renderTiptapHtml` → `sanitizePageHtml` → `toPlainText`），
 * 也就是 `normalizeImportedContent` 本身——不另写一套渲染/消毒顺序。
 *
 * 旧形态的行（部署后到点升级之间写入、以及迁移尚未转换完的行）没有 gzip：原样返回
 * 库里那三列，与改前的行为逐字一致，保证升级过程中怎么看都还是那一份内容。
 */
import type { RevisionRow } from "../db/queries/revisions"
import { gunzipText } from "./gzip"
import { normalizeImportedContent, type PageContentResult } from "./page-input"
import { sanitizePageHtml, toPlainText } from "./sanitize"

/**
 * 版本行 → 页面正文四件套。
 *
 * JSON 无法按当前编辑器 schema 渲染（历史上 `PUT /api/pages` 只校验 JSON 可解析）
 * 时返回 `{ ok: false }`，由路由转成 422：宁可不给预览/不写回页面，也不静默把页面
 * 内容写成残缺版本。
 */
export async function revisionContent(
  row: RevisionRow
): Promise<PageContentResult> {
  if (row.content_gzip) {
    const contentJson = await gunzipText(row.content_gzip)
    return normalizeImportedContent({ title: row.title, contentJson })
  }
  // 旧形态：三列文本就是答案，重消毒的口径与改前一致。
  return {
    ok: true,
    value: {
      title: toPlainText(row.title),
      contentJson: row.content_json,
      contentHtml: sanitizePageHtml(row.content_html),
      contentText: toPlainText(row.content_text)
    }
  }
}
