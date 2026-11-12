/**
 * 阅读页「下载 .md」：内容由服务端组装，前端只触发一次下载。
 *
 * 服务端按该页 MD 是否引用站内托管图片自动分流：无站内图回 `.md`，有则回 zip
 * （`<标题>.md` + `images/`，包内链接已相对化）。文件名由服务端写在
 * Content-Disposition 里，取不到时退回本地按标题拼的名字；正文绝不在这里拼装。
 */
import { type PageDetail, pagesApi } from "@/lib/api"
import i18n from "@/i18n"

/** 文件名里不能出现的字符：换成 `-`，避免下载失败或被截断。 */
const ILLEGAL_FILENAME = /[\\/:*?"<>|]/g

/** 控制字符（标题里极少数情况会出现）：直接丢掉，不能留在文件名里。 */
function stripControlChars(value: string): string {
  return Array.from(value)
    .filter((char) => char.charCodeAt(0) >= 0x20)
    .join("")
}

/** 文件名 = 页面标题.md；只在服务端没给文件名时兜底。 */
export function markdownFilename(title: string): string {
  const cleaned = stripControlChars(title)
    .replace(ILLEGAL_FILENAME, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.\s]+|[-.\s]+$/g, "")
  return `${cleaned || i18n.t("page.untitled")}.md`
}

/**
 * RFC 5987 的编码值：`UTF-8''%E4%B8%AD.md`，charset 与语言标记之后才是文件名。
 * 只有 UTF-8 认（别的 charset 按 latin-1 解会出乱码），不合形态的一律返回
 * null 交给 `filename` 兜底；百分号编码残缺时退回原串，总比整次下载没有文件名好。
 */
function decodeExtendedValue(raw: string): string | null {
  const unquoted = raw.trim().replace(/^"(.*)"$/s, "$1")
  const [charset, , ...value] = unquoted.split("'")
  if (value.length === 0 || charset?.toLowerCase() !== "utf-8") return null
  const encoded = value.join("'").trim()
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

/**
 * 从 Content-Disposition 里取文件名：先 `filename*`（RFC 5987，charset 必须是
 * UTF-8，值按百分号编码还原），再 `filename`（ASCII 兜底）；都没有时返回 null，
 * 由调用方按标题兜底。
 */
export function dispositionFilename(header: string | null): string | null {
  if (!header) return null
  const extended = /filename\*\s*=\s*([^;]+)/i.exec(header)
  const fromExtended = extended ? decodeExtendedValue(extended[1]) : null
  if (fromExtended) return fromExtended
  // 参数名必须从 `;` 或头部开头起算：否则 `filename*=…` 里的 `filename` 会被误命中
  const plain = /(?:^|;)\s*filename\s*=\s*("[^"]*"|[^;]+)/i.exec(header)
  if (!plain) return null
  const name = plain[1]
    .trim()
    .replace(/^"(.*)"$/s, "$1")
    .trim()
  return name || null
}

/** 触发一次本地下载（Blob + 临时链接触发，读完即释放）。 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.style.display = "none"
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // 立刻 revoke 会让个别浏览器拿不到内容：让出一轮事件循环再释放
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * 下载当前页面的 Markdown 产物（`.md` 或含站内图时的 zip）。
 * 只发一次请求；失败原样抛出，由调用方按 describeApiError 的口径提示。
 */
export async function downloadPageMarkdown(
  page: Pick<PageDetail, "id" | "title">
): Promise<void> {
  const { blob, contentDisposition } = await pagesApi.download(page.id)
  saveBlob(
    blob,
    dispositionFilename(contentDisposition) ?? markdownFilename(page.title)
  )
}
