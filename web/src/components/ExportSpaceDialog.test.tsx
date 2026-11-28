import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ExportSpaceDialog } from "./ExportSpaceDialog"
import { pagesApi } from "@/lib/api"
import * as exporter from "@/lib/space-archive/export"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    pagesApi: {
      ...actual.pagesApi,
      tree: vi.fn()
    }
  }
})

vi.mock("@/lib/space-archive/export", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/space-archive/export")>()
  return {
    ...actual,
    exportSpaceArchive: vi.fn()
  }
})

describe("ExportSpaceDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("打开时展示页面数量与预估请求数", async () => {
    vi.mocked(pagesApi.tree).mockResolvedValue([
      {
        id: 1,
        parentId: null,
        title: "首页",
        sortOrder: 0,
        updatedAt: "2026-11-28",
        children: [
          {
            id: 2,
            parentId: 1,
            title: "子页",
            sortOrder: 0,
            updatedAt: "2026-11-28",
            children: []
          }
        ]
      }
    ])

    render(
      <ExportSpaceDialog
        spaceId={1}
        spaceName="测试空间"
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    expect(await screen.findByText("测试空间")).toBeInTheDocument()
    expect(await screen.findByText("2")).toBeInTheDocument() // 页面数量
    expect(screen.getByText("~4")).toBeInTheDocument() // 预估请求数 (2 * 2)
  })

  it("点击导出触发 exportSpaceArchive 并展示完成状态", async () => {
    const user = userEvent.setup()
    vi.mocked(pagesApi.tree).mockResolvedValue([
      {
        id: 1,
        parentId: null,
        title: "首页",
        sortOrder: 0,
        updatedAt: "2026-11-28",
        children: []
      }
    ])

    vi.mocked(exporter.exportSpaceArchive).mockResolvedValue({
      filename: "test-space-export.zip",
      manifest: { warnings: ["测试警告"] } as any,
      warningCount: 1
    })

    render(
      <ExportSpaceDialog
        spaceId={1}
        spaceName="测试空间"
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    const startBtn = await screen.findByRole("button", { name: /开始导出/i })
    await user.click(startBtn)

    expect(await screen.findByText("test-space-export.zip")).toBeInTheDocument()
    expect(screen.getByText(/测试警告/)).toBeInTheDocument()
  })
})
