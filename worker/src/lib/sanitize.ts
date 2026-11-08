/**
 * 服务端二次消毒（规格 §4：前端清洗不是安全边界，保存时必须再过一遍）。
 *
 * 白名单与前端粘贴小样（prototype/src/cleaner.js）保持结构一致，另加两项：
 * - 表格/列宽的受限 `style`（TipTap 的 table/col 直接输出 style，不能丢）；
 * - 外链图片的 `src` 移入 `data-original-src` + `data-confluence-img="true"`，
 *   不保留可直连的外部地址（读态由前端渲染「未转存」占位）。
 */
import xss, { FilterXSS, escapeAttrValue } from "xss"

export const MAX_TITLE_LENGTH = 255
export const MAX_JSON_BYTES = 800_000
export const MAX_HTML_BYTES = 800_000
export const MAX_TEXT_BYTES = 300_000

/**
 * 本站图床地址：`/api/files/<uuid>.<ext>`（存量平铺）或
 * `/api/files/(pages|imports)/<uuid>.<ext>`（新前缀）——与 lib/upload.ts 的
 * UPLOAD_KEY_RE 同义，但不收 `avatars/`：头像只服务资料页，正文引用会在
 * 换头像删旧图时变死链。
 */
const FILE_SRC =
  /^\/api\/files\/(?:(?:pages|imports)\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|gif|webp)$/i
const DATA_SRC = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i
const SAFE_ORIGINAL_SRC =
  /^(https?:|data:image\/(png|jpe?g|gif|webp);base64,|\/(?!\/))/i
const COL_STYLE = /^(width|min-width):\s*\d+(\.\d+)?(px|%)\s*;?$/i
const TABLE_STYLE = /^min-width:\s*\d+(\.\d+)?px\s*;?$/i
const LENGTH_ATTR = /^\d+(\.\d+)?(px|%)?$/i

const whitelist = {
  p: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  pre: [],
  br: [],
  hr: [],
  strong: [],
  b: [],
  em: [],
  i: [],
  u: [],
  s: [],
  del: [],
  strike: [],
  sub: [],
  sup: [],
  blockquote: [],
  code: ["class"],
  a: ["title", "href"],
  img: [
    "src",
    "alt",
    "title",
    "width",
    "height",
    "data-original-src",
    "data-confluence-img"
  ],
  table: ["style"],
  thead: [],
  tbody: [],
  tfoot: [],
  tr: [],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
  colgroup: [],
  col: ["width", "style"],
  ul: ["data-type"],
  ol: [],
  li: ["data-type", "data-checked"],
  label: [],
  input: ["type", "checked", "disabled"],
  div: ["class"]
}

const filter = new FilterXSS({
  whiteList: whitelist,
  stripIgnoreTag: true,
  stripIgnoreTagBody: [
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "form",
    "textarea",
    "title",
    "noscript",
    "template"
  ],
  onTagAttr(tag, name, value) {
    if (tag === "img" && name === "src") {
      if (FILE_SRC.test(value) || DATA_SRC.test(value)) return
      return `data-original-src="${escapeAttrValue(value)}" data-confluence-img="true"`
    }
    if (tag === "img" && name === "data-original-src") {
      return SAFE_ORIGINAL_SRC.test(value) ? undefined : ""
    }
    if (tag === "img" && name === "data-confluence-img") {
      return value === "true" ? undefined : ""
    }
    if (tag === "img" && (name === "width" || name === "height")) {
      return LENGTH_ATTR.test(value) ? undefined : ""
    }
    if (tag === "code" && name === "class") {
      return /^language-[a-z0-9+#-]+$/i.test(value) ? undefined : ""
    }
    if (tag === "table" && name === "style") {
      return TABLE_STYLE.test(value) ? undefined : ""
    }
    if (tag === "col" && name === "style") {
      return COL_STYLE.test(value) ? undefined : ""
    }
    if (tag === "col" && name === "width") {
      return LENGTH_ATTR.test(value) ? undefined : ""
    }
    if (tag === "a" && name === "href") {
      return /^(https?:|mailto:|\/(?!\/)|#)/i.test(value) ? undefined : ""
    }
    if (tag === "div" && name === "class") {
      return value === "tableWrapper" ? undefined : ""
    }
    if (tag === "input" && name === "type") {
      return value === "checkbox" ? undefined : ""
    }
    if (tag === "ul" && name === "data-type") {
      return value === "taskList" ? undefined : ""
    }
    if (tag === "li" && name === "data-type") {
      return value === "taskItem" ? undefined : ""
    }
    if (tag === "li" && name === "data-checked") {
      return value === "true" || value === "false" ? undefined : ""
    }
    if (tag === "td" || tag === "th") {
      return /^\d{1,3}$/.test(value) ? undefined : ""
    }
    return
  }
})

/** 保存页面时调用：白名单过滤 + 外链图片降级为「未转存」标记。 */
export function sanitizePageHtml(html: string): string {
  if (!html) return ""
  return filter.process(html)
}

/**
 * 规范成纯文本（title / content_text / 搜索片段共用）：
 * 剥掉标签与残留尖括号，折叠空白。返回内容不含任何 HTML 语法，
 * 前端再拿去做 innerHTML 高亮也不会形成注入面。
 *
 * 标签正则用 `[^<>]*`（而不是 `[^>]*`）：无闭合 `>` 的病态输入下，后者每个
 * `<` 都会扫到串尾并回溯（O(n²)，30 万字符可耗一分钟），前者在下一个 `<`
 * 或 `>` 就停，整体线性。
 */
export function toPlainText(input: string): string {
  return input
    .replace(/<[^<>]*>/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** 供测试使用：判断一段 src 是否允许原样保留。 */
export function isAllowedImageSrc(src: string): boolean {
  return FILE_SRC.test(src) || DATA_SRC.test(src)
}

export { xss }
