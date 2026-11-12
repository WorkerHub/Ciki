/**
 * 页面内容的统一校验与规范化（`/api/pages` 与 `/api/import/pages` 共用）。
 *
 * 两条入口的差别只在 HTML 从哪来：
 * - 编辑态保存：客户端带 `contentHtml`（原样送进来，服务端再消毒）；
 * - 导入：客户端只带 `contentJson`，服务端先按编辑器 schema 渲染成 HTML，
 *   再过同一支 §4 消毒管线——消毒结果为准，插件侧的转换只是预处理。
 *
 * 体积一律以**消毒/规范化后**的字节数为准：外链图片会被改写成
 * data-original-src + data-confluence-img，输出可能比输入大数倍，先按原始体积
 * 放行会让 2MB 的 D1 单行限制在保存时炸掉。
 */
import { renderTiptapHtml, TiptapRenderError } from "./tiptap-html"
import { derivePageMarkdown } from "./tiptap-markdown"
import {
  MAX_HTML_BYTES,
  MAX_JSON_BYTES,
  MAX_TEXT_BYTES,
  MAX_TITLE_LENGTH,
  sanitizePageHtml,
  toPlainText
} from "./sanitize"

/**
 * 页面正文四件套（落库/写 revision 的最终形态）。
 *
 * `contentMd` 是 `content_json` 的派生件（lib/tiptap-markdown.ts）：只在保存/导入/回滚
 * 这条唯一写路径上生成，且是在生成 html/纯文本的同一处生成。它是导出用的平面视图，
 * 不参与无改动判定，也永远不会反写回 `content_json`。
 */
export interface PageContent {
  title: string
  contentJson: string
  contentHtml: string
  contentText: string
  contentMd: string
}

/**
 * 补齐派生出来的 MD：给已经有 html/纯文本的正文补 `contentMd`。
 *
 * 导出给 `lib/revision-content.ts` 的旧形态分支用——那条分支的三列文本直接来自库里，
 * 但 MD 仍要按同一口径从 JSON 派生，回滚才和保存走同一条路。
 */
export function withDerivedMarkdown(input: {
  title: string
  contentJson: string
  contentHtml: string
  contentText: string
}): PageContent {
  return {
    ...input,
    contentMd: derivePageMarkdown(input.contentJson, input.contentText)
  }
}

export type PageContentResult =
  | { ok: true; value: PageContent }
  | { ok: false; error: string; code?: string }

/**
 * 标题的统一规范化：剥 HTML、折叠空白，结果必须是 1–255 码点。
 *
 * 只处理已确认是字符串的值（非字符串的报错文案由调用方决定：`normalizeImportedContent`
 * 回 "Title required"，只改标题的写接口同样）。`/api/write/pages/:id` 的 title-only
 * 更新没有正文可重算，靠这里走与保存完全同一条标题校验。
 */
export function normalizePageTitle(value: string): string | null {
  const title = toPlainText(value)
  if (!title || title.length > MAX_TITLE_LENGTH) return null
  return title
}

/** D1 单行上限 2,000,000 B；给三件套合计留出余量。 */
export const MAX_ROW_BYTES = 1_900_000
/**
 * 原始输入粗筛上限（明显高于契约里的消毒后上限）：只挡明显超限的请求，
 * 让“原始很大、消毒后合规”的合法输入仍能保存。
 */
const MAX_HTML_INPUT_BYTES = 2_000_000
const MAX_TEXT_INPUT_CHARS = 2_000_000

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

function payloadTooLarge(): PageContentResult {
  return {
    ok: false,
    error: "Payload too large",
    code: "PAYLOAD_TOO_LARGE"
  }
}

/**
 * 消毒后的正文必须落在契约上限与 D1 单行上限之内。
 *
 * 派生出来的 MD 也算进合计：它和 JSON/HTML/纯文本落在同一行，不计入就会出现「保存
 * 通过、写库时撞上 2MB 单行上限」的窗口（HTML 与 MD 都不保证比对方小）。
 */
function checkOutputSize(
  safeHtml: string,
  contentJson: string,
  plainText: string,
  markdown: string
): PageContentResult | null {
  if (utf8Length(safeHtml) > MAX_HTML_BYTES) return payloadTooLarge()
  if (utf8Length(plainText) > MAX_TEXT_BYTES) return payloadTooLarge()
  if (
    utf8Length(safeHtml) +
      utf8Length(contentJson) +
      utf8Length(plainText) +
      utf8Length(markdown) >
    MAX_ROW_BYTES
  ) {
    return payloadTooLarge()
  }
  return null
}

