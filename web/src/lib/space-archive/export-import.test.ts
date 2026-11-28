import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fflate from "fflate"
import { ApiError, pagesApi, spacesApi, api, type PageNode } from "@/lib/api"
import {
  decompressZip,
  executeSpaceImport,
  preflightSpaceArchive
} from "./import"
import { exportSpaceArchive, stripInjectedEmbedScript } from "./export"
import { deleteCheckpoint, getCheckpoint, saveCheckpoint } from "./checkpoint"
import {
  EMBED_KEY_RE,
  UPLOAD_KEY_RE,
  extractReferencedFiles,
  parseFileKeyFromUrl,
  rewriteContentJson,
  rewriteMarkdownForExport
} from "./content-parser"
import { generateAllPagePaths, relativePosixPath } from "./path"
import type { ManifestFile } from "./types"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    spacesApi: {
      ...actual.spacesApi,
      get: vi.fn(),
      create: vi.fn()
    },
    pagesApi: {
      ...actual.pagesApi,
      tree: vi.fn(),
      get: vi.fn(),
      getForEditor: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    api: {
      ...actual.api,
      upload: vi.fn(),
      uploadEmbed: vi.fn()
    }
  }
})

// Mock Markdown Download (saveBlob)
let capturedSavedBlob: Blob | null = null
vi.mock("@/lib/markdown-download", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/markdown-download")>()
  return {
    ...actual,
    saveBlob: vi.fn((blob: Blob) => {
      capturedSavedBlob = blob
    })
  }
})

// Mock IndexedDB
const mockIdbStore = new Map<string, any>()
vi.mock("./checkpoint", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./checkpoint")>()
  return {
    ...actual,
    saveCheckpoint: vi.fn(async (cp) => {
      mockIdbStore.set(cp.zipSha256, JSON.parse(JSON.stringify(cp)))
    }),
    getCheckpoint: vi.fn(async (key) => {
      return mockIdbStore.get(key) || null
    }),
    deleteCheckpoint: vi.fn(async (key) => {
      mockIdbStore.delete(key)
    })
  }
})

