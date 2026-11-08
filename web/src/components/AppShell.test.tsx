import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AppShell } from "@/components/AppShell"
import type { Me, Space } from "@/lib/api"
import { useAuthStore } from "@/stores/auth"
import { usePagesStore } from "@/stores/pages"
import { useSiteStore } from "@/stores/site"
import { useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    pagesApi: { ...actual.pagesApi, tree: vi.fn(), get: vi.fn() },
    spacesApi: { ...actual.spacesApi, list: vi.fn() }
  }
})

const { pagesApi, spacesApi } = await import("@/lib/api")

const admin: Me = {
  id: "u1",
  publicId: "AB23CD45",
  username: "管理员",
  avatarUrl: null,
  email: "admin@example.com",
  role: "admin",
  approvalStatus: "approved",
  createdAt: "2026-11-07T00:00:00.000Z",
  twofa: { totpEnabled: false, passkeyEnabled: false, passkeyCount: 0 }
}

const member: Me = {
  ...admin,
  id: "u2",
  publicId: "EF45GH67",
  username: "成员",
  email: "member@example.com",
  role: "user"
}

const defaultSpace: Space = {
  id: "space-default",
  name: "默认空间",
  description: "",
  myRole: "editor",
  isDefault: true,
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z"
}

/**
 * 打开账号菜单。jsdom 没有布局，pointerdown 默认落在 (0,0) 会被
 * react-resizable-panels 的全局命中测试吃掉；指到顶栏坐标即可走真实点击路径。
 */
function openAccountMenu() {
  const trigger = screen.getByRole("button", { name: "账号菜单" })
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    clientX: 700,
    clientY: 20
  })
  return trigger
}

function renderShell(path: string) {
  const router = createMemoryRouter(
    [
      {
        element: <AppShell />,
        children: [{ path: "*", element: <div>页面内容</div> }]
      }
    ],
    { initialEntries: [path] }
  )
  return render(<RouterProvider router={router} />)
}

describe("顶栏、头像菜单与系统页侧栏", () => {
  beforeEach(() => {
    useAuthStore.setState({ user: admin, status: "ready", restricted: false })
    usePagesStore.setState({ tree: [], loading: false, expanded: [] })
    useSiteStore.setState({ name: "Ciki", loaded: true })
    useSpacesStore.setState({
      spaces: [defaultSpace],
      status: "ready",
      error: null,
      currentId: "space-default"
    })
    vi.mocked(pagesApi.tree).mockResolvedValue([])
    vi.mocked(spacesApi.list).mockResolvedValue([defaultSpace])
  })

  it("账号菜单承载全部入口，顶栏显示头像+用户名而不是邮箱", async () => {
    useSiteStore.setState({ name: "团队知识库" })
    renderShell("/")

    // 品牌区是站点名；触发器是用户名，关闭状态下不出现邮箱
    expect(screen.getByRole("link", { name: "团队知识库" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "账号菜单" })).toHaveTextContent(
      "管理员"
    )
    expect(screen.queryByText("admin@example.com")).toBeNull()

    openAccountMenu()

    // 用户信息区（邮箱小字）+ 六个入口 + 红色退出，顺序固定
    expect(await screen.findByText("admin@example.com")).toBeInTheDocument()
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((item) => item.textContent)).toEqual([
      "个人资料",
      "系统管理",
      "回收站",
      "设置",
      "关于",
      "帮助",
      "退出登录"
    ])
    expect(screen.getByRole("menuitem", { name: "退出登录" })).toHaveAttribute(
      "data-variant",
      "destructive"
    )
  })

  it("非管理员看不到系统管理入口", async () => {
    useAuthStore.setState({ user: member, status: "ready", restricted: false })
    renderShell("/")

    openAccountMenu()
    expect(await screen.findByText("member@example.com")).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "系统管理" })).toBeNull()
    // 少了系统管理，其余顺序不变
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual(["个人资料", "回收站", "设置", "关于", "帮助", "退出登录"])
  })

  it("帮助入口在菜单里，点开是原来的帮助弹窗", async () => {
    const user = userEvent.setup()
    renderShell("/")

    openAccountMenu()
    await user.click(await screen.findByRole("menuitem", { name: "帮助" }))

    expect(await screen.findByText("粘贴与编辑说明")).toBeInTheDocument()
  })

  it("空间切换器只在普通页侧栏出现", async () => {
    const { unmount } = renderShell("/p/abc")
    expect(
      await screen.findByRole("button", { name: "切换空间" })
    ).toBeInTheDocument()
    unmount()

    renderShell("/settings")
    expect(screen.queryByRole("button", { name: "切换空间" })).toBeNull()
  })

  it("只读空间里顶栏与侧栏都不给新建页面入口", async () => {
    useAuthStore.setState({ user: member, status: "ready", restricted: false })
    const viewerSpace: Space = { ...defaultSpace, myRole: "viewer" }
    useSpacesStore.setState({ spaces: [viewerSpace] })
    vi.mocked(spacesApi.list).mockResolvedValue([viewerSpace])
    renderShell("/p/abc")

    expect(await screen.findByText("页面")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "新建页面" })).toBeNull()
  })

  it("系统页不渲染页面树侧栏，普通页侧栏照旧", async () => {
    const { unmount } = renderShell("/settings")
    expect(screen.queryByText("页面")).toBeNull()
    unmount()

    renderShell("/p/abc")
    expect(await screen.findByText("页面")).toBeInTheDocument()
  })
})