/** `/api/pages` 的入参：客户端带 contentHtml，服务端二次消毒后入库。 */
export function normalizePageInput(
  body: Record<string, unknown> | null
): PageContentResult {
  if (!body) return { ok: false, error: "Invalid request body" }
  const { title, contentJson, contentHtml, contentText } = body
  if (typeof title !== "string") return { ok: false, error: "Title required" }
  if (
    typeof contentJson !== "string" ||
    typeof contentHtml !== "string" ||
    typeof contentText !== "string"
  ) {
    return { ok: false, error: "contentJson/contentHtml/contentText required" }
  }
  try {
    JSON.parse(contentJson)
  } catch {
    return { ok: false, error: "contentJson must be valid JSON" }
  }

  // 原始体积的粗筛只用于挡住明显超限的请求；最终以消毒/规范化后的体积为准。
  if (title.length > 4096) return payloadTooLarge()
  if (utf8Length(contentJson) > MAX_JSON_BYTES) return payloadTooLarge()
  if (utf8Length(contentHtml) > MAX_HTML_INPUT_BYTES) return payloadTooLarge()
  if (contentText.length > MAX_TEXT_INPUT_CHARS) return payloadTooLarge()

  const plainTitle = normalizePageTitle(title)
  if (!plainTitle) {
    return { ok: false, error: "Title must be 1-255 characters" }
  }
  const safeHtml = sanitizePageHtml(contentHtml)
  const plainText = toPlainText(contentText)
  // MD 永远从 JSON 派生，不看客户端送来的 HTML/纯文本（两者只影响 html/text 两列）。
  const markdown = derivePageMarkdown(contentJson, plainText)
  const tooLarge = checkOutputSize(safeHtml, contentJson, plainText, markdown)
  if (tooLarge) return tooLarge

  return {
    ok: true,
    value: {
      title: plainTitle,
      contentJson,
      contentHtml: safeHtml,
      contentText: plainText,
      contentMd: markdown
    }
  }
}

/** 取出 TipTap JSON 原文（字符串或对象都收），解析失败按契约报 400。 */
function readContentJson(
  value: unknown
): { ok: true; text: string; parsed: unknown } | { ok: false } {
  if (typeof value === "string") {
    try {
      return { ok: true, text: value, parsed: JSON.parse(value) }
    } catch {
      return { ok: false }
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { ok: true, text: JSON.stringify(value), parsed: value }
  }
  return { ok: false }
}

/**
 * `/api/import/pages` 的入参：只收 contentJson，服务端渲染成 HTML 后过同一支
 * 消毒管线；contentText 由消毒后的 HTML 生成（不再信任插件侧的纯文本）。
 */
export function normalizeImportedContent(input: {
  title: unknown
  contentJson: unknown
}): PageContentResult {
  if (typeof input.title !== "string") {
    return { ok: false, error: "Title required" }
  }
  const plainTitle = normalizePageTitle(input.title)
  if (!plainTitle) {
    return { ok: false, error: "Title must be 1-255 characters" }
  }

  const read = readContentJson(input.contentJson)
  if (!read.ok) {
    return {
      ok: false,
      error: "contentJson must be valid JSON",
      code: "INVALID_CONTENT_JSON"
    }
  }
  // 渲染前先按原始体积粗筛：明显超限的内容不必进序列化。
  if (utf8Length(read.text) > MAX_JSON_BYTES) return payloadTooLarge()

  let rendered: string
  try {
    rendered = renderTiptapHtml(read.parsed)
  } catch (err) {
    if (!(err instanceof TiptapRenderError)) throw err
    return {
      ok: false,
      error: `contentJson cannot be rendered: ${err.message}`,
      code: "INVALID_CONTENT_JSON"
    }
  }

  const safeHtml = sanitizePageHtml(rendered)
  const plainText = toPlainText(safeHtml)
  const markdown = derivePageMarkdown(read.text, plainText)
  const tooLarge = checkOutputSize(safeHtml, read.text, plainText, markdown)
  if (tooLarge) return tooLarge

  return {
    ok: true,
    value: {
      title: plainTitle,
      contentJson: read.text,
      contentHtml: safeHtml,
      contentText: plainText,
      contentMd: markdown
    }
  }
}
