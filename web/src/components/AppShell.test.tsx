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
  twofa: {
    totpEnabled: false,
    passkeyEnabled: false,
    passkeyCount: 0,
    emailOtpEnabled: false
  }
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

describe("应用外壳：顶栏、账号菜单、侧栏与正文宽度", () => {
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

  it("桌面普通页的搜索框落在正文那一栏，左缘与正文左缘同一条基线", () => {
    const { container, unmount } = renderShell("/p/a")
    // 顶栏按两栏拆开：站点名在侧栏栏顶部，搜索框行只在正文栏
    const searchHeader = container.querySelector("header")
    expect(searchHeader).not.toBeNull()
    // 搜索框前面不再有站点名/品牌块：左缘就是这一栏的左内边距
    expect(searchHeader?.firstElementChild?.tagName).toBe("FORM")
    expect(searchHeader?.querySelector('a[href="/"]')).toBeNull()
    // 左内边距与 PageCanvas 同口径（手机 16px、≥640px 24px）——正文左缘的那条线
    expect(searchHeader).toHaveClass("pl-4", "sm:pl-6")

    const brand = container.querySelector('a[href="/"]')
    expect(brand).not.toBeNull()
    expect(searchHeader?.contains(brand ?? null)).toBe(false)
    // 品牌行也在 48px 高的一条里，两栏的分隔线因此能连成一条
    expect(brand?.parentElement).toHaveClass("h-12", "px-2", "sm:px-3")
    unmount()

    // 系统页没有侧栏，仍是整条顶栏 + 顶栏里的搜索框
    const system = renderShell("/settings")
    const systemHeader = system.container.querySelector("header")
    expect(system.container.querySelectorAll("header")).toHaveLength(1)
    expect(systemHeader?.querySelector("form")).not.toBeNull()
    expect(systemHeader?.querySelector('a[href="/"]')).not.toBeNull()
  })

  it("移动端保持整条顶栏：没有搜索框，页面树走抽屉", () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia
    try {
      const { container } = renderShell("/p/a")
      expect(container.querySelectorAll("header")).toHaveLength(1)
      expect(container.querySelector("header form")).toBeNull()
      // 移动端没有侧栏那一栏，品牌回到同一条顶栏里
      expect(container.querySelector('header a[href="/"]')).not.toBeNull()
      expect(
        screen.getByRole("button", { name: "打开页面树" })
      ).toBeInTheDocument()
    } finally {
      window.matchMedia = original
    }
  })

  it("分类页容器不居中：左缘与文章页正文对齐，系统页仍居中", () => {
    const search = renderShell("/search")
    // 壳层容器是 Suspense 之外的第一个 div（Suspense 不产 DOM）
    const searchWrapper = screen.getByText("页面内容").parentElement
    expect(searchWrapper).toHaveClass("px-4", "sm:px-6", "max-w-[1140px]")
    expect(searchWrapper).not.toHaveClass("mx-auto")
    search.unmount()

    renderShell("/settings")
    const systemWrapper = screen.getByText("页面内容").parentElement
    expect(systemWrapper).toHaveClass("mx-auto", "max-w-[1400px]")
  })

  it("文章页读、写两态共用同一流式正文画布，系统页不套用", () => {
    const read = renderShell("/p/a")
    const readCanvas = read.container.querySelector("[data-page-canvas]")
    expect(readCanvas).not.toBeNull()
    expect(readCanvas).toHaveClass("mx-auto", "max-w-[1600px]")
    // 桌面边距 24px（与系统页容器同口径）：不留 lg:px-12 的 48px 特例
    expect(readCanvas?.parentElement).toHaveClass("px-4", "sm:px-6")
    expect(readCanvas?.parentElement).not.toHaveClass("lg:px-12")
    // 壳层不再给正文套 1140px 上限，否则正文到不了 1600px 封顶
    expect(readCanvas?.parentElement).not.toHaveClass("max-w-[1140px]")
    read.unmount()

    const write = renderShell("/p/a/edit")
    const writeCanvas = write.container.querySelector("[data-page-canvas]")
    expect(writeCanvas).not.toBeNull()
    expect(writeCanvas?.className).toBe(readCanvas?.className)
    write.unmount()

    const settings = renderShell("/settings")
    expect(settings.container.querySelector("[data-page-canvas]")).toBeNull()
  })
})
