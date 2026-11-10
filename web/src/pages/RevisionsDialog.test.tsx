import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest"
import { Toaster } from "@/components/ui/sonner"
import {
  ApiError,
  type PageDetail,
  type RevisionDetail,
  type RevisionSummary
} from "@/lib/api"
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

const restoredPage: PageDetail = {
  id: "p1",
  parentId: null,
  spaceId: "space-default",
  title: "第一版",
  sortOrder: 0,
  contentJson: "{}",
  contentHtml: "<p>第一版</p>",
  contentText: "第一版",
  contentMd: "第一版",
  createdBy: "user-aaa-1",
  updatedBy: "user-aaa-1",
  createdAt: "2026-11-09T04:00:00.000Z",
  updatedAt: "2026-11-09T07:00:00.000Z"
}

function renderDialog(readOnly = false) {
  return render(
    <>
      <RevisionsDialog
        pageId="p1"
        open
        onOpenChange={() => {}}
        readOnly={readOnly}
        onRestored={() => {}}
      />
      {/* 轻提示的宿主与真实应用一致：挂在应用根上，浮在弹窗之上 */}
      <Toaster />
    </>
  )
}

/** 等列表真正到位：任一行出现即说明接口已回。 */
async function rowReady() {
  return screen.findByRole("button", { name: /user-aaa/ })
}

