import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AppShell } from "@/components/AppShell"
import type { Me } from "@/lib/api"
import { useAuthStore } from "@/stores/auth"
import { usePagesStore } from "@/stores/pages"
import { useSiteStore } from "@/stores/site"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    pagesApi: { ...actual.pagesApi, tree: vi.fn(), get: vi.fn() }
  }
})

const { pagesApi } = await import("@/lib/api")

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
    vi.mocked(pagesApi.tree).mockResolvedValue([])
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

    // 用户信息区（邮箱小字）+ 六个入口 + 红色退出
    expect(await screen.findByText("admin@example.com")).toBeInTheDocument()
    for (const label of ["个人资料", "设置", "回收站", "关于", "系统管理"]) {
      expect(
        await screen.findByRole("menuitem", { name: label })
      ).toBeInTheDocument()
    }
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
  })

  it("帮助入口在菜单里，点开是原来的帮助弹窗", async () => {
    const user = userEvent.setup()
    renderShell("/")

    openAccountMenu()
    await user.click(await screen.findByRole("menuitem", { name: "帮助" }))

    expect(await screen.findByText("粘贴与编辑说明")).toBeInTheDocument()
  })

  it("系统页不渲染页面树侧栏，普通页侧栏照旧", () => {
    const { unmount } = renderShell("/settings")
    expect(screen.queryByText("页面")).toBeNull()
    unmount()

    renderShell("/p/abc")
    expect(screen.getByText("页面")).toBeInTheDocument()
  })
})
