import type { PageNode } from "@/lib/api"

const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g

export function stripControlChars(value: string): string {
  return Array.from(value)
    .filter((char) => char.charCodeAt(0) >= 0x20)
    .join("")
}

export function cleanFilename(title: string, fallback = "untitled"): string {
  const stripped = stripControlChars(title)
    .replace(ILLEGAL_FILENAME_CHARS, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.\s]+|[-.\s]+$/g, "")
  return stripped || fallback
}

/** 短哈希防同名碰撞（取正整数 id 或自增计数器生成 6 位哈希/标识） */
export function shortSuffix(id: number | string): string {
  const str = String(id)
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(16).slice(0, 6)
}

export interface GeneratedPagePaths {
  exportId: string
  parentExportId: string | null
  nodeId: number
  title: string
  sortOrder: number
  jsonPath: string
  mdPath: string
  dirPath: string
}

/**
 * 按树层级递归生成页面包内路径与 exportId。
 * 顶级在 pages/ 下，子级在父级的子目录 pages/<parentDir>/ 下。
 * 同级按 sortOrder 前缀序号，标题清洗后加短后缀防碰撞。
 */
export function generateAllPagePaths(
  roots: PageNode[],
  existingMap = new Map<number, GeneratedPagePaths>()
): Map<number, GeneratedPagePaths> {
  function traverse(
    nodes: PageNode[],
    parentDirPath: string,
    parentExportId: string | null
  ) {
    const sorted = [...nodes].sort((a, b) => a.sortOrder - b.sortOrder)
    for (const node of sorted) {
      const exportId = `p-${node.id}`
      const cleaned = cleanFilename(node.title)
      const suffix = shortSuffix(node.id)
      const baseName = `${node.sortOrder}-${cleaned}-${suffix}`
      const jsonPath = `${parentDirPath}/${baseName}.json`
      const mdPath = `${parentDirPath}/${baseName}.md`
      const dirPath = `${parentDirPath}/${baseName}`

      existingMap.set(node.id, {
        exportId,
        parentExportId,
        nodeId: node.id,
        title: node.title,
        sortOrder: node.sortOrder,
        jsonPath,
        mdPath,
        dirPath
      })

      if (node.children && node.children.length > 0) {
        traverse(node.children, dirPath, exportId)
      }
    }
  }

  traverse(roots, "pages", null)
  return existingMap
}

/**
 * 计算从 fromFilePath 所在目录到 toFilePath 的 POSIX 相对路径。
 * 例如:
 *   from: "pages/0-intro.md", to: "images/cat.png" -> "../images/cat.png"
 *   from: "pages/0-intro/0-guide.md", to: "images/cat.png" -> "../../images/cat.png"
 *   from: "pages/0-intro/0-guide.md", to: "pages/0-intro.md" -> "../0-intro.md"
 *   from: "pages/0-intro/0-guide.md", to: "pages/0-intro/1-next.md" -> "1-next.md"
 */
export function relativePosixPath(
  fromFilePath: string,
  toFilePath: string
): string {
  const fromParts = fromFilePath.split("/").slice(0, -1) // 所在目录
  const toParts = toFilePath.split("/")

  let common = 0
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++
  }

  const upSteps = fromParts.length - common
  const relativeSegments: string[] = []

  for (let i = 0; i < upSteps; i++) {
    relativeSegments.push("..")
  }
  for (let i = common; i < toParts.length; i++) {
    relativeSegments.push(toParts[i])
  }

  return relativeSegments.join("/") || "."
}

/**
 * 确保文件名唯一（同名时添加 -2, -3 序号）。
 */
export function uniquifyFilename(filename: string, used: Set<string>): string {
  if (!used.has(filename)) return filename
  const lastDot = filename.lastIndexOf(".")
  const stem = lastDot === -1 ? filename : filename.slice(0, lastDot)
  const ext = lastDot === -1 ? "" : filename.slice(lastDot)
  let seq = 2
  while (used.has(`${stem}-${seq}${ext}`)) {
    seq++
  }
  return `${stem}-${seq}${ext}`
}
