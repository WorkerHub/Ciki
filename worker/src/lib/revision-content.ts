/**
 * 读一条历史版本的正文（查看单个版本、回滚共用）。
 *
 * 版本行只有 `content_hash`：JSON 在 `ciki-content` 里，HTML 与纯文本按需生成——走的是
 * 导入接口那条已验证的链（`renderTiptapHtml` → `sanitizePageHtml` → `toPlainText`），
 * 也就是 `normalizeImportedContent` 本身，不另写一套渲染/消毒顺序。
 *
 * JSON 无法按当前编辑器 schema 渲染（历史上 `PUT /api/pages` 只校验 JSON 可解析）
 * 时返回 `{ ok: false }`，由路由转成 422：宁可不给预览/不写回页面，也不静默把页面
 * 内容写成残缺版本。对象缺失或压缩字节坏掉同样归为 `{ ok: false }`（不变成未捕获
 * 异常），同时写一行日志便于定位。
 */
import type { RevisionRow } from "../db/queries/revisions"
import { ContentObjectMissingError, readContent } from "../core/content-store"
import { GzipError } from "../lib/gzip"
import {
  normalizeImportedContent,
  type PageContentResult
} from "../lib/page-input"
import type { Env } from "../types"

/** 版本行 → 页面正文四件套（按 `content_hash` 从 R2 取）。 */
export async function revisionContent(
  env: Env,
  row: RevisionRow
): Promise<PageContentResult> {
  let contentJson: string
  try {
    contentJson = await readContent(env, row.content_hash)
  } catch (err) {
    console.error(
      `Revision ${row.id} content cannot be loaded:`,
      err instanceof ContentObjectMissingError || err instanceof GzipError
        ? err.message
        : String(err)
    )
    return { ok: false, error: "stored revision content is unavailable" }
  }
  return normalizeImportedContent({ title: row.title, contentJson })
}