describe("空间导出/导入核心引擎", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIdbStore.clear()
    capturedSavedBlob = null
  })

  describe("路径与改写工具", () => {
    it("计算正确的相对 POSIX 路径", () => {
      expect(relativePosixPath("pages/0-home.md", "images/pic.png")).toBe(
        "../images/pic.png"
      )
      expect(
        relativePosixPath("pages/0-intro/0-guide.md", "images/pic.png")
      ).toBe("../../images/pic.png")
      expect(
        relativePosixPath("pages/0-intro/0-guide.md", "pages/0-home.md")
      ).toBe("../0-home.md")
      expect(
        relativePosixPath("pages/0-intro/0-guide.md", "pages/0-intro/1-next.md")
      ).toBe("1-next.md")
    })

    it("校验与解析站内文件 key，拦截非法形状与站外外链", () => {
      // 合法 UPLOAD_KEY 形状
      expect(
        parseFileKeyFromUrl(
          "/api/files/pages/11111111-1111-1111-1111-111111111111.png"
        )
      ).toBe("pages/11111111-1111-1111-1111-111111111111.png")
      expect(
        parseFileKeyFromUrl(
          "https://my.domain.com/api/files/imports/22222222-2222-2222-2222-222222222222.jpg"
        )
      ).toBe("imports/22222222-2222-2222-2222-222222222222.jpg")
      expect(
        parseFileKeyFromUrl("pages/33333333-3333-3333-3333-333333333333.json")
      ).toBe("pages/33333333-3333-3333-3333-333333333333.json")
      // 合法 EMBED_KEY 形状
      expect(
        parseFileKeyFromUrl(
          "/api/files/embeds/44444444-4444-4444-4444-444444444444.html"
        )
      ).toBe("embeds/44444444-4444-4444-4444-444444444444.html")
      // 非法形状拦截（非 UUID、未被允许的扩展名、路径穿越等）
      expect(parseFileKeyFromUrl("/api/files/pages/pic.png")).toBeNull()
      expect(
        parseFileKeyFromUrl("https://cdn.example.com/api/files/logo.png")
      ).toBeNull()
      expect(parseFileKeyFromUrl("/api/files/../../evil.sh")).toBeNull()
      expect(parseFileKeyFromUrl("")).toBeNull()
    })

    it("从 TipTap JSON 提取四类文件引用", () => {
      const sampleDoc = {
        type: "doc",
        content: [
          {
            type: "image",
            attrs: {
              src: "/api/files/pages/11111111-1111-1111-1111-111111111111.png"
            }
          },
          {
            type: "image",
            attrs: {
              originalSrc:
                "/api/files/imports/22222222-2222-2222-2222-222222222222.jpg"
            }
          },
          {
            type: "excalidraw",
            attrs: {
              sceneKey: "pages/33333333-3333-3333-3333-333333333333.json",
              previewKey: "pages/44444444-4444-4444-4444-444444444444.png"
            }
          },
          {
            type: "htmlEmbed",
            attrs: {
              key: "embeds/55555555-5555-5555-5555-555555555555.html",
              name: "业务图表.html"
            }
          }
        ]
      }
      const refs = extractReferencedFiles(JSON.stringify(sampleDoc))
      expect(refs).toHaveLength(5)
      expect(refs.map((r) => r.category)).toEqual([
        "images",
        "images",
        "canvases",
        "canvases",
        "embeds"
      ])
    })

    it("重写 TipTap JSON 中的文件 key 与站内页面链接", () => {
      const sampleDoc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "点击跳转",
                marks: [{ type: "link", attrs: { href: "/p/101" } }]
              },
              {
                type: "text",
                text: "外链",
                marks: [
                  { type: "link", attrs: { href: "https://example.com" } }
                ]
              }
            ]
          },
          {
            type: "image",
            attrs: {
              src: "/api/files/pages/11111111-1111-1111-1111-111111111111.png"
            }
          },
          {
            type: "excalidraw",
            attrs: {
              sceneKey: "pages/22222222-2222-2222-2222-222222222222.json",
              previewKey: "pages/33333333-3333-3333-3333-333333333333.png"
            }
          },
          {
            type: "htmlEmbed",
            attrs: {
              key: "embeds/44444444-4444-4444-4444-444444444444.html",
              name: "嵌入.html"
            }
          }
        ]
      }

      const fileKeyMap = {
        "pages/11111111-1111-1111-1111-111111111111.png":
          "pages/99999999-9999-9999-9999-999999999999.png",
        "pages/22222222-2222-2222-2222-222222222222.json":
          "pages/88888888-8888-8888-8888-888888888888.json",
        "pages/33333333-3333-3333-3333-333333333333.png":
          "pages/77777777-7777-7777-7777-777777777777.png",
        "embeds/44444444-4444-4444-4444-444444444444.html":
          "embeds/66666666-6666-6666-6666-666666666666.html"
      }
      const pageIdMap = { 101: 202 }

      const { rewrittenJson, remappedLinksCount } = rewriteContentJson(
        JSON.stringify(sampleDoc),
        fileKeyMap,
        pageIdMap
      )

      expect(remappedLinksCount).toBe(1)
      const parsed = JSON.parse(rewrittenJson)
      expect(parsed.content[0].content[0].marks[0].attrs.href).toBe("/p/202")
      expect(parsed.content[0].content[1].marks[0].attrs.href).toBe(
        "https://example.com"
      )
      expect(parsed.content[1].attrs.src).toBe(
        "/api/files/pages/99999999-9999-9999-9999-999999999999.png"
      )
      expect(parsed.content[2].attrs.sceneKey).toBe(
        "pages/88888888-8888-8888-8888-888888888888.json"
      )
      expect(parsed.content[2].attrs.previewKey).toBe(
        "pages/77777777-7777-7777-7777-777777777777.png"
      )
      expect(parsed.content[3].attrs.key).toBe(
        "embeds/66666666-6666-6666-6666-666666666666.html"
      )
    })

    it("正确剥离动态注入的 embed 高度上报脚本，还原原始逐字 HTML", () => {
      const rawHtml = `<!DOCTYPE html><html><head></head><body><h1>动画标题</h1></body></html>`
      const injectedScript = `<script>(function() { try { var send = function() { var h = document.documentElement.scrollHeight; window.parent.postMessage({ type: 'ciki-embed-height', height: h }, '*'); }; send(); } catch(e){} })();</script>`
      const deliveredHtml = `${rawHtml}${injectedScript}`
      expect(stripInjectedEmbedScript(deliveredHtml)).toBe(rawHtml)
    })

    it("Markdown 相对化改写：图片、Embed 与站内链接", () => {
      const contentMd = `
这里有一张图 ![测试图](/api/files/pages/img-1.png)
这里有一个动画 [HTML 动画：图表](/api/files/embeds/anim.html)
这里有一个内部页面链接 [架构总览](/p/101)
这里有一个外链 [外部文档](https://external.com)
`
      const fileManifestMap = new Map<string, ManifestFile>([
        [
          "pages/img-1.png",
          {
            originalKey: "pages/img-1.png",
            packagePath: "images/img-1.png",
            category: "images",
            contentType: "image/png",
            size: 100
          }
        ],
        [
          "embeds/anim.html",
          {
            originalKey: "embeds/anim.html",
            packagePath: "embeds/anim.html",
            category: "embeds",
            contentType: "text/html",
            size: 200
          }
        ]
      ])
      const pageMdPathMap = new Map<number, string>([[101, "pages/0-arch.md"]])

      const rewritten = rewriteMarkdownForExport(
        "当前子页",
        contentMd,
        "pages/1-guide/0-sub.md",
        fileManifestMap,
        pageMdPathMap
      )

      expect(rewritten.startsWith("# 当前子页\n\n")).toBe(true)
      expect(rewritten).toContain("![测试图](../../images/img-1.png)")
      expect(rewritten).toContain("[HTML 动画：图表](../../embeds/anim.html)")
      expect(rewritten).toContain("[架构总览](../0-arch.md)")
      expect(rewritten).toContain("[外部文档](https://external.com)")
    })
  })

  describe("本地预检与坏包防御（零服务端写入）", () => {
    function createTestZip(
      entries: Record<string, string | Uint8Array>
    ): Uint8Array {
      const zipEntries: Record<string, Uint8Array> = {}
      for (const [k, v] of Object.entries(entries)) {
        zipEntries[k] = typeof v === "string" ? fflate.strToU8(v) : v
      }
      return fflate.zipSync(zipEntries)
    }

    it("拒绝 manifest.json 缺失的包", async () => {
      const zip = createTestZip({ "pages/0.json": "{}" })
      const entries = await decompressZip(zip)
      const result = await preflightSpaceArchive(entries, "hash1")
      expect(result.valid).toBe(false)
      expect(
        result.fatalErrors.some((e) => e.code === "MANIFEST_MISSING")
      ).toBe(true)
      expect(spacesApi.create).not.toHaveBeenCalled()
    })

    it("拒绝 format 不符或 formatVersion 不受支持的包", async () => {
      const badFormat = createTestZip({
        "manifest.json": JSON.stringify({
          format: "other-format",
          formatVersion: 1
        })
      })
      const entries1 = await decompressZip(badFormat)
      const res1 = await preflightSpaceArchive(entries1, "hash2")
      expect(res1.valid).toBe(false)
      expect(res1.fatalErrors.some((e) => e.code === "INVALID_FORMAT")).toBe(
        true
      )

      const badVer = createTestZip({
        "manifest.json": JSON.stringify({
          format: "ciki-space-export",
          formatVersion: 99
        })
      })
      const entries2 = await decompressZip(badVer)
      const res2 = await preflightSpaceArchive(entries2, "hash3")
      expect(res2.valid).toBe(false)
      expect(
        res2.fatalErrors.some((e) => e.code === "UNSUPPORTED_VERSION")
      ).toBe(true)
    })

    it("拒绝包含路径穿越与绝对路径条目的包", async () => {
      const traversalZip = createTestZip({
        "manifest.json": JSON.stringify({
          format: "ciki-space-export",
          formatVersion: 1,
          pages: [],
          files: []
        }),
        "../evil.sh": "echo 1"
      })
      const entries = await decompressZip(traversalZip)
      const result = await preflightSpaceArchive(entries, "hash4")
      expect(result.valid).toBe(false)
      expect(result.fatalErrors.some((e) => e.code === "PATH_TRAVERSAL")).toBe(
        true
      )
    })

    it("拒绝顶层结构不在白名单内的包", async () => {
      const invalidStructureZip = createTestZip({
        "manifest.json": JSON.stringify({
          format: "ciki-space-export",
          formatVersion: 1,
          pages: [],
          files: []
        }),
        "secret/passwords.txt": "123456"
      })
      const entries = await decompressZip(invalidStructureZip)
      const result = await preflightSpaceArchive(entries, "hash5")
      expect(result.valid).toBe(false)
      expect(
        result.fatalErrors.some((e) => e.code === "INVALID_STRUCTURE")
      ).toBe(true)
    })

    it("允许文件名中包含 `..` 的合法页面条目通过预检（不误判为路径穿越）", async () => {
      const validZip = createTestZip({
        "manifest.json": JSON.stringify({
          format: "ciki-space-export",
          formatVersion: 1,
          pages: [
            {
              exportId: "p-1",
              parentExportId: null,
              title: "版本 1..2 发布说明",
              sortOrder: 0,
              createdAt: "2026-11-28",
              updatedAt: "2026-11-28",
              jsonPath: "pages/0-版本 1..2-abc.json",
              mdPath: "pages/0-版本 1..2-abc.md"
            }
          ],
          files: []
        }),
        "pages/0-版本 1..2-abc.json": JSON.stringify({
          type: "doc",
          content: []
        }),
        "pages/0-版本 1..2-abc.md": "# 版本 1..2 发布说明"
      })
      const entries = await decompressZip(validZip)
      const result = await preflightSpaceArchive(entries, "hash_valid_dots")
      expect(result.valid).toBe(true)
      expect(result.fatalErrors.some((e) => e.code === "PATH_TRAVERSAL")).toBe(
        false
      )
    })

    it("拒绝页面 JSON 损坏或页面树成环的包", async () => {
      const corruptJsonZip = createTestZip({
        "manifest.json": JSON.stringify({
          format: "ciki-space-export",
          formatVersion: 1,
          pages: [
            {
              exportId: "p-1",
              parentExportId: null,
              title: "页1",
              sortOrder: 0,
              jsonPath: "pages/0.json",
              mdPath: "pages/0.md"
            }
          ],
          files: []
        }),
        "pages/0.json": "{ broken json ...",
        "pages/0.md": "# 页1"
      })
      const entries1 = await decompressZip(corruptJsonZip)
      const res1 = await preflightSpaceArchive(entries1, "hash6")
      expect(res1.valid).toBe(false)
      expect(res1.fatalErrors.some((e) => e.code === "INVALID_PAGE_JSON")).toBe(
        true
      )

      const cycleZip = createTestZip({
        "manifest.json": JSON.stringify({
          format: "ciki-space-export",
          formatVersion: 1,
          pages: [
            {
              exportId: "p-1",
              parentExportId: "p-2",
              title: "页1",
              sortOrder: 0,
              jsonPath: "pages/1.json",
              mdPath: "pages/1.md"
            },
            {
              exportId: "p-2",
              parentExportId: "p-1",
              title: "页2",
              sortOrder: 0,
              jsonPath: "pages/2.json",
              mdPath: "pages/2.md"
            }
          ],
          files: []
        }),
        "pages/1.json": "{}",
        "pages/1.md": "",
        "pages/2.json": "{}",
        "pages/2.md": ""
      })
      const entries2 = await decompressZip(cycleZip)
      const res2 = await preflightSpaceArchive(entries2, "hash7")
      expect(res2.valid).toBe(false)
      expect(res2.fatalErrors.some((e) => e.code === "CYCLE_DETECTED")).toBe(
        true
      )
    })
  })

  describe("完整导入流程与检查点续跑", () => {
    const sampleManifest = {
      format: "ciki-space-export",
      formatVersion: 1,
      exportedAt: "2026-11-28T09:00:00.000Z",
      instanceVersion: "v1.0.0",
      contractVersion: "1.0.0",
      space: { id: 1, name: "源空间", slug: "src-space" },
      pages: [
        {
          exportId: "p-1",
          parentExportId: null,
          title: "根页面",
          sortOrder: 0,
          jsonPath: "pages/0-root.json",
          mdPath: "pages/0-root.md"
        },
        {
          exportId: "p-2",
          parentExportId: "p-1",
          title: "子页面",
          sortOrder: 0,
          jsonPath: "pages/0-root/0-child.json",
          mdPath: "pages/0-root/0-child.md"
        }
      ],
      files: [
        {
          originalKey: "pages/11111111-1111-1111-1111-111111111111.png",
          packagePath: "images/img-1.png",
          category: "images",
          contentType: "image/png",
          size: 100
        }
      ],
      warnings: ["源空间警告样例"]
    }

    const sampleRootJson = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "看子页",
              marks: [{ type: "link", attrs: { href: "/p/2" } }]
            }
          ]
        },
        {
          type: "image",
          attrs: {
            src: "/api/files/pages/11111111-1111-1111-1111-111111111111.png"
          }
        }
      ]
    })

    const sampleChildJson = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "子页内容" }]
        }
      ]
    })

    it("正常导入：新建独立空间、上传文件、建骨架、填正文并输出报告", async () => {
      vi.mocked(spacesApi.create).mockResolvedValue({
        id: 88,
        name: "源空间",
        slug: "src-space-imported",
        description: "",
        myRole: "admin",
        isDefault: false,
        createdAt: "2026-11-28",
        updatedAt: "2026-11-28"
      })

      vi.mocked(api.upload).mockResolvedValue({
        key: "pages/22222222-2222-2222-2222-222222222222.png",
        url: "/api/files/pages/22222222-2222-2222-2222-222222222222.png",
        contentType: "image/png",
        size: 100
      })

      let createdPageId = 100
      vi.mocked(pagesApi.create).mockImplementation(async (input) => ({
        id: ++createdPageId,
        spaceId: input.spaceId || 88,
        parentId: input.parentId,
        title: input.title,
        sortOrder: 0,
        contentHash: "hash",
        contentHtml: "",
        contentText: "",
        contentMd: "",
        createdBy: 1,
        createdById: 1,
        createdByName: "admin",
        createdByAvatarUrl: "",
        createdByIsAgent: false,
        createdByOwnerName: null,
        updatedBy: 1,
        updatedById: 1,
        updatedByName: "admin",
        updatedByAvatarUrl: "",
        updatedByIsAgent: false,
        updatedByOwnerName: null,
        createdAt: "2026-11-28",
        updatedAt: "2026-11-28"
      }))

      vi.mocked(pagesApi.update).mockResolvedValue({} as any)

      const entries: Record<string, Uint8Array> = {
        "manifest.json": fflate.strToU8(JSON.stringify(sampleManifest)),
        "pages/0-root.json": fflate.strToU8(sampleRootJson),
        "pages/0-root.md": fflate.strToU8("# 根页面"),
        "pages/0-root/0-child.json": fflate.strToU8(sampleChildJson),
        "pages/0-root/0-child.md": fflate.strToU8("# 子页面"),
        "images/img-1.png": new Uint8Array([1, 2, 3, 4])
      }

      const preflight = await preflightSpaceArchive(entries, "valid_zip_sha")
      expect(preflight.valid).toBe(true)

      const report = await executeSpaceImport(
        entries,
        preflight,
        "valid_zip_sha"
      )

      expect(report.targetSpaceId).toBe(88)
      expect(report.targetSpaceSlug).toBe("src-space-imported")
      expect(report.pageCount).toBe(2)
      expect(report.fileCounts.images).toBe(1)
      expect(report.failedFiles).toHaveLength(0)
      expect(report.warnings).toEqual(["源空间警告样例"])

      // 验证 spacesApi.create 未硬编码 slug
      expect(spacesApi.create).toHaveBeenCalledWith({
        name: "源空间",
        description: undefined
      })

      // 验证骨架创建：父页面先于子页面
      expect(pagesApi.create).toHaveBeenCalledTimes(2)
      expect(pagesApi.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ title: "根页面", parentId: null })
      )
      expect(pagesApi.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ title: "子页面", parentId: 101 })
      )

      // 验证正文重写：图片替换为新 key，子页链接替换为新 id 102
      expect(pagesApi.update).toHaveBeenCalledTimes(2)
      const rootUpdateCall = vi.mocked(pagesApi.update).mock.calls[0]
      const parsedRoot = JSON.parse(rootUpdateCall[1].contentJson as string)
      expect(parsedRoot.content[0].content[0].marks[0].attrs.href).toBe(
        "/p/102"
      )
      expect(parsedRoot.content[1].attrs.src).toBe(
        "/api/files/pages/22222222-2222-2222-2222-222222222222.png"
      )
    })

    it("中断续跑：利用检查点跳过已完成项，修完最终空间", async () => {
      // 先在 store 中存入一个执行到一半的检查点
      mockIdbStore.set("resume_sha", {
        zipSha256: "resume_sha",
        targetSpaceId: 99,
        targetSpaceSlug: "resumed-space",
        fileMap: {
          "pages/11111111-1111-1111-1111-111111111111.png":
            "pages/22222222-2222-2222-2222-222222222222.png"
        },
        pageMap: { "p-1": 201, "p-2": 202 },
        completedPages: { "p-1": true }, // 根页面已完成，子页面待填正文
        failedFiles: [],
        remappedLinksCount: 1,
        updatedAt: "2026-11-28"
      })

      vi.mocked(pagesApi.tree).mockResolvedValue([])
      vi.mocked(pagesApi.update).mockResolvedValue({} as any)

      const entries: Record<string, Uint8Array> = {
        "manifest.json": fflate.strToU8(JSON.stringify(sampleManifest)),
        "pages/0-root.json": fflate.strToU8(sampleRootJson),
        "pages/0-root.md": fflate.strToU8("# 根页面"),
        "pages/0-root/0-child.json": fflate.strToU8(sampleChildJson),
        "pages/0-root/0-child.md": fflate.strToU8("# 子页面"),
        "images/img-1.png": new Uint8Array([1, 2, 3, 4])
      }

      const preflight = await preflightSpaceArchive(entries, "resume_sha")
      expect(preflight.hasCheckpoint).toBe(true)
      expect(preflight.existingSpaceId).toBe(99)

      const report = await executeSpaceImport(
        entries,
        preflight,
        "resume_sha",
        {
          resume: true
        }
      )

      // 验证：不会再次新建空间，不会再次上传已传图片，不会再次建骨架，只填未完成的子页面正文
      expect(spacesApi.create).not.toHaveBeenCalled()
      expect(api.upload).not.toHaveBeenCalled()
      expect(pagesApi.create).not.toHaveBeenCalled()
      expect(pagesApi.update).toHaveBeenCalledTimes(1) // 只有第 2 页调用了 update
      expect(report.targetSpaceId).toBe(99)
    })

    it("413 文件过大记录失败清单并正常完成导入", async () => {
      vi.mocked(spacesApi.create).mockResolvedValue({
        id: 111,
        name: "源空间",
        slug: "large-file-space",
        description: "",
        myRole: "admin",
        isDefault: false,
        createdAt: "2026-11-28",
        updatedAt: "2026-11-28"
      })

      // 模拟 413 上限拦截
      vi.mocked(api.upload).mockRejectedValue(
        new ApiError(413, "File too large", "FILE_TOO_LARGE")
      )
      vi.mocked(pagesApi.create).mockResolvedValue({ id: 301 } as any)
      vi.mocked(pagesApi.update).mockResolvedValue({} as any)

      const entries: Record<string, Uint8Array> = {
        "manifest.json": fflate.strToU8(JSON.stringify(sampleManifest)),
        "pages/0-root.json": fflate.strToU8(sampleRootJson),
        "pages/0-root.md": fflate.strToU8("# 根页面"),
        "pages/0-root/0-child.json": fflate.strToU8(sampleChildJson),
        "pages/0-root/0-child.md": fflate.strToU8("# 子页面"),
        "images/img-1.png": new Uint8Array([1, 2, 3, 4])
      }

      const preflight = await preflightSpaceArchive(entries, "large_file_sha")
      const report = await executeSpaceImport(
        entries,
        preflight,
        "large_file_sha"
      )

      expect(report.failedFiles).toHaveLength(1)
      expect(report.failedFiles[0].originalKey).toBe(
        "pages/11111111-1111-1111-1111-111111111111.png"
      )
      expect(report.failedFiles[0].reason).toBe("FILE_TOO_LARGE")
    })
  })

  describe("往返保真完整闭环实测（验收 1）", () => {
    it("三级页面树、站内互链、四类附件、复杂表格与代码块导出后导入，语义逐字保真", async () => {
      const sourceSpace = {
        id: 10,
        name: "测试夹具空间",
        slug: "fixture-space",
        description: "往返测试",
        myRole: "admin",
        isDefault: false,
        createdAt: "2026-11-28",
        updatedAt: "2026-11-28"
      }

      // 三级页面树：L1 -> L2 -> L3
      const tree: PageNode[] = [
        {
          id: 1,
          parentId: null,
          title: "顶级页面",
          sortOrder: 0,
          updatedAt: "2026-11-28",
          children: [
            {
              id: 2,
              parentId: 1,
              title: "二级页面",
              sortOrder: 0,
              updatedAt: "2026-11-28",
              children: [
                {
                  id: 3,
                  parentId: 2,
                  title: "三级页面",
                  sortOrder: 0,
                  updatedAt: "2026-11-28",
                  children: []
                }
              ]
            }
          ]
        }
      ]

      const page1Json = JSON.stringify({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "跳到三级页",
                marks: [{ type: "link", attrs: { href: "/p/3" } }]
              }
            ]
          },
          {
            type: "image",
            attrs: {
              src: "/api/files/pages/11111111-1111-1111-1111-111111111111.png",
              width: 300
            }
          },
          {
            type: "image",
            attrs: {
              src: "/api/files/imports/22222222-2222-2222-2222-222222222222.png"
            }
          },
          {
            type: "excalidraw",
            attrs: {
              sceneKey: "pages/33333333-3333-3333-3333-333333333333.json",
              previewKey: "pages/44444444-4444-4444-4444-444444444444.png"
            }
          },
          {
            type: "htmlEmbed",
            attrs: {
              key: "embeds/55555555-5555-5555-5555-555555555555.html",
              name: "动画演示.html"
            }
          }
        ]
      })

      const page2Json = JSON.stringify({
        type: "doc",
        content: [
          {
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableHeader",
                    attrs: { colspan: 2 },
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: "合并表头" }]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      })

      const page3Json = JSON.stringify({
        type: "doc",
        content: [
          {
            type: "codeBlock",
            attrs: { language: "typescript" },
            content: [{ type: "text", text: "const x = 1;" }]
          }
        ]
      })

      vi.mocked(spacesApi.get).mockResolvedValue(sourceSpace as any)
      vi.mocked(pagesApi.tree).mockResolvedValue(tree)
      vi.mocked(pagesApi.getForEditor).mockImplementation(async (id) => {
        if (id === 1) return { contentJson: page1Json } as any
        if (id === 2) return { contentJson: page2Json } as any
        return { contentJson: page3Json } as any
      })
      vi.mocked(pagesApi.get).mockImplementation(async (id) => {
        return {
          id,
          title: `页面 ${id}`,
          contentMd: `页面 ${id} 正文`,
          createdAt: "2026-11-28T10:00:00.000Z",
          updatedAt: "2026-11-28T12:00:00.000Z"
        } as any
      })

      const originalFetch = global.fetch
      global.fetch = vi.fn(async (input: any) => {
        const url = String(input)
        if (url.includes("/api/public/agent-guide")) {
          return new Response(
            "> 契约版本：1.0.0 | 构建版本：v1.0.0\n# Agent 指引"
          )
        }
        if (url.includes("/api/public")) {
          return new Response(JSON.stringify({ version: "v1.0.0-test" }))
        }
        if (url.includes("55555555-5555-5555-5555-555555555555.html")) {
          const rawHtml = `<div>动画演示</div>`
          const injectedScript = `<script>(function() { try { var send = function() { window.parent.postMessage({ type: 'ciki-embed-height', height: 100 }, '*'); }; send(); } catch(e){} })();</script>`
          return new Response(rawHtml + injectedScript, {
            headers: { "content-type": "text/html" }
          })
        }
        if (url.includes("/api/files/")) {
          return new Response(new Uint8Array([10, 20, 30]), {
            headers: { "content-type": "application/octet-stream" }
          })
        }
        return originalFetch(input)
      }) as any

      const exportResult = await exportSpaceArchive(10, {
        useFileSystemAccess: false
      })
      expect(exportResult.manifest.pages).toHaveLength(3)
      expect(exportResult.manifest.files).toHaveLength(5)
      expect(exportResult.filename).toBe("fixture-space-export.zip")

      // 验证 saveBlob 拦截到打包好的二进制文件
      expect(capturedSavedBlob).not.toBeNull()
      const arrayBuffer = await capturedSavedBlob!.arrayBuffer()
      const zipBytes = new Uint8Array(arrayBuffer)

      // 解压导出的真实 zip 数据
      const entries = await decompressZip(zipBytes)

      // 验证 embed html 文件在包内已剥离高度注入脚本
      const embedZipKey = Object.keys(entries).find((k) =>
        k.startsWith("embeds/")
      )
      expect(embedZipKey).toBeDefined()
      expect(fflate.strFromU8(entries[embedZipKey!])).toBe(
        "<div>动画演示</div>"
      )

      // 验证 manifest 包含真实 createdAt
      const manifestInZip = JSON.parse(
        fflate.strFromU8(entries["manifest.json"])
      )
      expect(manifestInZip.pages[0].createdAt).toBe("2026-11-28T10:00:00.000Z")

      // 导入预检
      const preflight = await preflightSpaceArchive(entries, "roundtrip-sha")
      expect(preflight.valid).toBe(true)
      expect(preflight.fatalErrors).toHaveLength(0)
      expect(preflight.manifest!.pages).toHaveLength(3)
      expect(preflight.manifest!.files).toHaveLength(5)

      // Mock 导入端点
      vi.mocked(spacesApi.create).mockResolvedValue({
        id: 99,
        name: "测试夹具空间",
        slug: "fixture-space-imported",
        description: "往返测试",
        isDefault: false,
        createdAt: "2026-11-28",
        updatedAt: "2026-11-28"
      } as any)

      let uploadSeq = 0
      vi.mocked(api.upload).mockImplementation(async (file: File) => {
        uploadSeq++
        const ext = file.name.split(".").pop() || "bin"
        const newKey = `pages/uploaded-${uploadSeq}.${ext}`
        return {
          key: newKey,
          url: `/api/files/${newKey}`,
          contentType: file.type,
          size: file.size
        } as any
      })

      vi.mocked(api.uploadEmbed).mockImplementation(async (file: File) => {
        return {
          key: "embeds/uploaded-embed.html",
          name: file.name,
          contentType: "text/html",
          size: file.size
        } as any
      })

      let pageIdCounter = 100
      const createdPages: Array<{
        id: number
        title: string
        parentId: number | null
        sortOrder: number
      }> = []

      vi.mocked(pagesApi.create).mockImplementation(async (data: any) => {
        pageIdCounter++
        const newPage = {
          id: pageIdCounter,
          title: data.title,
          parentId: data.parentId ?? null,
          sortOrder: data.sortOrder ?? 0
        }
        createdPages.push(newPage)
        return newPage as any
      })

      const updatedPages = new Map<number, any>()
      vi.mocked(pagesApi.update).mockImplementation(async (pageId, data) => {
        updatedPages.set(pageId, data)
        return { id: pageId, ...data } as any
      })

      // 执行导入
      const report = await executeSpaceImport(
        entries,
        preflight,
        "roundtrip-sha"
      )

      expect(report.targetSpaceId).toBe(99)
      expect(report.pageCount).toBe(3)
      expect(report.failedFiles).toHaveLength(0)
      expect(report.remappedLinksCount).toBe(1)

      // 断言三级骨架父子关系与顺序完全一致
      expect(createdPages).toHaveLength(3)
      expect(createdPages[0]).toEqual({
        id: 101,
        title: "顶级页面",
        parentId: null,
        sortOrder: 0
      })
      expect(createdPages[1]).toEqual({
        id: 102,
        title: "二级页面",
        parentId: 101,
        sortOrder: 0
      })
      expect(createdPages[2]).toEqual({
        id: 103,
        title: "三级页面",
        parentId: 102,
        sortOrder: 0
      })

      // 断言正文更新与结构化重映射（保真度）
      // 1. 顶级页面（包含站内链接到三级页、图片、Excalidraw 画布、HTML Embed）
      const page1Update = updatedPages.get(101)
      expect(page1Update).toBeDefined()
      const page1Parsed = JSON.parse(page1Update.contentJson)
      // 站内链接 /p/3 重映射为新创建的三级页面 ID /p/103
      expect(page1Parsed.content[0].content[0].marks[0].attrs.href).toBe(
        "/p/103"
      )
      // 图片 key 重映射到新上传 key
      expect(page1Parsed.content[1].attrs.src).toMatch(
        /^\/api\/files\/pages\/uploaded-/
      )
      expect(page1Parsed.content[2].attrs.src).toMatch(
        /^\/api\/files\/pages\/uploaded-/
      )
      // 画布 sceneKey 与 previewKey 重映射
      expect(page1Parsed.content[3].attrs.sceneKey).toMatch(/^pages\/uploaded-/)
      expect(page1Parsed.content[3].attrs.previewKey).toMatch(
        /^pages\/uploaded-/
      )
      // htmlEmbed key 重映射
      expect(page1Parsed.content[4].attrs.key).toBe(
        "embeds/uploaded-embed.html"
      )
      // 派生 contentHtml 与 contentText
      expect(page1Update.contentHtml).toContain("跳到三级页")
      expect(page1Update.contentText).toContain("跳到三级页")

      // 2. 二级页面（包含复杂表格与合并表头）
      const page2Update = updatedPages.get(102)
      expect(page2Update).toBeDefined()
      const page2Parsed = JSON.parse(page2Update.contentJson)
      expect(page2Parsed.content[0].type).toBe("table")
      expect(page2Parsed.content[0].content[0].content[0].attrs.colspan).toBe(2)
      expect(
        page2Parsed.content[0].content[0].content[0].content[0].content[0].text
      ).toBe("合并表头")

      // 3. 三级页面（包含代码块）
      const page3Update = updatedPages.get(103)
      expect(page3Update).toBeDefined()
      const page3Parsed = JSON.parse(page3Update.contentJson)
      expect(page3Parsed.content[0].type).toBe("codeBlock")
      expect(page3Parsed.content[0].attrs.language).toBe("typescript")
      expect(page3Parsed.content[0].content[0].text).toBe("const x = 1;")
    })
  })
})
