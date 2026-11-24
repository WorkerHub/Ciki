import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AppShell } from "@/components/AppShell"
import { i18n } from "@/i18n"
import type { Me, Space } from "@/lib/api"
import { buildVersionLabel } from "@/lib/build-info"
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
  id: 1,
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
  id: 2,
  username: "成员",
  email: "member@example.com",
  role: "user"
}

const defaultSpace: Space = {
  id: 1,
  slug: "default",
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
function openAccountMenu(name = "账号菜单") {
  const trigger = screen.getByRole("button", { name })
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
      currentId: 1
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

  it("侧边栏页脚是「站名 · semver · 短哈希+build.提交数」三段式", () => {
    renderShell("/")
    expect(screen.getByText(buildVersionLabel("Ciki"))).toBeInTheDocument()
  })

  it("桌面普通页的搜索框落在正文那一栏，左缘与正文左缘同一条基线", () => {
    const { container, unmount } = renderShell("/p/a")
    // 顶栏按两栏拆开：站点名在侧栏栏顶部，搜索框行只在正文栏
    const searchHeader = container.querySelector("header")
    expect(searchHeader).not.toBeNull()
    // 搜索框前面不再有站点名/品牌块：包裹在与正文 PageCanvas 同口径的 max-w-[1600px] 居中容器内
    const searchHeaderInner = searchHeader?.firstElementChild as HTMLElement
    expect(searchHeaderInner).toHaveClass("mx-auto", "max-w-[1600px]")
    expect(searchHeaderInner?.firstElementChild?.tagName).toBe("FORM")
    expect(searchHeader?.querySelector('a[href="/"]')).toBeNull()
    // 外层边距与 PageCanvas 同口径（手机 16px、≥640px 24px）
    expect(searchHeader).toHaveClass("px-4", "sm:px-6")

    const brand = container.querySelector('a[href="/"]')
    expect(brand).not.toBeNull()
    expect(searchHeader?.contains(brand ?? null)).toBe(false)
    // 品牌行也在 48px 高的一条里，两栏的分隔线因此能连成一条
    expect(brand?.parentElement).toHaveClass("h-12", "px-2", "sm:px-3")
    unmount()

    // 系统页没有侧栏，整条顶栏不显示搜索框与新建按钮；
    // 顶栏全宽、logo 左上角顶头（不设 260px 预留区），「返回文档」移入正文列顶部第一行
    const system = renderShell("/settings")
    const systemHeader = system.container.querySelector("header")
    expect(system.container.querySelectorAll("header")).toHaveLength(1)
    expect(systemHeader?.querySelector("form")).toBeNull()
    expect(
      within(systemHeader!).queryByRole("button", { name: "新建页面" })
    ).toBeNull()

    // 顶栏中不包含「返回文档」（已移入正文列），包含左上角顶头品牌
    expect(
      within(systemHeader!).queryByRole("link", { name: "返回文档" })
    ).toBeNull()
    const systemBrand = systemHeader?.querySelector('a[href="/"]')
    expect(systemBrand).not.toBeNull()
    expect(systemBrand?.parentElement).not.toHaveClass("w-[260px]")
    expect(systemBrand?.parentElement).toHaveClass("px-2", "sm:px-3")

    // 「返回文档」移入正文列，作为正文列顶部第一行
    const backButton = screen.getByRole("link", { name: "返回文档" })
    expect(backButton).toHaveAttribute("href", "/")
    const systemWrapper = screen.getByText("页面内容").parentElement
    expect(systemWrapper).toHaveClass("max-w-[1400px]", "mx-auto")
    expect(systemWrapper).not.toHaveClass("ml-[260px]")
    expect(systemWrapper?.contains(backButton)).toBe(true)
  })

  it("移动端保持整条顶栏：没有搜索框，页面树走抽屉，抽屉内不包含收起侧栏按钮", () => {
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
      const openDrawerBtn = screen.getByRole("button", { name: "打开页面树" })
      expect(openDrawerBtn).toBeInTheDocument()

      // 打开抽屉
      fireEvent.click(openDrawerBtn)
      // 抽屉内不应该有收起侧边栏按钮
      expect(screen.queryByRole("button", { name: "收起侧边栏" })).toBeNull()
    } finally {
      window.matchMedia = original
    }
  })

  it("移动端抽屉头部为关闭按钮预留空间且桌面端侧栏无多余留白", async () => {
    const { unmount } = renderShell("/p/a")
    const desktopSwitcher = screen.getByRole("button", { name: "切换空间" })
    const desktopHeader = desktopSwitcher.closest(".border-b")
    expect(desktopHeader).not.toHaveClass("pr-10")
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull()
    unmount()

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
      const mobile = renderShell("/p/a")
      const openDrawerBtn = screen.getByRole("button", { name: "打开页面树" })
      fireEvent.click(openDrawerBtn)

      const closeButtons = screen.getAllByRole("button", { name: "Close" })
      expect(closeButtons).toHaveLength(1)

      const mobileSwitcher = screen.getByRole("button", { name: "切换空间" })
      const mobileHeader = mobileSwitcher.closest(".border-b")
      expect(mobileHeader).toHaveClass("pr-10")

      fireEvent.click(closeButtons[0])
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull()
      })
      mobile.unmount()
    } finally {
      window.matchMedia = original
    }
  })

  it("分类页容器不居中：左缘与文章页正文对齐，系统页正文列流式居中", () => {
    const search = renderShell("/s/default/search")
    // 壳层容器是 Suspense 之外的第一个 div（Suspense 不产 DOM）
    const searchWrapper = screen.getByText("页面内容").parentElement
    expect(searchWrapper).toHaveClass("px-4", "sm:px-6", "max-w-[1140px]")
    expect(searchWrapper).not.toHaveClass("mx-auto")

    // 分类页顶栏内层不居中，保持 px-4 sm:px-6 左对齐，与正文内容列左缘一致
    const searchHeader = search.container.querySelector("header")
    const searchHeaderInner = searchHeader?.firstElementChild as HTMLElement
    expect(searchHeaderInner).not.toHaveClass("mx-auto")
    expect(searchHeaderInner).not.toHaveClass("max-w-[1600px]")
    expect(searchHeader).toHaveClass("px-4", "sm:px-6")
    search.unmount()

    renderShell("/settings")
    const systemWrapper = screen.getByText("页面内容").parentElement
    expect(systemWrapper).toHaveClass("max-w-[1400px]", "mx-auto")
    expect(systemWrapper).not.toHaveClass("ml-[260px]")
    expect(systemWrapper?.style.width).toMatch(
      /min\(1400px,\s*(calc\()?100%\s*-\s*\(?2\s*\*\s*max\(16px,\s*3\.7vw\)\)?\)/
    )
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

  it("桌面普通页侧栏底部带有收起按钮，点击收起后左下角显示展开按钮并持久化", async () => {
    localStorage.clear()
    const { container, unmount } = renderShell("/p/a")

    const collapseButton = screen.getByRole("button", { name: "收起侧边栏" })
    expect(collapseButton).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "展开侧边栏" })).toBeNull()

    // 收起按钮位于侧栏底部（footer），旁边有版本信息，侧栏顶部没有收起按钮
    const brand = container.querySelector('a[href="/"]')
    expect(brand?.parentElement?.contains(collapseButton)).toBe(false)
    const footer = collapseButton.closest("div")
    expect(footer).toHaveTextContent(/Ciki/)

    // 点击收起
    fireEvent.click(collapseButton)

    // 收起后：展示图标列（填充 48px 面板宽度），左下角页脚放置展开按钮；
    // 48px 图标列物理上无法并排横向容纳长版本号，版本号通过 sr-only 与外层 title 保持可访问性
    const expandButton = await screen.findByRole("button", {
      name: "展开侧边栏"
    })
    expect(expandButton).toBeInTheDocument()
    const iconColumn = container.querySelector("[data-sidebar-collapsed]")
    expect(iconColumn).not.toBeNull()
    expect(iconColumn).toHaveClass("w-full")
    expect(iconColumn?.querySelector('a[href="/"]')).not.toBeNull()
    expect(iconColumn?.querySelector("[data-space-switcher]")).not.toBeNull()
    expect(screen.queryByText("页面")).toBeNull()

    const mainHeader = container.querySelector("header")
    expect(mainHeader?.contains(expandButton)).toBe(false)
    const collapsedFooter = expandButton.closest("div")
    expect(collapsedFooter).toHaveClass("border-t")
    expect(collapsedFooter?.getAttribute("title")).toMatch(/Ciki/)
    expect(collapsedFooter?.querySelector(".sr-only")).toHaveTextContent(/Ciki/)
    expect(localStorage.getItem("app-sidebar-open")).toBe("false")

    // 点击展开
    fireEvent.click(expandButton)
    expect(
      await screen.findByRole("button", { name: "收起侧边栏" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "展开侧边栏" })).toBeNull()
    expect(localStorage.getItem("app-sidebar-open")).toBe("true")
    unmount()
  })

  it("当 localStorage 中 app-sidebar-open 为 false 时，默认初始化为收起态", async () => {
    localStorage.setItem("app-sidebar-open", "false")
    const { container, unmount } = renderShell("/p/a")

    expect(
      await screen.findByRole("button", { name: "展开侧边栏" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "收起侧边栏" })).toBeNull()
    const iconColumn = container.querySelector("[data-sidebar-collapsed]")
    expect(iconColumn).not.toBeNull()
    expect(iconColumn).toHaveClass("w-full")
    unmount()
  })

  it("顶栏与正文列同口径统一对齐（px-4 sm:px-6 + max-w-[1600px]），展开与收起态均对齐", async () => {
    localStorage.clear()
    const { container, unmount } = renderShell("/p/a")
    const header = container.querySelector("header")
    expect(header).toHaveClass("px-4", "sm:px-6")
    const headerInner = header?.firstElementChild as HTMLElement
    expect(headerInner).toHaveClass("mx-auto", "max-w-[1600px]")

    const collapseButton = screen.getByRole("button", { name: "收起侧边栏" })
    fireEvent.click(collapseButton)
    await screen.findByRole("button", { name: "展开侧边栏" })

    // 收起态下顶栏布局与内边距依旧保持与正文完全一致
    expect(header).toHaveClass("px-4", "sm:px-6")
    expect(headerInner).toHaveClass("mx-auto", "max-w-[1600px]")
    unmount()
  })

  it("收起态进入系统页再点返回，侧栏回到 48px 图标列而不是被撑成展开宽度", async () => {
    localStorage.clear()
    const router = createMemoryRouter(
      [
        {
          element: <AppShell />,
          children: [
            { path: "p/:id", element: <div>页面内容</div> },
            { path: "settings", element: <div>设置内容</div> },
            { path: "*", element: <div>页面内容</div> }
          ]
        }
      ],
      { initialEntries: ["/p/a"] }
    )
    const { container, unmount } = render(<RouterProvider router={router} />)

    // 收起侧栏
    fireEvent.click(screen.getByRole("button", { name: "收起侧边栏" }))
    await screen.findByRole("button", { name: "展开侧边栏" })
    expect(container.querySelector("[data-sidebar-collapsed]")).not.toBeNull()

    // 进入系统页：Group/Panel 整树卸载
    router.navigate("/settings")
    await screen.findByText("设置内容")
    expect(container.querySelector("[data-sidebar-collapsed]")).toBeNull()

    // 点「返回文档」回到文档页：Panel 重挂载，同步 effect 应立即把它收回去
    fireEvent.click(screen.getByRole("link", { name: "返回文档" }))
    await waitFor(() =>
      expect(container.querySelector("[data-sidebar-collapsed]")).not.toBeNull()
    )
    // 收起态图标列仍在，且没有被重新展开出页面树
    expect(screen.queryByText("页面树")).toBeNull()
    expect(
      screen.getByRole("button", { name: "展开侧边栏" })
    ).toBeInTheDocument()
    expect(localStorage.getItem("app-sidebar-open")).toBe("false")
    unmount()
  })

  it("返回文档：回到进入系统页前最近访问的文档路由，系统页互跳不覆盖来源", async () => {
    localStorage.clear()
    const router = createMemoryRouter(
      [
        {
          element: <AppShell />,
          children: [
            { path: "p/:id", element: <div>页面内容</div> },
            { path: "s/:slug", element: <div>页面内容</div> },
            { path: "settings", element: <div>设置内容</div> },
            { path: "admin", element: <div>管理内容</div> }
          ]
        }
      ],
      { initialEntries: ["/p/7"] }
    )
    const { unmount } = render(<RouterProvider router={router} />)

    // 进入系统页前在 /p/7；设置 → 系统管理 → 设置 来回切不覆盖来源
    router.navigate("/settings")
    await screen.findByText("设置内容")
    router.navigate("/admin")
    await screen.findByText("管理内容")
    expect(screen.getByRole("link", { name: "返回文档" })).toHaveAttribute(
      "href",
      "/p/7"
    )

    fireEvent.click(screen.getByRole("link", { name: "返回文档" }))
    expect(router.state.location.pathname).toBe("/p/7")
    unmount()
  })

  it("直接打开系统页（刷新场景）时，返回文档回退首页「/」", () => {
    const { unmount } = renderShell("/settings")
    expect(screen.getByRole("link", { name: "返回文档" })).toHaveAttribute(
      "href",
      "/"
    )
    unmount()
  })

  it("系统页顶栏全宽、logo 顶头，「返回文档」移入正文列顶部第一行，正文列流式居中", () => {
    // 桌面态
    const desktop = renderShell("/settings")
    const desktopHeader = desktop.container.querySelector("header")
    const brand = desktopHeader?.querySelector('a[href="/"]')
    expect(brand).not.toBeNull()
    expect(brand?.parentElement).not.toHaveClass("w-[260px]")
    expect(brand?.parentElement).not.toHaveClass("absolute")
    expect(brand?.parentElement).toHaveClass("px-2", "sm:px-3")

    // 顶栏不再包含「返回文档」
    expect(
      within(desktopHeader!).queryByRole("link", { name: "返回文档" })
    ).toBeNull()

    // 「返回文档」移入正文列顶部
    const backButton = screen.getByRole("link", { name: "返回文档" })
    const desktopSystemWrapper = screen.getByText("页面内容").parentElement
    expect(desktopSystemWrapper?.contains(backButton)).toBe(true)
    expect(desktopSystemWrapper).toHaveClass("max-w-[1400px]", "mx-auto")
    expect(desktopSystemWrapper).not.toHaveClass("ml-[260px]")
    expect(desktopSystemWrapper?.style.width).toMatch(
      /min\(1400px,\s*(calc\()?100%\s*-\s*\(?2\s*\*\s*max\(16px,\s*3\.7vw\)\)?\)/
    )
    desktop.unmount()

    // 移动端态
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
      const mobile = renderShell("/settings")
      const mobileHeader = mobile.container.querySelector("header")
      const mobileBrand = mobileHeader?.querySelector('a[href="/"]')
      expect(mobileBrand?.parentElement).not.toHaveClass("w-[260px]")
      expect(mobileBrand?.parentElement).toHaveClass("px-2", "sm:px-3")
      const mobileSystemWrapper = screen.getByText("页面内容").parentElement
      expect(mobileSystemWrapper).toHaveClass("mx-auto", "max-w-[1400px]")
      expect(mobileSystemWrapper).not.toHaveClass("ml-[260px]")
      expect(mobileSystemWrapper?.style.width).toMatch(
        /min\(1400px,\s*(calc\()?100%\s*-\s*\(?2\s*\*\s*max\(16px,\s*3\.7vw\)\)?\)/
      )
      mobile.unmount()
    } finally {
      window.matchMedia = original
    }
  })

  it("/users 路由归入系统页：无侧栏、正文列顶部含「返回文档」按钮、移动端无抽屉入口", async () => {
    // 1. 直达 /users/1：无侧栏，正文列流式居中，「返回文档」回退「/」
    const { container, unmount } = renderShell("/users/1")
    expect(container.querySelector("[data-sidebar-collapsed]")).toBeNull()
    expect(container.querySelector("#sidebar")).toBeNull()
    const backButton = screen.getByRole("link", { name: "返回文档" })
    expect(backButton).toBeInTheDocument()
    expect(backButton).toHaveAttribute("href", "/")
    const systemWrapper = screen.getByText("页面内容").parentElement
    expect(systemWrapper).toHaveClass("max-w-[1400px]", "mx-auto")
    expect(systemWrapper?.contains(backButton)).toBe(true)
    unmount()

    // 2. 从文档页 /p/101 进入 /users/1：「返回文档」按钮返回 /p/101
    const router = createMemoryRouter(
      [
        {
          element: <AppShell />,
          children: [
            { path: "p/:id", element: <div>文档内容</div> },
            { path: "users/:id", element: <div>作者主页内容</div> }
          ]
        }
      ],
      { initialEntries: ["/p/101"] }
    )
    const routed = render(<RouterProvider router={router} />)
    router.navigate("/users/1")
    await screen.findByText("作者主页内容")
    const dynamicBackButton = screen.getByRole("link", { name: "返回文档" })
    expect(dynamicBackButton).toHaveAttribute("href", "/p/101")
    routed.unmount()

    // 3. 移动端：无抽屉菜单入口
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
      const mobile = renderShell("/users/1")
      expect(screen.queryByRole("button", { name: "打开页面树" })).toBeNull()
      mobile.unmount()
    } finally {
      window.matchMedia = original
    }
  })
})

