import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router"
import { ImportSpaceDialog } from "./ImportSpaceDialog"
import * as importer from "@/lib/space-archive/import"

vi.mock("@/lib/space-archive/import", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/space-archive/import")>()
  return {
    ...actual,
    decompressZip: vi.fn(),
    preflightSpaceArchive: vi.fn(),
    executeSpaceImport: vi.fn()
  }
})

vi.mock("@/lib/space-archive/checkpoint", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/space-archive/checkpoint")>()
  return {
    ...actual,
    calculateSha256: vi.fn().mockResolvedValue("test_sha")
  }
})

describe("ImportSpaceDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("预检发现致命错误时展示错误清单且无导入按钮", async () => {
    vi.mocked(importer.decompressZip).mockResolvedValue({})
    vi.mocked(importer.preflightSpaceArchive).mockResolvedValue({
      valid: false,
      manifest: null,
      fatalErrors: [
        { code: "MANIFEST_MISSING", message: "缺少 manifest.json" }
      ],
      warnings: [],
      pageCount: 0,
      fileCounts: { images: 0, embeds: 0, canvases: 0, files: 0, total: 0 },
      missingFilesCount: 0
    })

    render(
      <MemoryRouter>
        <ImportSpaceDialog open={true} onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    const file = new File(["dummy"], "bad.zip", { type: "application/zip" })
    // 触发隐藏 input 的 change 事件
    const hiddenInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    await userEvent.upload(hiddenInput, file)

    expect(
      await screen.findByText("预检发现致命错误，无法导入")
    ).toBeInTheDocument()
    expect(screen.getByText(/缺少 manifest\.json/)).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /开始导入/i })
    ).not.toBeInTheDocument()
  })

  it("预检通过且无检查点时展示开始导入按钮，执行后展示完成报告", async () => {
    const user = userEvent.setup()
    vi.mocked(importer.decompressZip).mockResolvedValue({})
    vi.mocked(importer.preflightSpaceArchive).mockResolvedValue({
      valid: true,
      manifest: { warnings: [] } as any,
      fatalErrors: [],
      warnings: [],
      pageCount: 5,
      fileCounts: { images: 2, embeds: 1, canvases: 1, files: 0, total: 4 },
      missingFilesCount: 0,
      hasCheckpoint: false
    })

    vi.mocked(importer.executeSpaceImport).mockResolvedValue({
      targetSpaceId: 10,
      targetSpaceSlug: "imported-space",
      pageCount: 5,
      fileCounts: { images: 2, embeds: 1, canvases: 1, files: 0, total: 4 },
      failedFiles: [],
      missingFilesCount: 0,
      remappedLinksCount: 3,
      warnings: []
    })

    render(
      <MemoryRouter>
        <ImportSpaceDialog open={true} onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    const file = new File(["dummy"], "valid.zip", { type: "application/zip" })
    const hiddenInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    await user.upload(hiddenInput, file)

    expect(await screen.findByText("5")).toBeInTheDocument()
    const startBtn = screen.getByRole("button", { name: /开始导入/i })
    await user.click(startBtn)

    expect(await screen.findByText("空间导入完成")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /进入新空间/i })
    ).toBeInTheDocument()
  })

  it("检测到检查点时提供继续上次导入与重新开始", async () => {
    const user = userEvent.setup()
    vi.mocked(importer.decompressZip).mockResolvedValue({})
    vi.mocked(importer.preflightSpaceArchive).mockResolvedValue({
      valid: true,
      manifest: { warnings: [] } as any,
      fatalErrors: [],
      warnings: [],
      pageCount: 5,
      fileCounts: { images: 1, embeds: 0, canvases: 0, files: 0, total: 1 },
      missingFilesCount: 0,
      hasCheckpoint: true,
      targetSpaceExists: true,
      existingSpaceId: 20
    })

    render(
      <MemoryRouter>
        <ImportSpaceDialog open={true} onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    const file = new File(["dummy"], "resume.zip", { type: "application/zip" })
    const hiddenInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    await user.upload(hiddenInput, file)

    expect(
      await screen.findByRole("button", { name: /继续上次导入/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /重新开始/i })
    ).toBeInTheDocument()
  })
})
