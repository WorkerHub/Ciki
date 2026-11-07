import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PageTree } from "@/components/PageTree"
import { usePagesStore } from "@/stores/pages"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    pagesApi: { ...actual.pagesApi, tree: vi.fn(), create: vi.fn() }
  }
})

const { pagesApi } = await import("@/lib/api")

const renderTree = () =>
  render(
    <MemoryRouter>
      <PageTree />
    </MemoryRouter>
  )

describe("页面树空状态", () => {
  beforeEach(() => {
    usePagesStore.setState({ tree: [], loading: false, expanded: [] })
    vi.mocked(pagesApi.tree).mockResolvedValue([])
  })

  it("空树时「新建页面」能真的打开新建对话框", async () => {
    const user = userEvent.setup()
    renderTree()

    expect(screen.getByText("还没有页面")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "新建页面" }))

    // 之前空状态提前 return，导致对话框根本不在 DOM 里，按钮点了没反应
    const dialog = await screen.findByRole("dialog")
    expect(dialog).toBeInTheDocument()
    expect(screen.getByLabelText("页面标题")).toBeInTheDocument()
  })

  it("空树状态下提交标题会调用创建接口", async () => {
    const user = userEvent.setup()
    vi.mocked(pagesApi.create).mockResolvedValue({
      id: "new-page",
      parentId: null,
      title: "新页面",
      sortOrder: 0,
      contentJson: "",
      contentHtml: "",
      contentText: "",
      createdBy: "u1",
      updatedBy: "u1",
      createdAt: "2026-11-07T00:00:00.000Z",
      updatedAt: "2026-11-07T00:00:00.000Z"
    })
    renderTree()

    await user.click(screen.getByRole("button", { name: "新建页面" }))
    await user.type(await screen.findByLabelText("页面标题"), "新页面")
    await user.click(screen.getByRole("button", { name: "创建并编辑" }))

    expect(pagesApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "新页面", parentId: null })
    )
  })
})
