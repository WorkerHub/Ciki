import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, type RevisionDetail, type RevisionSummary } from "@/lib/api"
import { RevisionsDialog } from "@/pages/RevisionsDialog"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    pagesApi: {
      ...actual.pagesApi,
      revisions: vi.fn(),
      revision: vi.fn(),
      deleteRevision: vi.fn(),
      pruneRevisions: vi.fn(),
      restoreRevision: vi.fn()
    }
  }
})

const { pagesApi } = await import("@/lib/api")

/** 列表按 created_at DESC 到达：r3 最新。 */
const revisions: RevisionSummary[] = [
  {
    id: "r3",
    title: "第三版",
    editorId: "user-ccc-3",
    createdAt: "2026-11-09T06:00:00.000Z"
  },
  {
    id: "r2",
    title: "第二版",
    editorId: "user-bbb-2",
    createdAt: "2026-11-09T05:00:00.000Z"
  },
  {
    id: "r1",
    title: "第一版",
    editorId: "user-aaa-1",
    createdAt: "2026-11-09T04:00:00.000Z"
  }
]

function detail(revision: RevisionSummary): RevisionDetail {
  return {
    ...revision,
    pageId: "p1",
    contentJson: "{}",
    contentHtml: `<p>${revision.title}</p>`,
    contentText: revision.title
  }
}

function renderDialog(readOnly = false) {
  return render(
    <RevisionsDialog
      pageId="p1"
      open
      onOpenChange={() => {}}
      readOnly={readOnly}
      onRestored={() => {}}
    />
  )
}

/** 等列表真正到位：任一行出现即说明接口已回。 */
async function rowReady() {
  return screen.findByRole("button", { name: /user-aaa/ })
}

describe("版本历史：删除入口与权限", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  beforeEach(() => {
    vi.mocked(pagesApi.revisions).mockReset().mockResolvedValue(revisions)
    vi.mocked(pagesApi.revision)
      .mockReset()
      .mockImplementation(async (_pageId, revisionId) => {
        const found = revisions.find((item) => item.id === revisionId)
        if (!found) throw new Error("missing revision fixture")
        return detail(found)
      })
    vi.mocked(pagesApi.deleteRevision)
      .mockReset()
      .mockResolvedValue({ success: true })
    vi.mocked(pagesApi.pruneRevisions)
      .mockReset()
      .mockResolvedValue({ deleted: 2 })
  })

  it("最新一条没有删除入口，其余每条都能删", async () => {
    renderDialog()
    await rowReady()

    const deleteButtons = screen.getAllByRole("button", {
      name: "删除这个版本"
    })
    expect(deleteButtons).toHaveLength(2)
    // 最新的一条（第三版）不渲染删除键：两把垃圾篓对应 r2 / r1
    expect(
      screen.getByRole("button", { name: "只保留最新一条" })
    ).toBeInTheDocument()
  })

  it("只读成员看不到删除与批量入口", async () => {
    renderDialog(true)
    await rowReady()

    expect(screen.queryByRole("button", { name: "删除这个版本" })).toBeNull()
    expect(screen.queryByRole("button", { name: "只保留最新一条" })).toBeNull()
    expect(screen.queryByRole("button", { name: "回滚到这个版本" })).toBeNull()
    expect(screen.getByText(/只读成员可以查看历史/)).toBeInTheDocument()
  })

  it("删中间版本：列表即时少一条，其余版本仍能查看", async () => {
    const user = userEvent.setup()
    renderDialog()
    await rowReady()

    const [firstDelete] = screen.getAllByRole("button", {
      name: "删除这个版本"
    })
    await user.click(firstDelete)

    const confirm = await screen.findByRole("alertdialog")
    expect(
      within(confirm).getByText(/2026-11-09 13:00 的版本/)
    ).toBeInTheDocument()
    expect(
      within(confirm).getByText(/将被永久删除，无法恢复/)
    ).toBeInTheDocument()
    await user.click(within(confirm).getByRole("button", { name: "删除" }))

    await waitFor(() =>
      expect(pagesApi.deleteRevision).toHaveBeenCalledWith("p1", "r2")
    )
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "删除这个版本" })
      ).toHaveLength(1)
    )
    expect(await screen.findByRole("status")).toHaveTextContent("版本已删除。")

    // 剩下的旧版本仍然可以打开查看
    await user.click(screen.getByRole("button", { name: /user-aaa/ }))
    await waitFor(() =>
      expect(pagesApi.revision).toHaveBeenCalledWith("p1", "r1")
    )
    expect((await screen.findAllByText("第一版")).length).toBeGreaterThan(0)
  })

  it("只保留最新一条：确认文案给出条数，执行后只剩一条", async () => {
    const user = userEvent.setup()
    renderDialog()
    await rowReady()

    await user.click(screen.getByRole("button", { name: "只保留最新一条" }))
    const confirm = await screen.findByRole("alertdialog")
    expect(within(confirm).getByText(/将删除其余 2 条版本/)).toBeInTheDocument()

    await user.click(within(confirm).getByRole("button", { name: "删除 2 条" }))

    await waitFor(() =>
      expect(pagesApi.pruneRevisions).toHaveBeenCalledWith("p1")
    )
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已删除 2 条版本。"
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "只保留最新一条" })
      ).toBeNull()
    )
    expect(screen.queryByRole("button", { name: "删除这个版本" })).toBeNull()
  })

  it("服务端判定目标已是最新（并发保存）：中文提示并重拉列表", async () => {
    const user = userEvent.setup()
    vi.mocked(pagesApi.deleteRevision).mockRejectedValue(
      new ApiError(
        409,
        "Cannot delete the latest revision",
        "REVISION_IS_LATEST",
        undefined,
        undefined,
        "/pages/p1/revisions/r2"
      )
    )
    renderDialog()
    await rowReady()

    const [firstDelete] = screen.getAllByRole("button", {
      name: "删除这个版本"
    })
    await user.click(firstDelete)
    const confirm = await screen.findByRole("alertdialog")
    await user.click(within(confirm).getByRole("button", { name: "删除" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "每页最新的一条版本不能删除。"
    )
    await waitFor(() => expect(pagesApi.revisions).toHaveBeenCalledTimes(2))
  })
})
