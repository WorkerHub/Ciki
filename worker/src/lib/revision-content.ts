/**
 * 读一条历史版本的正文（查看单个版本、回滚共用）。
 *
 * 版本行只有 `content_hash`：JSON 在 `ciki-content` 里，HTML 与纯文本按需生成——走的是
 * 导入接口那条已验证的链（`renderTiptapHtml` → `sanitizePageHtml` → `toPlainText`），
 * 也就是 `normalizeImportedContent` 本身，不另写一套渲染/消毒顺序。
 *
 * 失败分两种，路由按 `kind` 分开回：
 * - `unavailable`：正文取不到——对象整个不见了（指针脏了/迁移未完成）、内容桶整体不可用、
 *   gzip 字节本身已损坏、指针形状不合法，都属于「基础设施/数据可用性」问题 →
 *   500 `CONTENT_MISSING`，与阅读接口（`GET /api/pages/:id?format=json`）取不到正文时
 *   同一口径，不把运维问题说成内容问题；
 * - `unrenderable`：JSON 取到了、但无法按当前编辑器 schema 渲染（历史上 `PUT /api/pages`
 *   只校验 JSON 可解析）→ 422：宁可不给预览/不写回页面，也不静默把页面内容写成残缺版本。
 *
 * 两种失败都走这一个入口，靠 `readContent` 是否抛错区分；都不变成未捕获异常，
 * 取不到正文时写一行日志便于定位。
 */
import type { RevisionRow } from "../db/queries/revisions"
import { readContent } from "../core/content-store"
import { normalizeImportedContent, type PageContent } from "../lib/page-input"
import type { Env } from "../types"

/**
 * 版本正文的加载结果：正文取不到与内容渲染失败必须可区分（前者 500 `CONTENT_MISSING`，
 * 后者 422 `REVISION_UNRENDERABLE`）。
 */
export type RevisionContentResult =
  | { ok: true; value: PageContent }
  | { ok: false; kind: "unavailable" }
  | { ok: false; kind: "unrenderable"; error: string }

/** 版本行 → 页面正文四件套（按 `content_hash` 从 R2 取）。 */
export async function revisionContent(
  env: Env,
  row: RevisionRow
): Promise<RevisionContentResult> {
  let contentJson: string
  try {
    contentJson = await readContent(env, row.content_hash)
  } catch (err) {
    console.error(
      `Revision ${row.id} content cannot be loaded:`,
      err instanceof Error ? err.message : String(err)
    )
    // 对象缺失、桶不可用、字节坏、指针形状不合法：一律「正文取不到」，与
    // `?format=json` 同一口径（500 `CONTENT_MISSING`），不是「内容渲染不了」。
    return { ok: false, kind: "unavailable" }
  }
  const rendered = normalizeImportedContent({ title: row.title, contentJson })
  if (!rendered.ok) {
    return { ok: false, kind: "unrenderable", error: rendered.error }
  }
  return rendered
}
