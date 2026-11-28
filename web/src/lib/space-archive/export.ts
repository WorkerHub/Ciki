import * as fflate from "fflate"
import {
  ApiError,
  type PageContentDetail,
  type PageDetail,
  type PageNode,
  type Space,
  pagesApi,
  spacesApi
} from "@/lib/api"
import { saveBlob } from "@/lib/markdown-download"
import {
  type ExtractedFileRef,
  extractReferencedFiles,
  rewriteMarkdownForExport
} from "./content-parser"
import { cleanFilename, generateAllPagePaths, uniquifyFilename } from "./path"
import {
  AbortError,
  executeWithRetry,
  runWithConcurrencyLimit
} from "./scheduler"
import type {
  ExportProgress,
  ManifestFile,
  ManifestPage,
  SpaceExportManifest
} from "./types"

/** 剥离会话端点动态注入的高度上报脚本，还原 embed 原始文件逐字字节 */
export function stripInjectedEmbedScript(html: string): string {
  const SCRIPT_INJECTION_RE =
    /<script>\s*\(function\(\)\s*\{\s*try\s*\{\s*var send = function\(\)[\s\S]*?ciki-embed-height[\s\S]*?<\/script>/i
  return html.replace(SCRIPT_INJECTION_RE, "")
}

export interface ExportOptions {
  signal?: AbortSignal
  onProgress?: (progress: ExportProgress) => void
  /** 优先尝试使用 File System Access API 保存对话框 */
  useFileSystemAccess?: boolean
}

/** 获取公共元数据（实例版本与契约版本） */
export async function fetchPublicMetadata(signal?: AbortSignal): Promise<{
  instanceVersion: string
  contractVersion: string
}> {
  let instanceVersion = "v1.0.0-unknown"
  let contractVersion = "1.0.0"

  try {
    const res = await fetch("/api/public", { signal })
    if (res.ok) {
      const data = (await res.json()) as { version?: string }
      if (data?.version) instanceVersion = data.version
    }
  } catch {
    // 保留兜底
  }

  try {
    const res = await fetch("/api/public/agent-guide", { signal })
    if (res.ok) {
      const text = await res.text()
      const match = />\s*契约版本：([^\s|]+)/.exec(text)
      if (match) contractVersion = match[1]
    }
  } catch {
    // 保留兜底
  }

  return { instanceVersion, contractVersion }
}

/** 展平页面树为节点列表 */
export function flattenPageTree(nodes: PageNode[]): PageNode[] {
  const list: PageNode[] = []
  function walk(items: PageNode[]) {
    for (const item of items) {
      list.push(item)
      if (item.children && item.children.length > 0) {
        walk(item.children)
      }
    }
  }
  walk(nodes)
  return list
}

/**
 * 导出空间完整实现（客户端组装）
 */
export async function exportSpaceArchive(
  spaceId: number,
  options: ExportOptions = {}
): Promise<{
  filename: string
  manifest: SpaceExportManifest
  warningCount: number
}> {
  const { signal, onProgress, useFileSystemAccess = true } = options
  const exportedAt = new Date().toISOString()
  const warnings: string[] = []

  const progress: ExportProgress = {
    phase: "estimating",
    totalRequests: 0,
    estimatedBytes: 0,
    completedPages: 0,
    totalPages: 0,
    completedFiles: 0,
    totalFiles: 0,
    warningCount: 0
  }

  const updateProgress = (updates: Partial<ExportProgress>) => {
    Object.assign(progress, updates)
    progress.warningCount = warnings.length
    onProgress?.({ ...progress })
  }

  updateProgress({ phase: "estimating" })

  // 1. 获取空间详情、版本自证与页面树
  const [space, meta, tree] = await Promise.all([
    executeWithRetry(() => spacesApi.get(spaceId), { signal }),
    fetchPublicMetadata(signal),
    executeWithRetry(() => pagesApi.tree(spaceId), { signal })
  ])

  const allNodes = flattenPageTree(tree)
  const totalPages = allNodes.length
  updateProgress({
    totalPages,
    totalRequests: totalPages * 2
  })

  // 生成页面权威路径映射
  const pathsMap = generateAllPagePaths(tree)

  // 2. 逐页取材：获取 contentJson 与 contentMd
  updateProgress({ phase: "fetching_pages" })

  interface FetchedPageData {
    node: PageNode
    detail: PageDetail
    contentJson: string
    contentMd: string
  }

  const fetchedPages: FetchedPageData[] = []
  const referencedFilesMap = new Map<string, ExtractedFileRef>()

  await runWithConcurrencyLimit(
    allNodes,
    async (node) => {
      try {
        const [editorDetail, detail] = await Promise.all([
          executeWithRetry<PageContentDetail>(
            () => pagesApi.getForEditor(node.id),
            { signal }
          ),
          executeWithRetry<PageDetail>(() => pagesApi.get(node.id), { signal })
        ])

        const contentJson =
          editorDetail.contentJson ||
          JSON.stringify({ type: "doc", content: [] })
        const contentMd = detail.contentMd || ""

        fetchedPages.push({ node, detail, contentJson, contentMd })

        // 解析该页引用的文件
        const refs = extractReferencedFiles(contentJson)
        for (const ref of refs) {
          if (!referencedFilesMap.has(ref.originalKey)) {
            referencedFilesMap.set(ref.originalKey, ref)
          }
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          warnings.push(`页面已不存在，跳过: ID ${node.id} (${node.title})`)
        } else {
          throw err
        }
      } finally {
        updateProgress({
          completedPages: progress.completedPages + 1
        })
      }
    },
    4,
    signal
  )

  const allFilesList = Array.from(referencedFilesMap.values())
  const totalFiles = allFilesList.length
  updateProgress({
    totalFiles,
    totalRequests: totalPages * 2 + totalFiles
  })

  // 为所有附件规划包内唯一路径
  const usedPackagePaths = new Set<string>()
  const manifestFilesMap = new Map<string, ManifestFile>()

  for (const ref of allFilesList) {
    let dir = "files"
    if (ref.category === "images") dir = "images"
    else if (ref.category === "embeds") dir = "embeds"
    else if (ref.category === "canvases") dir = "canvases"

    let filename = ref.originalKey.split("/").pop() || "file"
    if (ref.category === "embeds" && ref.hintName) {
      filename = cleanFilename(ref.hintName, "embed")
      if (!/\.html?$/i.test(filename)) filename = `${filename}.html`
    }

    const packagePath = uniquifyFilename(`${dir}/${filename}`, usedPackagePaths)
    usedPackagePaths.add(packagePath)

    manifestFilesMap.set(ref.originalKey, {
      originalKey: ref.originalKey,
      packagePath,
      category: ref.category,
      contentType: "application/octet-stream",
      size: 0,
      missing: false
    })
  }

  // 页面 exportId -> mdPath 映射
  const pageMdPathMap = new Map<number, string>()
  for (const [id, pathInfo] of pathsMap.entries()) {
    pageMdPathMap.set(id, pathInfo.mdPath)
  }

  // 组装 manifest.pages
  const manifestPages: ManifestPage[] = []
  for (const item of fetchedPages) {
    const pathInfo = pathsMap.get(item.node.id)
    if (!pathInfo) continue
    manifestPages.push({
      exportId: pathInfo.exportId,
      parentExportId: pathInfo.parentExportId,
      title: item.node.title,
      sortOrder: item.node.sortOrder,
      createdAt: item.detail.createdAt || exportedAt,
      updatedAt: item.detail.updatedAt || exportedAt,
      jsonPath: pathInfo.jsonPath,
      mdPath: pathInfo.mdPath
    })
  }

  // 3. 逐个取文件并流式写入 zip
  updateProgress({ phase: "fetching_files" })

  const zipFilename = `${space.slug || `space-${space.id}`}-export.zip`

  // 尝试获取 File System Access API
  let fileHandleWritable: FileSystemWritableFileStream | null = null
  if (
    useFileSystemAccess &&
    typeof window !== "undefined" &&
    "showSaveFilePicker" in window
  ) {
    try {
      const handle = await (
        window as unknown as {
          showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle>
        }
      ).showSaveFilePicker({
        suggestedName: zipFilename,
        types: [
          {
            description: "ZIP Archive",
            accept: { "application/zip": [".zip"] }
          }
        ]
      })
      fileHandleWritable = await handle.createWritable()
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AbortError("User cancelled save dialog")
      }
      // 用户环境不支持或被拒绝，退回 Blob 内存暂存
    }
  }

  const chunks: Uint8Array[] = []
  const zip = new fflate.Zip((err, data, final) => {
    if (err) throw err
    if (fileHandleWritable) {
      void fileHandleWritable.write(data)
    } else {
      chunks.push(data)
    }
  })

  // 3.1 逐个获取附件流式写入 zip
  await runWithConcurrencyLimit(
    allFilesList,
    async (ref) => {
      const manifestFile = manifestFilesMap.get(ref.originalKey)
      if (!manifestFile) return

      try {
        const res = await executeWithRetry(
          async () => {
            const response = await fetch(
              `/api/files/${encodeURIComponent(ref.originalKey)}`,
              {
                signal
              }
            )
            if (response.status === 404) {
              throw new ApiError(404, "File not found", "FILE_NOT_FOUND")
            }
            if (!response.ok) {
              throw new ApiError(response.status, response.statusText)
            }
            return response
          },
          { signal }
        )

        const buffer = await res.arrayBuffer()
        let bytes = new Uint8Array(buffer)
        if (ref.category === "embeds") {
          const rawHtml = fflate.strFromU8(bytes)
          const cleanedHtml = stripInjectedEmbedScript(rawHtml)
          bytes = fflate.strToU8(cleanedHtml)
        }
        manifestFile.size = bytes.length
        manifestFile.contentType =
          res.headers.get("content-type") || "application/octet-stream"

        // 写入 zip
        const fileEntry = new fflate.ZipPassThrough(manifestFile.packagePath)
        zip.add(fileEntry)
        fileEntry.push(bytes, true)

        updateProgress({
          estimatedBytes: progress.estimatedBytes + bytes.length
        })
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          manifestFile.missing = true
          warnings.push(`附件缺失 (404): ${ref.originalKey}`)
        } else {
          throw err
        }
      } finally {
        updateProgress({
          completedFiles: progress.completedFiles + 1
        })
      }
    },
    4,
    signal
  )

  // 4. 组装 pages 双轨与 manifest.json 入包
  updateProgress({ phase: "assembling" })

  for (const page of fetchedPages) {
    const pathInfo = pathsMap.get(page.node.id)
    if (!pathInfo) continue

    // JSON 轨：原样逐字入包
    const jsonBytes = fflate.strToU8(page.contentJson)
    const jsonEntry = new fflate.ZipPassThrough(pathInfo.jsonPath)
    zip.add(jsonEntry)
    jsonEntry.push(jsonBytes, true)

    // MD 轨：三类相对化改写 + 一级标题
    const rewrittenMd = rewriteMarkdownForExport(
      page.node.title,
      page.contentMd,
      pathInfo.mdPath,
      manifestFilesMap,
      pageMdPathMap
    )
    const mdBytes = fflate.strToU8(rewrittenMd)
    const mdEntry = new fflate.ZipPassThrough(pathInfo.mdPath)
    zip.add(mdEntry)
    mdEntry.push(mdBytes, true)
  }

  // 组装最终 manifest
  const finalManifest: SpaceExportManifest = {
    format: "ciki-space-export",
    formatVersion: 1,
    exportedAt,
    instanceVersion: meta.instanceVersion,
    contractVersion: meta.contractVersion,
    space: {
      id: space.id,
      name: space.name,
      slug: space.slug,
      description: space.description || "",
      createdAt: space.createdAt,
      updatedAt: space.updatedAt,
      isDefault: space.isDefault
    },
    pages: manifestPages,
    files: Array.from(manifestFilesMap.values()),
    warnings
  }

  const manifestBytes = fflate.strToU8(JSON.stringify(finalManifest, null, 2))
  const manifestEntry = new fflate.ZipPassThrough("manifest.json")
  zip.add(manifestEntry)
  manifestEntry.push(manifestBytes, true)

  // 5. 封包落盘
  updateProgress({ phase: "saving" })
  zip.end()

  if (fileHandleWritable) {
    await fileHandleWritable.close()
  } else {
    const blob = new Blob(chunks as BlobPart[], { type: "application/zip" })
    saveBlob(blob, zipFilename)
  }

  updateProgress({ phase: "done" })
  return {
    filename: zipFilename,
    manifest: finalManifest,
    warningCount: warnings.length
  }
}
