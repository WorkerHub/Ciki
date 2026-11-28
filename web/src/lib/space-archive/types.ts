export type ManifestFileCategory = "images" | "embeds" | "canvases" | "files"

export interface ManifestPage {
  exportId: string
  parentExportId: string | null
  title: string
  sortOrder: number
  createdAt: string
  updatedAt: string
  jsonPath: string
  mdPath: string
}

export interface ManifestFile {
  originalKey: string
  packagePath: string
  category: ManifestFileCategory
  contentType: string
  size: number
  missing?: boolean
}

export interface ManifestSpace {
  id: number
  name: string
  slug: string
  description?: string
  createdAt?: string
  updatedAt?: string
  isDefault?: boolean
}

export interface SpaceExportManifest {
  format: "ciki-space-export"
  formatVersion: 1
  exportedAt: string
  instanceVersion: string
  contractVersion: string
  space: ManifestSpace
  pages: ManifestPage[]
  files: ManifestFile[]
  warnings: string[]
}

export interface ExportProgress {
  phase:
    | "estimating"
    | "fetching_pages"
    | "fetching_files"
    | "assembling"
    | "saving"
    | "done"
  totalRequests: number
  estimatedBytes: number
  completedPages: number
  totalPages: number
  completedFiles: number
  totalFiles: number
  warningCount: number
}

export interface ImportFatalError {
  code:
    | "MANIFEST_MISSING"
    | "INVALID_FORMAT"
    | "UNSUPPORTED_VERSION"
    | "PATH_TRAVERSAL"
    | "INVALID_STRUCTURE"
    | "CYCLE_DETECTED"
    | "INVALID_PARENT"
    | "INVALID_PAGE_JSON"
    | "FILE_LIST_MISMATCH"
  message: string
  details?: string
}

export interface ImportPreflightResult {
  valid: boolean
  manifest: SpaceExportManifest | null
  fatalErrors: ImportFatalError[]
  warnings: string[]
  pageCount: number
  fileCounts: {
    images: number
    embeds: number
    canvases: number
    files: number
    total: number
  }
  missingFilesCount: number
  hasCheckpoint?: boolean
  targetSpaceExists?: boolean
  existingSpaceId?: number
}

export interface ImportCheckpoint {
  zipSha256: string
  targetSpaceId: number
  targetSpaceSlug: string
  fileMap: Record<string, string>
  pageMap: Record<string, number>
  completedPages: Record<string, boolean>
  failedFiles: Array<{
    originalKey: string
    category: ManifestFileCategory
    reason: string
  }>
  remappedLinksCount: number
  updatedAt: string
}

export interface ImportProgress {
  stage: "uploading_files" | "creating_skeleton" | "filling_content" | "done"
  completedFiles: number
  totalFiles: number
  completedPages: number
  totalPages: number
}

export interface ImportReport {
  targetSpaceId: number
  targetSpaceSlug: string
  pageCount: number
  fileCounts: {
    images: number
    embeds: number
    canvases: number
    files: number
    total: number
  }
  failedFiles: Array<{
    originalKey: string
    category: ManifestFileCategory
    reason: string
  }>
  missingFilesCount: number
  remappedLinksCount: number
  warnings: string[]
}
