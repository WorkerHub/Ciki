import type { ManifestFile, ManifestFileCategory } from "./types"
import { relativePosixPath } from "./path"

/** 对外暴露的站内文件 key 形状：avatars/pages/imports 前缀或平铺 UUID.扩展名 */
export const UPLOAD_KEY_RE =
  /^(?:(?:avatars|pages|imports)\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|gif|webp|json)$/i

/** embed 文件 key 形状：embeds/<uuid>.html */
export const EMBED_KEY_RE =
  /^embeds\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.html$/i

export function isValidFileKey(key: string): boolean {
  return UPLOAD_KEY_RE.test(key) || EMBED_KEY_RE.test(key)
}

export interface ExtractedFileRef {
  originalKey: string
  category: ManifestFileCategory
  hintName?: string
}

/** 检查并提取 /api/files/<key> 中的 key */
export function parseFileKeyFromUrl(url: string): string | null {
  if (!url || typeof url !== "string") return null
  const trimmed = url.trim()
  // 匹配 /api/files/<key> 或 http(s)://.../api/files/<key>，且必须匹配站内 key 形状
  const match = /(?:^|https?:\/\/[^/]+)\/api\/files\/([^\s?#)]+)/.exec(trimmed)
  if (match) {
    const decoded = decodeURIComponent(match[1])
    return isValidFileKey(decoded) ? decoded : null
  }
  // 或者本身已经是 key 形式（如 pages/uuid.png, imports/uuid.png, embeds/uuid.html）
  if (isValidFileKey(trimmed)) {
    return trimmed
  }
  return null
}

/** 从 TipTap JSON 树中提取所有被引用的资源文件（图片、画布场景与预览、Embed 动画等） */
export function extractReferencedFiles(
  contentJson: string
): ExtractedFileRef[] {
  const refs: ExtractedFileRef[] = []
  const seenKeys = new Set<string>()

  let doc: unknown
  try {
    doc = JSON.parse(contentJson)
  } catch {
    return refs
  }

  function addRef(
    key: string | null,
    category: ManifestFileCategory,
    hintName?: string
  ) {
    if (!key || seenKeys.has(key)) return
    seenKeys.add(key)
    refs.push({ originalKey: key, category, hintName })
  }

  function traverse(node: unknown) {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) {
      for (const item of node) traverse(item)
      return
    }

    const record = node as Record<string, unknown>
    const type = record.type
    const attrs = (
      record.attrs && typeof record.attrs === "object" ? record.attrs : null
    ) as Record<string, unknown> | null

    if (type === "image" && attrs) {
      const src = typeof attrs.src === "string" ? attrs.src : ""
      const origSrc =
        typeof attrs.originalSrc === "string" ? attrs.originalSrc : ""
      const key = parseFileKeyFromUrl(src) || parseFileKeyFromUrl(origSrc)
      if (key) {
        addRef(key, "images")
      }
    } else if (type === "excalidraw" && attrs) {
      const sceneKey =
        typeof attrs.sceneKey === "string" ? attrs.sceneKey.trim() : ""
      const previewKey =
        typeof attrs.previewKey === "string" ? attrs.previewKey.trim() : ""
      if (sceneKey) {
        const parsedScene = parseFileKeyFromUrl(sceneKey) || sceneKey
        addRef(parsedScene, "canvases", "scene.json")
      }
      if (previewKey) {
        const parsedPreview = parseFileKeyFromUrl(previewKey) || previewKey
        addRef(parsedPreview, "canvases", "preview.png")
      }
    } else if (type === "htmlEmbed" && attrs) {
      const key = typeof attrs.key === "string" ? attrs.key.trim() : ""
      const name =
        typeof attrs.name === "string" ? attrs.name.trim() : undefined
      if (key) {
        const parsedKey = parseFileKeyFromUrl(key) || key
        addRef(parsedKey, "embeds", name)
      }
    }

    if (Array.isArray(record.content)) {
      for (const child of record.content) {
        traverse(child)
      }
    }
  }

  traverse(doc)
  return refs
}

/** 导入时：重写 TipTap contentJson 中的结构化引用 */
export function rewriteContentJson(
  contentJson: string,
  fileKeyMap: Record<string, string>,
  pageIdMap: Record<number, number>
): { rewrittenJson: string; remappedLinksCount: number } {
  let doc: unknown
  try {
    doc = JSON.parse(contentJson)
  } catch {
    return { rewrittenJson: contentJson, remappedLinksCount: 0 }
  }

  let remappedLinksCount = 0

  function rewriteUrl(url: string): string {
    const key = parseFileKeyFromUrl(url)
    if (!key) return url
    const newKey = fileKeyMap[key]
    if (!newKey) return url
    return `/api/files/${newKey}`
  }

  function rewriteLinkHref(href: string): string {
    const match = /(?:^|https?:\/\/[^/]+)\/p\/(\d+)(#[^\s]*)?$/.exec(href)
    if (!match) return href
    const oldId = Number(match[1])
    const newId = pageIdMap[oldId]
    if (!newId) return href
    remappedLinksCount++
    const hash = match[2] || ""
    return `/p/${newId}${hash}`
  }

  function traverse(node: unknown) {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) {
      for (const item of node) traverse(item)
      return
    }

    const record = node as Record<string, unknown>
    const type = record.type
    const attrs = (
      record.attrs && typeof record.attrs === "object" ? record.attrs : null
    ) as Record<string, unknown> | null

    if (type === "image" && attrs) {
      if (typeof attrs.src === "string") {
        attrs.src = rewriteUrl(attrs.src)
      }
      if (typeof attrs.originalSrc === "string") {
        attrs.originalSrc = rewriteUrl(attrs.originalSrc)
      }
    } else if (type === "excalidraw" && attrs) {
      if (typeof attrs.sceneKey === "string") {
        const key = parseFileKeyFromUrl(attrs.sceneKey) || attrs.sceneKey
        if (fileKeyMap[key]) {
          attrs.sceneKey = fileKeyMap[key]
        }
      }
      if (typeof attrs.previewKey === "string" && attrs.previewKey) {
        const key = parseFileKeyFromUrl(attrs.previewKey) || attrs.previewKey
        if (fileKeyMap[key]) {
          attrs.previewKey = fileKeyMap[key]
        }
      }
    } else if (type === "htmlEmbed" && attrs) {
      if (typeof attrs.key === "string") {
        const key = parseFileKeyFromUrl(attrs.key) || attrs.key
        if (fileKeyMap[key]) {
          attrs.key = fileKeyMap[key]
        }
      }
    }

    // 重写 mark 中的 link
    if (Array.isArray(record.marks)) {
      for (const mark of record.marks) {
        if (
          mark &&
          typeof mark === "object" &&
          (mark as Record<string, unknown>).type === "link"
        ) {
          const markAttrs = (mark as Record<string, unknown>).attrs as
            | Record<string, unknown>
            | undefined
          if (markAttrs && typeof markAttrs.href === "string") {
            markAttrs.href = rewriteLinkHref(markAttrs.href)
          }
        }
      }
    }

    if (Array.isArray(record.content)) {
      for (const child of record.content) {
        traverse(child)
      }
    }
  }

  traverse(doc)
  return {
    rewrittenJson: JSON.stringify(doc),
    remappedLinksCount
  }
}

/** 导出时：重写 Markdown 文件内容为相对路径，并附加首行一级标题 */
export function rewriteMarkdownForExport(
  pageTitle: string,
  contentMd: string,
  currentMdPath: string,
  fileManifestMap: Map<string, ManifestFile>,
  pageMdPathMap: Map<number, string>
): string {
  let body = contentMd || ""

  // 1. 改写站内图片：![alt](.../api/files/<key>)
  body = body.replace(
    /(!\[(?:\\.|[^\]\\])*\]\()(?:https?:\/\/[^/]+)?\/api\/files\/([^)\s]+)(\))/g,
    (full, prefix, rawKey, suffix) => {
      const key = decodeURIComponent(rawKey)
      const file = fileManifestMap.get(key)
      if (!file || file.missing) return full
      const rel = relativePosixPath(currentMdPath, file.packagePath)
      return `${prefix}${rel}${suffix}`
    }
  )

  // 2. 改写站内 embed: [HTML 动画：...](.../api/files/<key>)
  body = body.replace(
    /(\[(?:\\.|[^\]\\])*\]\()(?:https?:\/\/[^/]+)?\/api\/files\/([^)\s]+)(\))/g,
    (full, prefix, rawKey, suffix) => {
      const key = decodeURIComponent(rawKey)
      const file = fileManifestMap.get(key)
      if (!file || file.missing) return full
      const rel = relativePosixPath(currentMdPath, file.packagePath)
      return `${prefix}${rel}${suffix}`
    }
  )

  // 3. 改写站内页面链接: [title](.../p/<id>[#hash])
  body = body.replace(
    /(\[(?:\\.|[^\]\\])*\]\()(?:https?:\/\/[^/]+)?\/p\/(\d+)(#[^)\s]*)?(\))/g,
    (full, prefix, oldIdStr, hash = "", suffix) => {
      const oldId = Number(oldIdStr)
      const targetMdPath = pageMdPathMap.get(oldId)
      if (!targetMdPath) return full
      const rel = relativePosixPath(currentMdPath, targetMdPath)
      return `${prefix}${rel}${hash}${suffix}`
    }
  )

  const titleHeader = `# ${pageTitle}`
  const trimmedBody = body.trim()
  if (!trimmedBody) {
    return `${titleHeader}\n`
  }
  return `${titleHeader}\n\n${trimmedBody}\n`
}
