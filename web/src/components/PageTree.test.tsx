import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PageTree } from "@/components/PageTree"
import type { Space } from "@/lib/api"
import { usePagesStore } from "@/stores/pages"
import { useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    pagesApi: { ...actual.pagesApi, tree: vi.fn(), create: vi.fn() }
  }
})

const { pagesApi } = await import("@/lib/api")

function space(role: Space["myRole"]): Space {
  return {
    id: "space-default",
    name: "默认空间",
    description: "",
    myRole: role,
    isDefault: true,
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z"
  }
}

const renderTree = () =>
  render(
    <MemoryRouter>
      <PageTree />
    </MemoryRouter>
  )

describe("页面树空状态", () => {
  beforeEach(() => {
    usePagesStore.setState({
      tree: [],
      spaceId: "space-default",
      loading: false,
      error: null,
      expanded: []
    })
    useSpacesStore.setState({
      spaces: [space("editor")],
      status: "ready",
      error: null,
      currentId: "space-default"
    })
    vi.mocked(pagesApi.tree).mockResolvedValue([])
  })

  it("空树时「新建页面」能真的打开新建对话框", async () => {
    const user = userEvent.setup()
    renderTree()

    expect(screen.getByText(/还没有页面/)).toBeInTheDocument()
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
      spaceId: "space-default",
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
      expect.objectContaining({
        title: "新页面",
        parentId: null,
        spaceId: "space-default"
      })
    )
  })

  it("编辑及以上才有「移动到空间」入口，点开是移动对话框", async () => {
    const user = userEvent.setup()
    useSpacesStore.setState({
      spaces: [
        space("editor"),
        { ...space("editor"), id: "s2", name: "另一个空间", isDefault: false }
      ],
      currentId: "space-default"
    })
    usePagesStore.setState({
      tree: [
        {
          id: "p1",
          parentId: null,
          title: "可移动页面",
          sortOrder: 0,
          updatedAt: "2026-11-08T00:00:00.000Z",
          children: []
        }
      ]
    })
    renderTree()

    await user.click(
      screen.getByRole("button", { name: "页面「可移动页面」操作" })
    )
    await user.click(
      await screen.findByRole("menuitem", { name: "移动到空间…" })
    )

    expect(await screen.findByText("移动「可移动页面」")).toBeInTheDocument()
  })

  it("只有一个空间时不显示移动到空间", async () => {
    const user = userEvent.setup()
    usePagesStore.setState({
      tree: [
        {
          id: "p1",
          parentId: null,
          title: "唯一页面",
          sortOrder: 0,
          updatedAt: "2026-11-08T00:00:00.000Z",
          children: []
        }
      ]
    })
    renderTree()

    await user.click(
      screen.getByRole("button", { name: "页面「唯一页面」操作" })
    )
    expect(
      await screen.findByRole("menuitem", { name: "重命名" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "移动到空间…" })).toBeNull()
  })

  it("只读空间：行内不给操作菜单与拖拽手柄", () => {
    useSpacesStore.setState({
      spaces: [space("viewer")],
      currentId: "space-default"
    })
    usePagesStore.setState({
      tree: [
        {
          id: "p1",
          parentId: null,
          title: "只读页面",
          sortOrder: 0,
          updatedAt: "2026-11-08T00:00:00.000Z",
          children: []
        }
      ]
    })
    renderTree()

    expect(screen.getByText("只读页面")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "页面「只读页面」操作" })
    ).toBeNull()
    expect(screen.queryByRole("button", { name: "拖动调整位置" })).toBeNull()
  })

  it("只读空间的空状态说明只读身份，且没有新建入口", () => {
    useSpacesStore.setState({
      spaces: [space("viewer")],
      currentId: "space-default"
    })
    renderTree()

    expect(screen.getByText(/只读成员/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "新建页面" })).toBeNull()
  })

  it("页面树加载失败时给重试入口，而不是误报没有页面", () => {
    usePagesStore.setState({
      tree: [],
      loading: false,
      error: "对象不存在，或已被删除。"
    })
    renderTree()

    expect(screen.getByRole("alert")).toHaveTextContent(
      "对象不存在，或已被删除。"
    )
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument()
    expect(screen.queryByText(/还没有页面/)).toBeNull()
  })
})
