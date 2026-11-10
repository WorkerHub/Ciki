/**
 * 单页「下载 .md」的服务端口径（规格 v1.0 §2/§3）。
 *
 * 一期这一功能完全在前端拼：Blob + 临时链接，正文是 `# 标题` + `contentMd`。含站内图的
 * 页面下载到本地必然裂图——MD 里是 `https://ciki.oneboy.app/api/files/<key>` 绝对地址，
 * 而该接口只认登录会话，本地阅读器拿不到图。所以分流搬到服务端：无站内图回 `.md`，
 * 有站内图回 zip 包（图从 R2 直读入包，链接在包内改写成 `images/<basename>`）。
 *
 * 这个文件只管**纯函数口径**（文件名、正文拼装、站内图检索与改写、响应头），不碰 DB、
 * 不碰 R2：三者分开放，路由层读页面与 R2，zip 流式组装在 lib/zip-stream.ts。
 *
 * 三条不许动的线：
 * - 库里 `content_md` 永远存绝对地址版（规格 §4），相对化只发生在组装 zip 时；
 * - 除站内图链接外，zip 内 MD 与 `.md` 产物**逐字一致**（规格 §3）；
 * - 站外图（非 `/api/files/` 或 key 形状不合规）一律原样保留，不抓取入包（规格 §5）。
 */
import { CIKI_MD_ORIGIN } from "./tiptap-markdown"
import { UPLOAD_KEY_RE } from "./upload"

/** 标题清不出可用名字时的兜底（与一期前端同一口径）。 */
const UNTITLED_PAGE = "未命名页面"

/** 主名清洗后仍是纯 ASCII 时的兜底兜底——`filename=` 不能为空。 */
const ASCII_FALLBACK = "page"

