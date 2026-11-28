import * as fflate from "fflate"
import { generateHTML, generateText } from "@tiptap/core"
import { ApiError, api, pagesApi, spacesApi } from "@/lib/api"
import { createExtensions } from "@/editor/extensions"
import { deleteCheckpoint, getCheckpoint, saveCheckpoint } from "./checkpoint"
import { rewriteContentJson } from "./content-parser"
import { AbortError, executeWithRetry } from "./scheduler"
import type {
  ImportCheckpoint,
  ImportFatalError,
  ImportPreflightResult,
  ImportProgress,
  ImportReport,
  ManifestFileCategory,
  ManifestPage,
  SpaceExportManifest
} from "./types"

const ALLOWED_TOP_LEVEL_PREFIXES = [
  "manifest.json",
  "pages/",
  "images/",
  "embeds/",
  "canvases/",
  "files/"
]

/** 解压 zip 并以键值对形式返回 */
export async function decompressZip(
  file: File | Blob | Uint8Array
): Promise<Record<string, Uint8Array>> {
  let buffer: Uint8Array
  if (file instanceof Uint8Array) {
    buffer = file
  } else {
    buffer = new Uint8Array(await file.arrayBuffer())
  }

  return new Promise((resolve, reject) => {
    fflate.unzip(buffer, (err, unzipped) => {
      if (err) reject(err)
      else resolve(unzipped)
    })
  })
}

/** 检查页面树无环与父子完整性 */
export function validatePageTree(pages: ManifestPage[]): {
  valid: boolean
  error?: ImportFatalError
} {
  const exportIds = new Set<string>()
  for (const page of pages) {
    exportIds.add(page.exportId)
  }

  // 1. 父子完整性
  for (const page of pages) {
    if (page.parentExportId !== null && !exportIds.has(page.parentExportId)) {
      return {
        valid: false,
        error: {
          code: "INVALID_PARENT",
          message: `页面父级不存在: ${page.title} (父 exportId: ${page.parentExportId})`
        }
      }
    }
  }

  // 2. 无环校验
  const parentMap = new Map<string, string | null>()
  for (const page of pages) {
    parentMap.set(page.exportId, page.parentExportId)
  }

  for (const page of pages) {
    const visited = new Set<string>()
    let curr: string | null = page.exportId
    while (curr !== null) {
      if (visited.has(curr)) {
        return {
          valid: false,
          error: {
            code: "CYCLE_DETECTED",
            message: `页面树检测到循环依赖: ${curr}`
          }
        }
      }
      visited.add(curr)
      curr = parentMap.get(curr) ?? null
    }
  }

  return { valid: true }
}

/**
 * 本地预检（零服务端写入）：
 * - manifest 存在且 format 相符
 * - formatVersion 受支持
 * - 页面树无环、父子完整
 * - 每页 JSON 可解析
 * - 包内文件与 manifest files 清单对齐（missing:true 除外）
 * - zip 条目无路径穿越（../ 与绝对路径整单拒绝）
 * - 顶层结构在 §一 白名单内
 * - 任一致命项不过整单拒绝不调任何写接口
 */
