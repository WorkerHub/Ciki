import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router"
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
    id: 1,
    slug: "default",
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

const renderTreeWithRoute = (initialPath = "/") =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/p/:pageId" element={<PageTree />} />
        <Route path="/p/:pageId/edit" element={<PageTree />} />
        <Route path="*" element={<PageTree />} />
      </Routes>
    </MemoryRouter>
  )

describe("页面树空状态", () => {
  beforeEach(() => {
    usePagesStore.setState({
      tree: [],
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })
    useSpacesStore.setState({
      spaces: [space("editor")],
      status: "ready",
      error: null,
      currentId: 1
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
      id: 1,
      parentId: null,
      spaceId: 1,
      title: "新页面",
      sortOrder: 0,
      contentHtml: "",
      contentText: "",
      contentMd: "",
      createdBy: 1,
      updatedBy: 1,
      createdAt: "2026-11-07T00:00:00.000Z",
      updatedAt: "2026-11-07T00:00:00.000Z",
      createdByName: "Admin",
      createdByAvatarUrl: null,
      updatedByName: "Admin",
      updatedByAvatarUrl: null
    })
    renderTree()

    await user.click(screen.getByRole("button", { name: "新建页面" }))
    await user.type(await screen.findByLabelText("页面标题"), "新页面")
    await user.click(screen.getByRole("button", { name: "创建并编辑" }))

    expect(pagesApi.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "新页面",
        parentId: null,
        spaceId: 1
      })
    )
  })

  it("编辑及以上才有「移动」入口，点开是移动对话框", async () => {
    const user = userEvent.setup()
    useSpacesStore.setState({
      spaces: [
        space("editor"),
        {
          ...space("editor"),
          id: 2,
          slug: "space-2",
          name: "另一个空间",
          isDefault: false
        }
      ],
      currentId: 1
    })
    usePagesStore.setState({
      tree: [
        {
          id: 1,
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
    await user.click(await screen.findByRole("menuitem", { name: "移动…" }))

    expect(await screen.findByText("移动「可移动页面」")).toBeInTheDocument()
  })

  it("只有一个空间时也给「移动」入口（同空间改父页面）", async () => {
    const user = userEvent.setup()
    usePagesStore.setState({
      tree: [
        {
          id: 1,
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
    expect(screen.getByRole("menuitem", { name: "移动…" })).toBeInTheDocument()
  })

  it("只读空间：行内不给操作菜单与拖拽手柄", () => {
    useSpacesStore.setState({
      spaces: [space("viewer")],
      currentId: 1
    })
    usePagesStore.setState({
      tree: [
        {
          id: 1,
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

  it("树行控件是悬浮覆盖层：不占标题宽度、平时不挡点击", () => {
    const title = "很长很长很长很长很长很长很长很长的页面标题"
    useSpacesStore.setState({
      spaces: [space("editor")],
      currentId: 1
    })
    usePagesStore.setState({
      tree: [
        {
          id: 1,
          parentId: null,
          title,
          sortOrder: 0,
          updatedAt: "2026-11-08T00:00:00.000Z",
          children: []
        }
      ]
    })
    renderTree()

    const titleButton = screen.getByRole("button", { name: title })
    // 标题吃满整行，只给行尾的小 padding 让路
    expect(titleButton).toHaveClass("min-w-0", "flex-1", "truncate")

    const controls = screen.getByRole("button", {
      name: `页面「${title}」操作`
    }).parentElement
    // 覆盖层：绝对定位，平时不可见也不拦点击；hover / 行内聚焦 / 菜单打开时显形
    expect(controls).toHaveClass(
      "absolute",
      "opacity-0",
      "pointer-events-none",
      "group-hover:opacity-100",
      "group-hover:pointer-events-auto",
      "group-focus-within:opacity-100",
      "group-focus-within:pointer-events-auto"
    )
    expect(controls?.className).toContain(
      "group-has-[[data-state=open]]:opacity-100"
    )
    // 控件不再参与 flex 布局：与标题同级，定位由行容器负责
    expect(controls?.parentElement).toBe(titleButton.parentElement)
    expect(controls?.parentElement).toHaveClass("relative")
  })

  it("只读空间的空状态说明只读身份，且没有新建入口", () => {
    useSpacesStore.setState({
      spaces: [space("viewer")],
      currentId: 1
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

describe("目录树自动展开到当前文档与滚动可见", () => {
  const nestedTree = [
    {
      id: 1,
      parentId: null,
      title: "顶级文档",
      sortOrder: 0,
      updatedAt: "2026-11-08T00:00:00.000Z",
      children: [
        {
          id: 2,
          parentId: 1,
          title: "中间目录",
          sortOrder: 0,
          updatedAt: "2026-11-08T00:00:00.000Z",
          children: [
            {
              id: 3,
              parentId: 2,
              title: "嵌套文档",
              sortOrder: 0,
              updatedAt: "2026-11-08T00:00:00.000Z",
              children: []
            }
          ]
        }
      ]
    },
    {
      id: 4,
      parentId: null,
      title: "另一个目录",
      sortOrder: 1,
      updatedAt: "2026-11-08T00:00:00.000Z",
      children: [
        {
          id: 5,
          parentId: 4,
          title: "另一个子文档",
          sortOrder: 0,
          updatedAt: "2026-11-08T00:00:00.000Z",
          children: []
        }
      ]
    }
  ]

  beforeEach(() => {
    useSpacesStore.setState({
      spaces: [space("editor")],
      status: "ready",
      currentId: 1
    })
  })

  it("深层嵌套文档刷新后祖先链全展开、当前行可见且高亮并调用 scrollIntoView", () => {
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView")
    usePagesStore.setState({
      tree: nestedTree,
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })

    renderTreeWithRoute("/p/3")

    expect(usePagesStore.getState().expanded).toContain(1)
    expect(usePagesStore.getState().expanded).toContain(2)
    expect(screen.getByText("顶级文档")).toBeInTheDocument()
    expect(screen.getByText("中间目录")).toBeInTheDocument()
    expect(screen.getByText("嵌套文档")).toBeInTheDocument()

    const activeRow = screen.getByText("嵌套文档").closest("li")
    expect(activeRow).toHaveAttribute("data-tree-row", "3")
    expect(activeRow?.querySelector(".bg-accent")).toBeInTheDocument()
    expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" })
    scrollSpy.mockRestore()
  })

  it("树就绪前（loading: true）不触发，加载完成后才自动展开", () => {
    usePagesStore.setState({
      tree: [],
      spaceId: 1,
      loading: true,
      error: null,
      expanded: []
    })

    renderTreeWithRoute("/p/3")
    expect(usePagesStore.getState().expanded).toEqual([])
    expect(screen.queryByText("嵌套文档")).toBeNull()

    act(() => {
      usePagesStore.setState({
        tree: nestedTree,
        loading: false
      })
    })

    expect(usePagesStore.getState().expanded).toContain(1)
    expect(usePagesStore.getState().expanded).toContain(2)
    expect(screen.getByText("嵌套文档")).toBeInTheDocument()
  })

  it("顶层文档（无祖先）加载时不展开多余目录，仅当前行高亮与滚动可见", () => {
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView")
    usePagesStore.setState({
      tree: nestedTree,
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })

    renderTreeWithRoute("/p/1")

    expect(usePagesStore.getState().expanded).toEqual([])
    expect(screen.getByText("顶级文档")).toBeInTheDocument()
    expect(screen.queryByText("中间目录")).toBeNull()
    expect(screen.queryByText("嵌套文档")).toBeNull()

    const activeRow = screen.getByText("顶级文档").closest("li")
    expect(activeRow).toHaveAttribute("data-tree-row", "1")
    expect(activeRow?.querySelector(".bg-accent")).toBeInTheDocument()
    expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" })
    scrollSpy.mockRestore()
  })

  it("停留在同一文档期间手动收起祖先目录，保持收起、不自动弹回", async () => {
    const user = userEvent.setup()
    usePagesStore.setState({
      tree: nestedTree,
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })

    renderTreeWithRoute("/p/3")
    expect(screen.getByText("嵌套文档")).toBeInTheDocument()

    // 点击中间目录的收起图标（中间目录对应 data-tree-row="2"）
    const middleRow = screen.getByText("中间目录").closest("li")
    const collapseButton = middleRow?.querySelector(
      'button[aria-expanded="true"]'
    ) as HTMLButtonElement
    expect(collapseButton).toBeTruthy()
    await user.click(collapseButton!)

    expect(usePagesStore.getState().expanded).not.toContain(2)
    expect(screen.queryByText("嵌套文档")).toBeNull()
  })

  it("编辑路由 /p/:pageId/edit 同样支持自动展开", () => {
    usePagesStore.setState({
      tree: nestedTree,
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })

    renderTreeWithRoute("/p/3/edit")
    expect(usePagesStore.getState().expanded).toContain(1)
    expect(usePagesStore.getState().expanded).toContain(2)
    expect(screen.getByText("嵌套文档")).toBeInTheDocument()
  })

  it("当前文档不在当前空间树内时静默无操作", () => {
    usePagesStore.setState({
      tree: nestedTree,
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })

    renderTreeWithRoute("/p/999")
    expect(usePagesStore.getState().expanded).toEqual([])
  })

  it("路由变化落到另一深层文档时，自动展开新文档的祖先链", async () => {
    const user = userEvent.setup()
    usePagesStore.setState({
      tree: nestedTree,
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })

    function TestApp() {
      const navigate = useNavigate()
      return (
        <div>
          <button type="button" onClick={() => navigate("/p/5")}>
            跳转到子文档5
          </button>
          <Routes>
            <Route path="/p/:pageId" element={<PageTree />} />
            <Route path="*" element={<PageTree />} />
          </Routes>
        </div>
      )
    }

    render(
      <MemoryRouter initialEntries={["/p/3"]}>
        <TestApp />
      </MemoryRouter>
    )

    expect(usePagesStore.getState().expanded).toContain(1)
    expect(usePagesStore.getState().expanded).toContain(2)
    expect(screen.getByText("嵌套文档")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "跳转到子文档5" }))

    expect(usePagesStore.getState().expanded).toContain(4)
    expect(screen.getByText("另一个子文档")).toBeInTheDocument()
  })
})