/** 英文界面：外壳与导航文案全走 locale，中文一个字都不留。 */
describe("应用外壳：英文界面", () => {
  beforeEach(async () => {
    useAuthStore.setState({ user: admin, status: "ready", restricted: false })
    usePagesStore.setState({ tree: [], loading: false, expanded: [] })
    useSiteStore.setState({ name: "Ciki", loaded: true })
    useSpacesStore.setState({
      spaces: [defaultSpace],
      status: "ready",
      error: null,
      currentId: 1
    })
    vi.mocked(pagesApi.tree).mockResolvedValue([])
    vi.mocked(spacesApi.list).mockResolvedValue([defaultSpace])
    await i18n.changeLanguage("en")
  })

  it("侧栏、搜索框与账号菜单都用英文，菜单入口一个不少", async () => {
    renderShell("/")

    expect(await screen.findByText("Pages")).toBeInTheDocument()
    expect(
      screen.getByPlaceholderText("Search titles and content…")
    ).toBeInTheDocument()
    expect(
      screen.getAllByRole("button", { name: "New page" }).length
    ).toBeGreaterThan(0)
    expect(
      screen.getByRole("button", {
        name: "Theme: Auto (follow system). Click to switch."
      })
    ).toBeInTheDocument()

    openAccountMenu("Account menu")
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((item) => item.textContent)).toEqual([
      "Profile",
      "Admin",
      "Trash",
      "Settings",
      "About",
      "Help",
      "Sign out"
    ])
  })

  it("侧栏收起与展开按钮使用英文文案", async () => {
    localStorage.clear()
    const { unmount } = renderShell("/p/abc")

    const collapseButton = await screen.findByRole("button", {
      name: "Collapse sidebar"
    })
    expect(collapseButton).toBeInTheDocument()

    fireEvent.click(collapseButton)
    expect(
      await screen.findByRole("button", { name: "Expand sidebar" })
    ).toBeInTheDocument()
    unmount()
  })

  it("系统页面显示 Back to documents 按钮而不显示搜索框与新建页面", async () => {
    const { container } = renderShell("/settings")
    expect(container.querySelector("form")).toBeNull()
    expect(
      screen.getByRole("link", { name: "Back to documents" })
    ).toHaveAttribute("href", "/")
    expect(screen.queryByRole("button", { name: "New page" })).toBeNull()
  })

  it("空间切换器与页面空态也是英文", async () => {
    renderShell("/p/abc")

    expect(
      await screen.findByRole("button", { name: "Switch space" })
    ).toBeInTheDocument()
    // 空树提示随语言走（空间名是用户数据，不翻译）
    expect(await screen.findByText(/No pages in/)).toBeInTheDocument()
  })

  it("桌面端主内容与侧栏 Panel 显式覆盖 overflow 为 hidden，杜绝双滚动条与底部空白泄漏", async () => {
    const { container } = renderShell("/p/abc")

    const mainPanel = container.querySelector("#main")
    expect(mainPanel).toBeInTheDocument()

    // react-resizable-panels 为 Panel 生成直接 wrapper 子节点并注入 inline style
    const mainWrapper = mainPanel?.firstElementChild as HTMLElement | null
    expect(mainWrapper).not.toBeNull()
    expect(mainWrapper?.style.overflow).toBe("hidden")

    // 主内容列顶层容器显式包含 overflow-hidden，防止高度穿透
    const flexCol = mainWrapper?.firstElementChild as HTMLElement | null
    expect(flexCol).toHaveClass("overflow-hidden")

    const sidebarPanel = container.querySelector("#sidebar")
    const sidebarWrapper = sidebarPanel?.firstElementChild as HTMLElement | null
    expect(sidebarWrapper?.style.overflow).toBe("hidden")
  })

  it("移动端与系统页外壳容器显式设置 overflow-hidden 与 relative，杜绝高度外溢到 html 导致整屏空白", () => {
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
      const { container } = renderShell("/p/abc")

      // 顶层根容器显式包含 overflow-hidden，防止应用根节点被整体推移
      const rootShell = container.querySelector(".h-svh")
      expect(rootShell).toHaveClass("overflow-hidden")

      // 移动端主内容包裹层包含 relative 与 overflow-hidden，为内部绝对定位节点建立包含块并限制滚动外溢
      const header = container.querySelector("header")
      const mobileWrapper = header?.parentElement
      expect(mobileWrapper).toHaveClass(
        "relative",
        "flex",
        "min-h-0",
        "flex-1",
        "flex-col",
        "overflow-hidden"
      )

      const scroller = mobileWrapper?.querySelector(".overflow-y-auto")
      expect(scroller).toBeInTheDocument()
    } finally {
      window.matchMedia = original
    }
  })
})