describe("版本历史：布局与动作归位", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  beforeEach(() => {
    // sonner 的队列是模块级的：上一条用例的轻提示会留到下一渲染，先清空
    toast.dismiss()
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
    vi.mocked(pagesApi.restoreRevision)
      .mockReset()
      .mockResolvedValue(restoredPage)
  })

  afterEach(() => {
    toast.dismiss()
  })

  it("标题下没有副标题、整块弹窗没有页脚，规则文案不重复", async () => {
    renderDialog()
    await rowReady()

    // 副标题与页脚警告都已删除，且不在别处复述
    expect(screen.queryByText(/每次保存都会留下一条记录/)).toBeNull()
    expect(screen.queryByText(/删除版本不可恢复/)).toBeNull()
    expect(
      document.querySelector('[data-slot="dialog-description"]')
    ).toBeNull()
    expect(document.querySelector('[data-slot="dialog-footer"]')).toBeNull()
    // 「删除不可恢复」只保留在删除二次确认框里
    expect(screen.getByRole("dialog")).toHaveTextContent("版本历史")
  })

  it("最新一条带「最新」标记且没有删除入口，其余每条都能删", async () => {
    renderDialog()
    await rowReady()

    expect(screen.getAllByText("最新")).toHaveLength(1)
    const deleteButtons = screen.getAllByRole("button", {
      name: "删除这个版本"
    })
    expect(deleteButtons).toHaveLength(2)
    expect(
      screen.getByRole("button", { name: "只保留最新一条" })
    ).toBeInTheDocument()
  })

  it("只读成员看不到删除与批量入口，也不会出现回滚按钮", async () => {
    const user = userEvent.setup()
    renderDialog(true)
    await rowReady()

    expect(screen.queryByRole("button", { name: "删除这个版本" })).toBeNull()
    expect(screen.queryByRole("button", { name: "只保留最新一条" })).toBeNull()
    expect(screen.queryByRole("button", { name: "回滚到这个版本" })).toBeNull()

    await user.click(screen.getByRole("button", { name: /user-aaa/ }))
    expect((await screen.findAllByText("第一版")).length).toBeGreaterThan(0)
    expect(screen.queryByRole("button", { name: "回滚到这个版本" })).toBeNull()
  })

  it("未选中版本时预览栏只有一处居中占位，回滚按钮整条不渲染", async () => {
    renderDialog()
    await rowReady()

    expect(screen.getByText("选择左侧任一版本查看内容")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "回滚到这个版本" })).toBeNull()
    expect(screen.queryByText(/的版本$/)).toBeNull()
  })

  it("选中非最新版本：回滚按钮落在预览栏头部，回滚后关闭并回写页面", async () => {
    const user = userEvent.setup()
    const onRestored = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <>
        <RevisionsDialog
          pageId="p1"
          open
          onOpenChange={onOpenChange}
          onRestored={onRestored}
        />
        <Toaster />
      </>
    )
    await rowReady()

    await user.click(screen.getByRole("button", { name: /user-aaa/ }))
    await screen.findByText("第一版")
    expect(
      screen.getByText("2026-11-09 12:00 的版本", { exact: false })
    ).toBeInTheDocument()

    const rollback = screen.getByRole("button", {
      name: "回滚到这个版本"
    })
    await user.click(rollback)

    await waitFor(() =>
      expect(pagesApi.restoreRevision).toHaveBeenCalledWith("p1", "r1")
    )
    expect(onRestored).toHaveBeenCalledWith(restoredPage)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("选中最新一条时不渲染回滚按钮", async () => {
    const user = userEvent.setup()
    renderDialog()
    await rowReady()

    await user.click(screen.getByRole("button", { name: /user-ccc/ }))
    await screen.findByText("第三版")
    expect(screen.queryByRole("button", { name: "回滚到这个版本" })).toBeNull()
  })

  it("只剩最新一条：批量入口与回滚入口自动隐藏", async () => {
    vi.mocked(pagesApi.revisions).mockResolvedValue([revisions[0]])
    const user = userEvent.setup()
    renderDialog()
    await screen.findByText("最新")

    expect(screen.queryByRole("button", { name: "只保留最新一条" })).toBeNull()
    expect(screen.queryByRole("button", { name: "删除这个版本" })).toBeNull()

    await user.click(screen.getByRole("button", { name: /user-ccc/ }))
    await screen.findByText("第三版")
    expect(screen.queryByRole("button", { name: "回滚到这个版本" })).toBeNull()
  })

  it("删中间版本：轻提示浮现、列表即时少一条且不跳位", async () => {
    const user = userEvent.setup()
    renderDialog()
    await rowReady()

    const rowsBefore = screen.getAllByRole("button", { name: /user-/ })
    expect(rowsBefore).toHaveLength(3)

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

    // 轻提示：候选 DOM 里出现 toast 容器，而不是列表上方的绿色色块
    const hint = await screen.findByText("版本已删除。")
    expect(hint.closest("[data-sonner-toast]")).not.toBeNull()

    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "删除这个版本" })
      ).toHaveLength(1)
    )
    // 剩下两行，且仍是「最新、第一版」这个顺序（列表没有为新提示让位）
    const rowsAfter = screen.getAllByRole("button", { name: /user-/ })
    expect(rowsAfter.map((row) => row.textContent)).toEqual([
      expect.stringContaining("user-ccc"),
      expect.stringContaining("user-aaa")
    ])

    // 剩下的旧版本仍然可以打开查看
    await user.click(screen.getByRole("button", { name: /user-aaa/ }))
    await waitFor(() =>
      expect(pagesApi.revision).toHaveBeenCalledWith("p1", "r1")
    )
    expect((await screen.findAllByText("第一版")).length).toBeGreaterThan(0)
  })

  it("删掉当前选中的那条：预览回到未选中居中占位", async () => {
    const user = userEvent.setup()
    renderDialog()
    await rowReady()

    await user.click(screen.getByRole("button", { name: /user-aaa/ }))
    await screen.findByText("第一版")
    expect(
      screen.queryByText("选择左侧任一版本查看内容")
    ).not.toBeInTheDocument()

    // 删除刚选中的 r1：点它自己那一行的行内删除键
    const row = screen.getByRole("button", { name: /user-aaa/ }).closest("li")
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "删除这个版本" })
    )
    const confirm = await screen.findByRole("alertdialog")
    expect(
      within(confirm).getByText(/2026-11-09 12:00 的版本/)
    ).toBeInTheDocument()
    await user.click(within(confirm).getByRole("button", { name: "删除" }))

    await waitFor(() =>
      expect(pagesApi.deleteRevision).toHaveBeenCalledWith("p1", "r1")
    )
    expect(
      await screen.findByText("选择左侧任一版本查看内容")
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "回滚到这个版本" })).toBeNull()
  })

  it("只保留最新一条：轻提示给出条数，执行后只剩一条且批量入口消失", async () => {
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
    expect(await screen.findByText("已删除 2 条版本。")).toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "只保留最新一条" })
      ).toBeNull()
    )
    expect(screen.queryByRole("button", { name: "删除这个版本" })).toBeNull()
  })

  it("版本预览与阅读页同口径：折叠块显示「展开代码」并可展开", async () => {
    vi.mocked(pagesApi.revision)
      .mockReset()
      .mockImplementation(async (_pageId, revisionId) => {
        const found = revisions.find((item) => item.id === revisionId)
        if (!found) throw new Error("missing revision fixture")
        return {
          ...detail(found),
          contentHtml:
            '<pre data-collapsed="true"><code class="language-sql">select 1;</code></pre>'
        }
      })
    const user = userEvent.setup()
    renderDialog()
    await rowReady()

    await user.click(screen.getByRole("button", { name: /user-aaa/ }))
    const dialog = within(screen.getByRole("dialog"))
    const expand = await dialog.findByRole("button", { name: /展开代码/ })
    const panel = screen
      .getByRole("dialog")
      .querySelector(".code-block > pre") as HTMLElement
    expect(panel).not.toBeVisible()

    await user.click(expand)
    expect(panel).toBeVisible()
    expect(dialog.getByRole("button", { name: /收起代码/ })).toBeInTheDocument()
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
