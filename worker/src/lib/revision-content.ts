/**
 * 读一条历史版本的正文（查看单个版本、回滚共用）。
 *
 * 版本行只有 `content_hash`：JSON 在 `ciki-content` 里，HTML 与纯文本按需生成——走的是
 * 导入接口那条已验证的链（`renderTiptapHtml` → `sanitizePageHtml` → `toPlainText`），
 * 也就是 `normalizeImportedContent` 本身，不另写一套渲染/消毒顺序。
 *
 * 失败分两种，路由按 `kind` 分开回：
 * - `missing`：内容对象整个不见了（指针脏了/迁移未完成）→ 5xx `CONTENT_MISSING`，
 *   与阅读接口取不到 JSON 时同一口径；
 * - `unrenderable`：JSON 无法按当前编辑器 schema 渲染（历史上 `PUT /api/pages` 只校验
 *   JSON 可解析），或对象在、但 gzip 字节本身已损坏 → 422：宁可不给预览/不写回页面，
 *   也不静默把页面内容写成残缺版本。
 *
 * 两种情况都不变成未捕获异常，同时写一行日志便于定位。
 */
import type { RevisionRow } from "../db/queries/revisions"
import { ContentObjectMissingError, readContent } from "../core/content-store"
import { normalizeImportedContent, type PageContent } from "../lib/page-input"
import type { Env } from "../types"

/** 版本正文的加载结果：对象缺失与内容渲染失败必须可区分（前者 500，后者 422）。 */
export type RevisionContentResult =
  | { ok: true; value: PageContent }
  | { ok: false; kind: "missing" }
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
    // 指针指向的对象不存在 → 指针脏了，区别于「内容本身渲染不了」。
    if (err instanceof ContentObjectMissingError) {
      return { ok: false, kind: "missing" }
    }
    return {
      ok: false,
      kind: "unrenderable",
      error: "stored revision content is unavailable"
    }
  }
  const rendered = normalizeImportedContent({ title: row.title, contentJson })
  if (!rendered.ok) {
    return { ok: false, kind: "unrenderable", error: rendered.error }
  }
  return rendered
}
