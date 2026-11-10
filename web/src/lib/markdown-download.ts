/**
 * 阅读页「下载 .md」：把页面详情里的服务端派生 MD 落成本地文件。
 *
 * 内容口径（规格 §一.5）：标题一级标题 + content_md。MD 是派生件，这里只做
 * 拼装与浏览器下载，绝不解析、改写或回写正文；空正文只留标题行。
 */
import type { PageDetail } from "@/lib/api"

type MarkdownPage = Pick<PageDetail, "title" | "contentMd">

/** 文件名里不能出现的字符：换成 `-`，避免下载失败或被截断。 */
const ILLEGAL_FILENAME = /[\\/:*?"<>|]/g

/** 控制字符（标题里极少数情况会出现）：直接丢掉，不能留在文件名里。 */
function stripControlChars(value: string): string {
  return Array.from(value)
    .filter((char) => char.charCodeAt(0) >= 0x20)
    .join("")
}

/** 文件名 = 页面标题.md；标题清不出一段可用名字时退回「未命名页面」。 */
export function markdownFilename(title: string): string {
  const cleaned = stripControlChars(title)
    .replace(ILLEGAL_FILENAME, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.\s]+|[-.\s]+$/g, "")
  return `${cleaned || "未命名页面"}.md`
}

/**
 * 标题行 + 空行 + content_md，末尾恰好一个换行。
 * content_md 尾部自带空行时先去掉，保证与读接口返回的 markdown 相比只多标题行。
 */
export function markdownDocument(page: MarkdownPage): string {
  const heading = `# ${page.title.trim()}`
  const body = page.contentMd.trimEnd()
  return body ? `${heading}\n\n${body}\n` : `${heading}\n`
}

/** 触发一次本地下载（Blob + 临时链接触发，读完即释放）。 */
export function downloadMarkdown(page: MarkdownPage): void {
  const blob = new Blob([markdownDocument(page)], {
    type: "text/markdown;charset=utf-8"
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = markdownFilename(page.title)
  anchor.style.display = "none"
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // 立刻 revoke 会让个别浏览器拿不到内容：让出一轮事件循环再释放
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
