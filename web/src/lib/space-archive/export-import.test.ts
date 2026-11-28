import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fflate from "fflate"
import { ApiError, pagesApi, spacesApi, api, type PageNode } from "@/lib/api"
import {
  decompressZip,
  executeSpaceImport,
  preflightSpaceArchive
} from "./import"
import { exportSpaceArchive } from "./export"
import { deleteCheckpoint, getCheckpoint, saveCheckpoint } from "./checkpoint"
import {
  extractReferencedFiles,
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

    it("从 TipTap JSON 提取四类文件引用", () => {
      const sampleDoc = {
        type: "doc",
        content: [
          {
            type: "image",
            attrs: { src: "/api/files/pages/img-1.png" }
          },
          {
            type: "image",
            attrs: { originalSrc: "/api/files/imports/img-2.jpg" }
          },
          {
            type: "excalidraw",
            attrs: {
              sceneKey: "pages/canvas-scene.json",
              previewKey: "pages/canvas-prev.png"
            }
          },
          {
            type: "htmlEmbed",
            attrs: { key: "embeds/chart.html", name: "业务图表.html" }
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
            attrs: { src: "/api/files/pages/old-img.png" }
          },
          {
            type: "excalidraw",
            attrs: {
              sceneKey: "pages/old-scene.json",
              previewKey: "pages/old-prev.png"
            }
          }
        ]
      }

      const fileKeyMap = {
        "pages/old-img.png": "pages/new-img.png",
        "pages/old-scene.json": "pages/new-scene.json",
        "pages/old-prev.png": "pages/new-prev.png"
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
      expect(parsed.content[1].attrs.src).toBe("/api/files/pages/new-img.png")
      expect(parsed.content[2].attrs.sceneKey).toBe("pages/new-scene.json")
      expect(parsed.content[2].attrs.previewKey).toBe("pages/new-prev.png")
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
          originalKey: "pages/img-1.png",
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
          attrs: { src: "/api/files/pages/img-1.png" }
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
        key: "pages/new-uploaded-img.png",
        url: "/api/files/pages/new-uploaded-img.png",
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
        "/api/files/pages/new-uploaded-img.png"
      )
    })

    it("中断续跑：利用检查点跳过已完成项，修完最终空间", async () => {
      // 先在 store 中存入一个执行到一半的检查点
      mockIdbStore.set("resume_sha", {
        zipSha256: "resume_sha",
        targetSpaceId: 99,
        targetSpaceSlug: "resumed-space",
        fileMap: { "pages/img-1.png": "pages/already-uploaded.png" },
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
      expect(report.failedFiles[0].originalKey).toBe("pages/img-1.png")
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
            attrs: { src: "/api/files/pages/pic-1.png", width: 300 }
          },
          {
            type: "image",
            attrs: { src: "/api/files/imports/pic-2.png" }
          },
          {
            type: "excalidraw",
            attrs: {
              sceneKey: "pages/canvas-1.json",
              previewKey: "pages/canvas-prev.png"
            }
          },
          {
            type: "htmlEmbed",
            attrs: { key: "embeds/embed-1.html", name: "动画演示.html" }
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
        return { contentMd: `页面 ${id} 正文` } as any
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
    })
  })
})
