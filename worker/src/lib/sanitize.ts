/**
 * 服务端二次消毒（规格 §4：前端清洗不是安全边界，保存时必须再过一遍）。
 *
 * 白名单与前端粘贴小样（prototype/src/cleaner.js）保持结构一致，另加两项：
 * - 表格/列宽的受限 `style`（TipTap 的 table/col 直接输出 style，不能丢）；
 * - 外链图片的 `src` 移入 `data-original-src` + `data-confluence-img="true"`，
 *   不保留可直连的外部地址（读态由前端渲染「未转存」占位）。
 *
 * 两支过滤器共用**同一份白名单**，差别只有 `img[src]` 一处（见 {@link ImageSrcPolicy}）：
 * 正文按上面的「未转存」口径，评论按「站内 + https 外链直接渲染」口径
 * （规格「页尾评论」§三，评论区没有图片上传入口，占位没有意义）。
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
/**
 * 评论区的图片白名单（规格「页尾评论」§三）：只收站内 `/api/files/…` 与 `https:`
 * 外链，其余（`http:`、`data:`、非法地址）一律剥除 src。评论区没有上传入口，所以这里
 * 不再写「未转存」占位属性——http/data 地址并不代表可补传，留着属性只是噪音。
 */
const HTTPS_SRC = /^https:\/\//i
const COL_STYLE = /^(width|min-width):\s*\d+(\.\d+)?(px|%)\s*;?$/i
const TABLE_STYLE = /^min-width:\s*\d+(\.\d+)?px\s*;?$/i
const LENGTH_ATTR = /^\d+(\.\d+)?(px|%)?$/i
/**
 * 颜色载具：`span[data-text-color]` / `mark[data-color]`（高亮）/ `td,th[data-cell-bg]`。
 * 值只收六位十六进制（大小写都收，入库统一小写）——与前端 `web/src/lib/color.ts`、
 * docs/api-contract.md 同一口径。颜色不走 CSS：style 一律被剥，读态由编辑器扩展
 * 从 data 属性还原（见 lib/tiptap-html.ts）。
 */
const COLOR_ATTR = /^#[0-9a-fA-F]{6}$/

/** 合法颜色载具重新序列化（值统一小写，与库里的形态一致）；非法返回空串即删除。 */
function colorAttr(name: string, value: string): string {
  return COLOR_ATTR.test(value) ? `${name}="${value.toLowerCase()}"` : ""
}

const whitelist = {
  p: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  pre: ["data-collapsed"],
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
  span: ["data-text-color"],
  mark: ["data-color"],
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
  td: ["colspan", "rowspan", "data-cell-bg"],
  th: ["colspan", "rowspan", "data-cell-bg"],
  colgroup: [],
  col: ["width", "style"],
  ul: ["data-type"],
  ol: [],
  li: ["data-type", "data-checked"],
  label: [],
  input: ["type", "checked", "disabled"],
  div: ["class"]
}

const STRIP_TAG_BODY = [
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
]

/**
 * 两支过滤器的唯一分歧点：正文把站外图片降级成「未转存」占位，评论直接放行
 * `https:` 外链、其余剥除 src（不写占位属性）。
 */
type ImageSrcPolicy = "page" | "comment"

function createFilter(policy: ImageSrcPolicy): FilterXSS {
  return new FilterXSS({
    whiteList: whitelist,
    stripIgnoreTag: true,
    stripIgnoreTagBody: STRIP_TAG_BODY,
    onTagAttr(tag, name, value) {
      if (tag === "img" && name === "src") {
        if (policy === "comment") {
          return FILE_SRC.test(value) || HTTPS_SRC.test(value) ? undefined : ""
        }
        if (FILE_SRC.test(value) || DATA_SRC.test(value)) return
        return `data-original-src="${escapeAttrValue(value)}" data-confluence-img="true"`
      }
      if (tag === "img" && name === "data-original-src") {
        if (policy === "comment") return ""
        return SAFE_ORIGINAL_SRC.test(value) ? undefined : ""
      }
      if (tag === "img" && name === "data-confluence-img") {
        if (policy === "comment") return ""
        return value === "true" ? undefined : ""
      }
      if (tag === "img" && (name === "width" || name === "height")) {
        return LENGTH_ATTR.test(value) ? undefined : ""
      }
      if (tag === "code" && name === "class") {
        return /^language-[a-z0-9+#-]+$/i.test(value) ? undefined : ""
      }
      // 代码块折叠态：只认显式的 true/false（未表态就是没有这个属性）。
      // 与前端 li[data-checked] 同口径：合法放行，非法只删属性、不动代码正文。
      if (tag === "pre" && name === "data-collapsed") {
        return value === "true" || value === "false" ? undefined : ""
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
      // 颜色载具：合法就重新吐一遍（顺手统一成小写），非法直接删。
      if (tag === "span" && name === "data-text-color") {
        return colorAttr(name, value)
      }
      if (tag === "mark" && name === "data-color") {
        return colorAttr(name, value)
      }
      // 必须在下面 td/th 的兜底（只认数字）之前，否则 data-cell-bg 会被误删
      if ((tag === "td" || tag === "th") && name === "data-cell-bg") {
        return colorAttr(name, value)
      }
      if (tag === "td" || tag === "th") {
        return /^\d{1,3}$/.test(value) ? undefined : ""
      }
      return
    }
  })
}

const pageFilter = createFilter("page")
const commentFilter = createFilter("comment")

/** 保存页面时调用：白名单过滤 + 外链图片降级为「未转存」标记。 */
export function sanitizePageHtml(html: string): string {
  if (!html) return ""
  return pageFilter.process(html)
}

/**
 * 评论渲染 HTML 的消毒（规格「页尾评论」§三）：同一份白名单，只把 `img[src]` 换成
 * 「站内 `/api/files/…` 或 `https:` 外链原样保留，其余剥除」。评论正文永远来自
 * Markdown 渲染结果，所以这里的入参只有 `lib/comment-render.ts` 一条来源。
 */
export function sanitizeCommentHtml(html: string): string {
  if (!html) return ""
  return commentFilter.process(html)
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
