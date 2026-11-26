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
    pagesApi: {
      ...actual.pagesApi,
      tree: vi.fn(),
      create: vi.fn(),
      move: vi.fn(),
      update: vi.fn()
    }
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

function TestNavApp({
  targetPath,
  label
}: {
  targetPath: string
  label: string
}) {
  const navigate = useNavigate()
  return (
    <div>
      <button type="button" onClick={() => navigate(targetPath)}>
        {label}
      </button>
      <Routes>
        <Route path="/p/:pageId" element={<PageTree />} />
        <Route path="*" element={<PageTree />} />
      </Routes>
    </div>
  )
}

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

  it("拖动排序/移动页面导致树更新后，手动收起的祖先目录保持收起、不被重新展开", async () => {
    const user = userEvent.setup()
    vi.mocked(pagesApi.move).mockResolvedValue({ success: true })
    vi.mocked(pagesApi.tree).mockResolvedValue(nestedTree)

    usePagesStore.setState({
      tree: nestedTree,
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })

    renderTreeWithRoute("/p/3")
    expect(screen.getByText("嵌套文档")).toBeInTheDocument()

    // 手动收起中间目录
    const middleRow = screen.getByText("中间目录").closest("li")
    const collapseButton = middleRow?.querySelector(
      'button[aria-expanded="true"]'
    ) as HTMLButtonElement
    await user.click(collapseButton)

    expect(usePagesStore.getState().expanded).not.toContain(2)
    expect(screen.queryByText("嵌套文档")).toBeNull()

    // 模拟移动操作（如拖动排序 movePage）
    await act(async () => {
      await usePagesStore.getState().movePage(4, null, 0)
    })

    // 移动完成后，树引用发生多次变化，但中间目录依然保持收起，当前文档祖先未被弹开
    expect(usePagesStore.getState().expanded).not.toContain(2)
    expect(screen.queryByText("嵌套文档")).toBeNull()
  })

  it("行内菜单「上移/下移」与「改名」触发树变化后，手动收起状态保持不变", async () => {
    const user = userEvent.setup()
    vi.mocked(pagesApi.move).mockResolvedValue({ success: true })
    vi.mocked(pagesApi.tree).mockResolvedValue(nestedTree)
    vi.mocked(pagesApi.update).mockResolvedValue({
      id: 4,
      parentId: null,
      spaceId: 1,
      title: "另一个目录（已改名）",
      sortOrder: 1,
      contentHtml: "",
      contentText: "",
      contentMd: "",
      createdBy: 1,
      updatedBy: 1,
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-08T00:00:00.000Z",
      createdByName: "Admin",
      createdByAvatarUrl: null,
      updatedByName: "Admin",
      updatedByAvatarUrl: null
    })

    usePagesStore.setState({
      tree: nestedTree,
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })

    renderTreeWithRoute("/p/3")

    // 手动收起中间目录
    const middleRow = screen.getByText("中间目录").closest("li")
    const collapseButton = middleRow?.querySelector(
      'button[aria-expanded="true"]'
    ) as HTMLButtonElement
    await user.click(collapseButton)
    expect(usePagesStore.getState().expanded).not.toContain(2)

    // 行内菜单「下移」改序
    await user.click(
      screen.getByRole("button", { name: "页面「顶级文档」操作" })
    )
    const moveDownItem = await screen.findByRole("menuitem", { name: "下移" })
    await user.click(moveDownItem)

    expect(usePagesStore.getState().expanded).not.toContain(2)
    expect(screen.queryByText("嵌套文档")).toBeNull()

    // 改名操作
    await user.click(
      screen.getByRole("button", { name: "页面「另一个目录」操作" })
    )
    const renameItem = await screen.findByRole("menuitem", { name: "重命名" })
    await user.click(renameItem)

    const renameInput = await screen.findByLabelText("标题")
    await user.clear(renameInput)
    await user.type(renameInput, "另一个目录（已改名）")
    await user.click(screen.getByRole("button", { name: "保存" }))

    expect(usePagesStore.getState().expanded).not.toContain(2)
    expect(screen.queryByText("嵌套文档")).toBeNull()
  })

  it("切换空间后，新空间深层文档的祖先正常自动展开定位", async () => {
    const user = userEvent.setup()
    useSpacesStore.setState({
      spaces: [
        space("editor"),
        {
          ...space("editor"),
          id: 2,
          slug: "space-2",
          name: "空间二",
          isDefault: false
        }
      ],
      status: "ready",
      currentId: 1
    })
    usePagesStore.setState({
      tree: nestedTree,
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })

    render(
      <MemoryRouter initialEntries={["/p/3"]}>
        <TestNavApp targetPath="/p/23" label="切空间并跳转" />
      </MemoryRouter>
    )

    expect(usePagesStore.getState().expanded).toContain(1)
    expect(usePagesStore.getState().expanded).toContain(2)

    // 切换到空间 2，页面跳到空间 2 的深层文档 /p/23
    const space2Tree = [
      {
        id: 21,
        parentId: null,
        title: "空间2顶级",
        sortOrder: 0,
        updatedAt: "2026-11-08T00:00:00.000Z",
        children: [
          {
            id: 22,
            parentId: 21,
            title: "空间2中间",
            sortOrder: 0,
            updatedAt: "2026-11-08T00:00:00.000Z",
            children: [
              {
                id: 23,
                parentId: 22,
                title: "空间2深层",
                sortOrder: 0,
                updatedAt: "2026-11-08T00:00:00.000Z",
                children: []
              }
            ]
          }
        ]
      }
    ]

    act(() => {
      useSpacesStore.setState({ currentId: 2 })
      usePagesStore.setState({
        tree: space2Tree,
        spaceId: 2,
        loading: false,
        expanded: []
      })
    })

    await user.click(screen.getByRole("button", { name: "切空间并跳转" }))

    expect(usePagesStore.getState().expanded).toContain(21)
    expect(usePagesStore.getState().expanded).toContain(22)
    expect(screen.getByText("空间2深层")).toBeInTheDocument()
  })

  it("同文档期间异步树到位补定位后，手动收起某祖先，再做改树操作依然保持收起", async () => {
    const user = userEvent.setup()
    vi.mocked(pagesApi.move).mockResolvedValue({ success: true })
    vi.mocked(pagesApi.tree).mockResolvedValue(nestedTree)

    // 路由已在 /p/3，但树尚未加载（异步树）
    usePagesStore.setState({
      tree: [],
      spaceId: 1,
      loading: true,
      error: null,
      expanded: []
    })

    renderTreeWithRoute("/p/3")
    expect(usePagesStore.getState().expanded).toEqual([])

    // 树异步加载完成到位：补定位一次
    act(() => {
      usePagesStore.setState({
        tree: nestedTree,
        loading: false
      })
    })

    expect(usePagesStore.getState().expanded).toContain(1)
    expect(usePagesStore.getState().expanded).toContain(2)
    expect(screen.getByText("嵌套文档")).toBeInTheDocument()

    // 用户手动收起祖先（中间目录）
    const middleRow = screen.getByText("中间目录").closest("li")
    const collapseButton = middleRow?.querySelector(
      'button[aria-expanded="true"]'
    ) as HTMLButtonElement
    await user.click(collapseButton)
    expect(usePagesStore.getState().expanded).not.toContain(2)

    // 随后发生任意树变更（如新建、排序、拉取）
    act(() => {
      usePagesStore.setState({
        tree: [
          ...nestedTree,
          {
            id: 99,
            parentId: null,
            title: "新同级文档",
            sortOrder: 2,
            updatedAt: "2026-11-26T00:00:00.000Z",
            children: []
          }
        ]
      })
    })

    // 中间目录依然保持收起
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

    render(
      <MemoryRouter initialEntries={["/p/3"]}>
        <TestNavApp targetPath="/p/5" label="跳转到子文档5" />
      </MemoryRouter>
    )

    expect(usePagesStore.getState().expanded).toContain(1)
    expect(usePagesStore.getState().expanded).toContain(2)
    expect(screen.getByText("嵌套文档")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "跳转到子文档5" }))

    expect(usePagesStore.getState().expanded).toContain(4)
    expect(screen.getByText("另一个子文档")).toBeInTheDocument()
  })

  it("行内菜单下移触发乐观更新，同步失败时呈现错误提示并回滚", async () => {
    const user = userEvent.setup()
    const twoPages = [
      {
        id: 10,
        parentId: null,
        title: "首项页面",
        sortOrder: 0,
        updatedAt: "2026-11-25T00:00:00.000Z",
        children: []
      },
      {
        id: 20,
        parentId: null,
        title: "次项页面",
        sortOrder: 1,
        updatedAt: "2026-11-25T00:00:00.000Z",
        children: []
      }
    ]
    useSpacesStore.setState({
      spaces: [space("editor")],
      status: "ready",
      error: null,
      currentId: 1
    })
    usePagesStore.setState({
      tree: twoPages,
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })
    vi.mocked(pagesApi.move).mockRejectedValueOnce(
      new Error("网络异常，移动失败")
    )
    vi.mocked(pagesApi.tree).mockRejectedValueOnce(new Error("网络异常"))

    renderTree()

    // 打开首项页面的操作菜单并点击「下移」
    await user.click(
      screen.getByRole("button", { name: "页面「首项页面」操作" })
    )
    const moveDownItem = await screen.findByRole("menuitem", { name: "下移" })
    await user.click(moveDownItem)

    // 报错提示出现在界面上，并且页面树回滚到首项在前
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("网络异常，请稍后重试")
    expect(usePagesStore.getState().tree.map((p) => p.id)).toEqual([10, 20])
  })
})