export async function preflightSpaceArchive(
  entries: Record<string, Uint8Array>,
  zipSha256: string
): Promise<ImportPreflightResult> {
  const fatalErrors: ImportFatalError[] = []
  const warnings: string[] = []

  // 1. 检查路径穿越与顶层结构白名单
  for (const path of Object.keys(entries)) {
    // 过滤系统解压残留的空目录条目
    if (path.endsWith("/")) continue

    const segments = path.split(/[/\\]/)
    const isTraversal =
      segments.some((segment) => segment === "..") ||
      path.startsWith("/") ||
      path.startsWith("\\")

    if (isTraversal) {
      fatalErrors.push({
        code: "PATH_TRAVERSAL",
        message: `检测到路径穿越或非法路径条目: ${path}`
      })
      break
    }

    const isAllowed = ALLOWED_TOP_LEVEL_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(prefix)
    )
    if (!isAllowed) {
      fatalErrors.push({
        code: "INVALID_STRUCTURE",
        message: `条目不在顶层白名单内: ${path}`
      })
      break
    }
  }

  // 2. 检查 manifest.json
  const manifestEntry = entries["manifest.json"]
  if (!manifestEntry) {
    fatalErrors.push({
      code: "MANIFEST_MISSING",
      message: "未在压缩包根目录找到 manifest.json"
    })
  }

  let manifest: SpaceExportManifest | null = null
  if (manifestEntry) {
    try {
      const text = fflate.strFromU8(manifestEntry)
      manifest = JSON.parse(text) as SpaceExportManifest
    } catch {
      fatalErrors.push({
        code: "INVALID_FORMAT",
        message: "manifest.json 格式损坏，无法解析为 JSON"
      })
    }
  }

  if (manifest) {
    if (manifest.format !== "ciki-space-export") {
      fatalErrors.push({
        code: "INVALID_FORMAT",
        message: `不受支持的包格式: ${manifest.format}`
      })
    }
    if (manifest.formatVersion !== 1) {
      fatalErrors.push({
        code: "UNSUPPORTED_VERSION",
        message: `不受支持的格式版本: ${manifest.formatVersion}`
      })
    }

    if (Array.isArray(manifest.warnings)) {
      warnings.push(...manifest.warnings)
    }

    // 3. 校验页面树
    if (Array.isArray(manifest.pages)) {
      const treeCheck = validatePageTree(manifest.pages)
      if (!treeCheck.valid && treeCheck.error) {
        fatalErrors.push(treeCheck.error)
      }

      // 4. 校验每页 JSON 可解析
      for (const page of manifest.pages) {
        const jsonBytes = entries[page.jsonPath]
        if (!jsonBytes) {
          fatalErrors.push({
            code: "INVALID_PAGE_JSON",
            message: `包内缺少页面 JSON 文件: ${page.jsonPath}`
          })
          break
        }
        try {
          const jsonStr = fflate.strFromU8(jsonBytes)
          JSON.parse(jsonStr)
        } catch {
          fatalErrors.push({
            code: "INVALID_PAGE_JSON",
            message: `页面 JSON 损坏: ${page.title} (${page.jsonPath})`
          })
          break
        }
      }
    } else {
      fatalErrors.push({
        code: "INVALID_FORMAT",
        message: "manifest.pages 必须为数组"
      })
    }

    // 5. 包内文件与 manifest files 清单对齐（missing:true 除外）
    if (Array.isArray(manifest.files)) {
      for (const file of manifest.files) {
        if (file.missing) continue
        if (!entries[file.packagePath]) {
          fatalErrors.push({
            code: "FILE_LIST_MISMATCH",
            message: `清单文件在包内不存在: ${file.packagePath}`
          })
          break
        }
      }
    } else {
      fatalErrors.push({
        code: "INVALID_FORMAT",
        message: "manifest.files 必须为数组"
      })
    }
  }

  // 统计文件数
  const fileCounts = {
    images: 0,
    embeds: 0,
    canvases: 0,
    files: 0,
    total: 0
  }
  let missingFilesCount = 0

  if (manifest && Array.isArray(manifest.files)) {
    for (const f of manifest.files) {
      if (f.missing) {
        missingFilesCount++
        continue
      }
      if (f.category in fileCounts) {
        fileCounts[f.category as ManifestFileCategory]++
      } else {
        fileCounts.files++
      }
      fileCounts.total++
    }
  }

  // 6. 探测 IndexedDB 检查点与目标空间有效性
  let hasCheckpoint = false
  let targetSpaceExists = false
  let existingSpaceId: number | undefined

  const checkpoint = await getCheckpoint(zipSha256)
  if (checkpoint) {
    try {
      await pagesApi.tree(checkpoint.targetSpaceId)
      hasCheckpoint = true
      targetSpaceExists = true
      existingSpaceId = checkpoint.targetSpaceId
    } catch {
      // 目标空间已被删，检查点作废
      await deleteCheckpoint(zipSha256)
    }
  }

  return {
    valid: fatalErrors.length === 0,
    manifest,
    fatalErrors,
    warnings,
    pageCount: manifest?.pages?.length ?? 0,
    fileCounts,
    missingFilesCount,
    hasCheckpoint,
    targetSpaceExists,
    existingSpaceId
  }
}