/** 文件名里不能出现的字符：换成 `-`，避免下载失败或被截断。 */
const ILLEGAL_FILENAME = /[\\/:*?"<>|]/g

/** zip 内图片目录名（规格 §3）。 */
const IMAGE_DIR = "images"

/** 站内图 URL 的固定前缀：常量 origin + `/api/files/`，与 MD 派生同一口径。 */
const SITE_FILE_PREFIX = `${CIKI_MD_ORIGIN}/api/files/`

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * MD 里的站内**图片**引用：`![alt](https://ciki.oneboy.app/api/files/<key>)`。
 *
 * 锚在图片语法上而不是裸 URL：规格 §3 定义的是「图片引用」，正文里别处出现的
 * `/api/files/` 地址（链接、行内代码）不该被改写。alt 允许转义方括号（派生器会把
 * alt 里的 `[`/`]` 转义），key 到 `)` 或空白为止。
 */
const SITE_IMAGE_RE = new RegExp(
  `(!\\[(?:\\\\.|[^\\]\\\\])*\\]\\()${escapeRegExp(SITE_FILE_PREFIX)}([^)\\s]+)\\)`,
  "g"
)

export interface MarkdownDownloadPage {
  title: string
  /** 页面详情里的 `contentMd`（派生件，不含标题行）。 */
  contentMd: string
}

/** 控制字符（标题里极少数情况会出现）：直接丢掉，不能留在文件名里。 */
function stripControlChars(value: string): string {
  return Array.from(value)
    .filter((char) => char.charCodeAt(0) >= 0x20)
    .join("")
}

/** 折叠连续 `-`、去掉首尾的 `-` / `.` / 空白；清不出东西时回空串。 */
function tidyFilename(value: string): string {
  return value.replace(/-{2,}/g, "-").replace(/^[-.\s]+|[-.\s]+$/g, "")
}

/**
 * 下载产物的主名（不含扩展名）：一期前端的 `markdownFilename` 同套规则——
 * 丢控制字符 → 非法字符换 `-` → 连续 `-` 折成一个 → 去首尾 → 空则「未命名页面」。
 * 中文原样保留，由响应头的 `filename*=UTF-8''…` 承载。
 */
export function cleanPageFilename(title: string): string {
  const cleaned = tidyFilename(
    stripControlChars(title).replace(ILLEGAL_FILENAME, "-")
  )
  return cleaned || UNTITLED_PAGE
}

/**
 * `filename=` 的 ASCII 兜底（老客户端只认这一段）：非 ASCII 字符换 `-` 后折叠，
 * 折叠后为空用 `page`。主名本身是 ASCII 时原样返回。
 */
export function asciiFilenameFallback(name: string): string {
  const ascii = tidyFilename(
    Array.from(name)
      .map((char) => (char.charCodeAt(0) < 0x80 ? char : "-"))
      .join("")
  )
  return ascii || ASCII_FALLBACK
}

/**
 * `Content-Disposition`：主名走 RFC 5987 的 `filename*`（中文原样），`filename=` 给
 * ASCII 兜底。两段都带扩展名。
 */
export function contentDisposition(
  name: string,
  extension: ".md" | ".zip"
): string {
  const encoded = encodeURIComponent(`${name}${extension}`).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
  const ascii = `${asciiFilenameFallback(name)}${extension}`
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/**
 * 标题行 + 空行 + `contentMd`，末尾恰好一个换行；正文为空时只留标题行。
 *
 * 与一期前端的 `markdownDocument` 逐字一致——无图页下载到的 `.md` 必须和改前同字节，
 * 所以这里不做任何额外裁剪或换行归一。
 */
export function markdownDocument(page: MarkdownDownloadPage): string {
  const heading = `# ${page.title.trim()}`
  const body = page.contentMd.trimEnd()
  return body ? `${heading}\n\n${body}\n` : `${heading}\n`
}

/**
 * MD 里引用到的站内图 key（按首次出现顺序去重）。
 *
 * 判据（规格 §2 + 契约）：地址是常量 origin + `/api/files/`，且 key 形状过
 * `UPLOAD_KEY_RE`（`pages|imports|avatars/<uuid>.<ext>` 或存量平铺 `<uuid>.<ext>`）。
 * 形状不合规的（`svg`、多级前缀、大写 hex 等）与站外图同等对待：不计入分流依据、
 * 也不改写。
 */
export function siteImageKeys(markdown: string): string[] {
  const keys: string[] = []
  for (const match of markdown.matchAll(SITE_IMAGE_RE)) {
    const key = match[2]
    if (!UPLOAD_KEY_RE.test(key) || keys.includes(key)) continue
    keys.push(key)
  }
  return keys
}

/** key 的 basename（`pages/<uuid>.png` → `<uuid>.png`；平铺 key 原样）。 */
function basename(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1)
}

/** 撞名兜底：同主名时加序号（`<uuid>-2.png`），表里查不到就自增。 */
function uniquify(name: string, used: Set<string>): string {
  if (!used.has(name)) return name
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ""
  let index = 2
  let candidate = `${stem}-${index}${extension}`
  while (used.has(candidate)) {
    index += 1
    candidate = `${stem}-${index}${extension}`
  }
  return candidate
}

/**
 * 每张站内图在包内的文件名（key → `images/` 下的名字）。
 *
 * 默认取 key 的 basename：UUID 天然不撞名，同图多次引用也只会有一个 key。真撞名
 * （`pages/<uuid>.png` 与 `imports/<uuid>.png`、或平铺 key 与带前缀的同名 key）
 * 按规格 §3 的兜底把 key 全路径下划线化；万一仍撞，再加序号，绝不丢图或覆盖。
 */
export function imageEntryNames(keys: string[]): Map<string, string> {
  const counts = new Map<string, number>()
  for (const key of keys) {
    const name = basename(key)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  const used = new Set<string>()
  const names = new Map<string, string>()
  for (const key of keys) {
    const name = basename(key)
    const candidate =
      (counts.get(name) ?? 0) > 1 ? key.replace(/\//g, "_") : name
    const unique = uniquify(candidate, used)
    used.add(unique)
    names.set(key, unique)
  }
  return names
}

/** 图片在 MD 里的相对链接（规格 §3：`images/<basename>`）。 */
export function imageLink(name: string): string {
  return `${IMAGE_DIR}/${name}`
}

/**
 * 改写站内图链接：`resolve(key)` 给出包内文件名就换成 `images/<name>`，给 null
 * （R2 里已经没有了）就原样留着——绝对地址至少不比现状更差（规格 §6）。alt、其余
 * 正文、站外图一字不动。
 */
export function rewriteSiteImageLinks(
  markdown: string,
  resolve: (key: string) => string | null
): string {
  return markdown.replace(
    SITE_IMAGE_RE,
    (match: string, head: string, rawKey: string) => {
      if (!UPLOAD_KEY_RE.test(rawKey)) return match
      const name = resolve(rawKey)
      return name === null ? match : `${head}${imageLink(name)})`
    }
  )
}