/** 对页面进行拓扑排序：父页面先于子页面 */
export function sortPagesTopologically(pages: ManifestPage[]): ManifestPage[] {
  const sorted: ManifestPage[] = []
  const added = new Set<string>()
  const remaining = [...pages]

  while (remaining.length > 0) {
    let progressMade = false
    for (let i = 0; i < remaining.length; i++) {
      const page = remaining[i]
      if (page.parentExportId === null || added.has(page.parentExportId)) {
        sorted.push(page)
        added.add(page.exportId)
        remaining.splice(i, 1)
        progressMade = true
        break
      }
    }
    if (!progressMade) {
      // 降级兜底防止死循环
      sorted.push(...remaining)
      break
    }
  }

  return sorted
}

export interface ImportExecuteOptions {
  resume?: boolean
  signal?: AbortSignal
  onProgress?: (progress: ImportProgress) => void
}

/**
 * 执行空间导入全流程
 */
export async function executeSpaceImport(
  entries: Record<string, Uint8Array>,
  preflight: ImportPreflightResult,
  zipSha256: string,
  options: ImportExecuteOptions = {}
): Promise<ImportReport> {
  const { resume = false, signal, onProgress } = options
  const manifest = preflight.manifest
  if (!manifest) {
    throw new Error("Cannot execute import without valid manifest")
  }

  const progress: ImportProgress = {
    stage: "uploading_files",
    completedFiles: 0,
    totalFiles: preflight.fileCounts.total,
    completedPages: 0,
    totalPages: preflight.pageCount
  }

  const updateProgress = (updates: Partial<ImportProgress>) => {
    Object.assign(progress, updates)
    onProgress?.({ ...progress })
  }

  // 1. 初始化或加载检查点
  let checkpoint: ImportCheckpoint | null = null
  if (resume) {
    checkpoint = await getCheckpoint(zipSha256)
  }

  if (!checkpoint) {
    // 重新开始导入：删除旧检查点，永远新建独立空间
    await deleteCheckpoint(zipSha256)

    const createdSpace = await executeWithRetry(
      () =>
        spacesApi.create({
          name: manifest.space.name,
          description: manifest.space.description
        }),
      { signal }
    )

    checkpoint = {
      zipSha256,
      targetSpaceId: createdSpace.id,
      targetSpaceSlug: createdSpace.slug,
      fileMap: {},
      pageMap: {},
      completedPages: {},
      failedFiles: [],
      remappedLinksCount: 0,
      updatedAt: new Date().toISOString()
    }
    await saveCheckpoint(checkpoint)
  }

  const targetSpaceId = checkpoint.targetSpaceId
  const targetSpaceSlug = checkpoint.targetSpaceSlug

  // 2. 传文件：按四类逐个调上传端点，建 originalKey -> 新 key 映射
  updateProgress({ stage: "uploading_files" })

  const filesToUpload = manifest.files.filter((f) => !f.missing)
  progress.completedFiles =
    Object.keys(checkpoint.fileMap).length + checkpoint.failedFiles.length
  updateProgress({})

  for (const file of filesToUpload) {
    if (signal?.aborted) throw new AbortError()

    // 若已成功上传或已被记录为失败，跳过
    if (checkpoint.fileMap[file.originalKey]) continue
    if (checkpoint.failedFiles.some((f) => f.originalKey === file.originalKey))
      continue

    const bytes = entries[file.packagePath]
    if (!bytes) continue

    const filename = file.packagePath.split("/").pop() || "file"
    const blob = new Blob([bytes as BlobPart], { type: file.contentType })
    const formFile = new File([blob], filename, { type: file.contentType })

    try {
      let uploadedKey: string
      if (file.category === "embeds") {
        const res = await executeWithRetry(() => api.uploadEmbed(formFile), {
          signal
        })
        uploadedKey = res.key
      } else {
        const res = await executeWithRetry(() => api.upload(formFile), {
          signal
        })
        uploadedKey = res.key
      }

      checkpoint.fileMap[file.originalKey] = uploadedKey
    } catch (err) {
      if (err instanceof ApiError && err.status === 413) {
        checkpoint.failedFiles.push({
          originalKey: file.originalKey,
          category: file.category,
          reason: "FILE_TOO_LARGE"
        })
      } else {
        throw err
      }
    }

    checkpoint.updatedAt = new Date().toISOString()
    await saveCheckpoint(checkpoint)
    progress.completedFiles++
    updateProgress({})
  }

  // 3. 建骨架：按树序（父先于子）逐页调建页端点，正文给最小空文档
  updateProgress({ stage: "creating_skeleton" })

  const topologicalPages = sortPagesTopologically(manifest.pages)
  const EMPTY_DOC_STR = JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph" }]
  })

  for (const page of topologicalPages) {
    if (signal?.aborted) throw new AbortError()

    if (checkpoint.pageMap[page.exportId]) continue

    const parentId = page.parentExportId
      ? (checkpoint.pageMap[page.parentExportId] ?? null)
      : null

    const created = await executeWithRetry(
      () =>
        pagesApi.create({
          title: page.title,
          parentId,
          spaceId: targetSpaceId,
          contentJson: EMPTY_DOC_STR,
          contentHtml: "",
          contentText: ""
        }),
      { signal }
    )

    checkpoint.pageMap[page.exportId] = created.id
    checkpoint.updatedAt = new Date().toISOString()
    await saveCheckpoint(checkpoint)
  }

  // 4. 填正文（两遍重映射）：逐页对包内 JSON 做结构化引用重写与写回
  updateProgress({ stage: "filling_content" })

  // 建立 oldPageId -> newPageId 映射
  const pageIdMap: Record<number, number> = {}
  for (const page of manifest.pages) {
    const match = /^p-(\d+)$/.exec(page.exportId)
    const oldId = match ? Number(match[1]) : null
    const newId = checkpoint.pageMap[page.exportId]
    if (oldId !== null && newId !== undefined) {
      pageIdMap[oldId] = newId
    }
  }

  const extensions = createExtensions("read")
  progress.completedPages = Object.keys(checkpoint.completedPages).length
  updateProgress({})

  for (const page of manifest.pages) {
    if (signal?.aborted) throw new AbortError()

    if (checkpoint.completedPages[page.exportId]) continue

    const newPageId = checkpoint.pageMap[page.exportId]
    if (!newPageId) continue

    const jsonBytes = entries[page.jsonPath]
    if (!jsonBytes) continue
    const contentJson = fflate.strFromU8(jsonBytes)

    // 重写结构化引用（文件与站内互链）
    const { rewrittenJson, remappedLinksCount } = rewriteContentJson(
      contentJson,
      checkpoint.fileMap,
      pageIdMap
    )
    checkpoint.remappedLinksCount += remappedLinksCount

    let contentHtml = ""
    let contentText = ""
    try {
      const docObj = JSON.parse(rewrittenJson)
      contentHtml = generateHTML(docObj, extensions)
      contentText = generateText(docObj, extensions)
    } catch {
      // 解析失败退回纯文本
    }

    await executeWithRetry(
      () =>
        pagesApi.update(newPageId, {
          title: page.title,
          contentJson: rewrittenJson,
          contentHtml,
          contentText
        }),
      { signal }
    )

    checkpoint.completedPages[page.exportId] = true
    checkpoint.updatedAt = new Date().toISOString()
    await saveCheckpoint(checkpoint)

    progress.completedPages++
    updateProgress({})
  }

  updateProgress({ stage: "done" })

  return {
    targetSpaceId,
    targetSpaceSlug,
    pageCount: manifest.pages.length,
    fileCounts: preflight.fileCounts,
    failedFiles: checkpoint.failedFiles,
    missingFilesCount: preflight.missingFilesCount,
    remappedLinksCount: checkpoint.remappedLinksCount,
    warnings: manifest.warnings || []
  }
}
