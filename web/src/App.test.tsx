import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { routes } from "@/App"
import { ApiError, type Me } from "@/lib/api"
import { useAuthStore } from "@/stores/auth"
import { usePagesStore } from "@/stores/pages"
import { useSetupGateStore } from "@/stores/setup"
import { DEFAULT_SITE_NAME, useSiteStore } from "@/stores/site"
import { useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    setupApi: { ...actual.setupApi, state: vi.fn(), run: vi.fn() },
    meApi: {
      ...actual.meApi,
      get: vi.fn(),
      sessions: vi.fn(),
      revokeSession: vi.fn()
    },
    pagesApi: { ...actual.pagesApi, tree: vi.fn(), get: vi.fn() },
    siteApi: { ...actual.siteApi, get: vi.fn() },
    searchApi: { ...actual.searchApi, query: vi.fn() },
    authApi: {
      ...actual.authApi,
      login: vi.fn(),
      verifyTotp: vi.fn(),
      config: vi.fn()
    },
    adminApi: { ...actual.adminApi, users: vi.fn(), settings: vi.fn() },
    spacesApi: { ...actual.spacesApi, list: vi.fn() }
  }
})

const { setupApi, meApi, pagesApi, adminApi, authApi, siteApi, spacesApi } =
  await import("@/lib/api")

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

function renderApp(initial = "/") {
  const router = createMemoryRouter(routes, { initialEntries: [initial] })
  return render(<RouterProvider router={router} />)
}

describe("路由守卫与初始化门", () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, status: "loading", restricted: false })
    usePagesStore.setState({ tree: [], loading: true, expanded: [] })
    // setup 状态在共享 store 里，用例之间必须复位，否则第二个用例不会再拉
    useSetupGateStore.setState({ state: null, loading: false })
    useSiteStore.setState({ name: DEFAULT_SITE_NAME, loaded: false })
    vi.mocked(siteApi.get).mockResolvedValue({ siteName: "Ciki" })
    vi.mocked(setupApi.state).mockResolvedValue({
      initialized: true,
      enabled: true
    })
    vi.mocked(pagesApi.tree).mockResolvedValue([])
    vi.mocked(adminApi.users).mockResolvedValue([])
    vi.mocked(adminApi.settings).mockResolvedValue({
      siteName: "Ciki",
      setupPageEnabled: false,
      registrationEnabled: true,
      registrationApprovalRequired: true,
      require2fa: false,
      emailConfigured: false,
      revisionRetentionLimit: null
    })
    vi.mocked(meApi.sessions).mockResolvedValue([])
    useSpacesStore.setState({
      spaces: [
        {
          id: "space-default",
          name: "默认空间",
          description: "",
          myRole: "editor",
          isDefault: true,
          createdAt: "2026-11-08T00:00:00.000Z",
          updatedAt: "2026-11-08T00:00:00.000Z"
        }
      ],
      status: "ready",
      error: null,
      currentId: "space-default"
    })
    vi.mocked(spacesApi.list).mockResolvedValue(
      useSpacesStore.getState().spaces
    )
  })

  it("未登录访问任意页面都会跳到登录页，页脚带构建版本号", async () => {
    vi.mocked(meApi.get).mockRejectedValue(new ApiError(401, "Unauthorized"))
    renderApp("/")

    expect(
      await screen.findByRole("heading", { name: "登录 Ciki" })
    ).toBeInTheDocument()
    expect(screen.getByText(/test-build/)).toBeInTheDocument()
  })

  it("数据库未初始化时一律进初始化页", async () => {
    vi.mocked(setupApi.state).mockResolvedValue({
      initialized: false,
      enabled: true
    })
    vi.mocked(meApi.get).mockRejectedValue(new ApiError(401, "Unauthorized"))
    renderApp("/settings")

    expect(
      await screen.findByRole("heading", { name: /Ciki 初始化/ })
    ).toBeInTheDocument()
  })

  it("初始化成功后可以直接去注册首个管理员，不会被重定向回 /setup", async () => {
    const user = userEvent.setup()
    vi.mocked(meApi.get).mockRejectedValue(new ApiError(401, "Unauthorized"))
    vi.mocked(setupApi.state)
      .mockResolvedValueOnce({ initialized: false, enabled: true })
      .mockResolvedValue({ initialized: true, enabled: false })
    vi.mocked(setupApi.run).mockResolvedValue({
      success: true,
      tablePrefix: "ciki_",
      migrations: [{ name: "schema_v1", status: "applied" }]
    })
    vi.mocked(authApi.config).mockResolvedValue({
      registrationEnabled: true,
      registrationApprovalRequired: true,
      siteName: "Ciki",
      emailConfigured: false
    })

    renderApp("/setup")
    await user.type(await screen.findByLabelText("SETUP_SECRET"), "s3cret")
    await user.click(screen.getByRole("button", { name: "初始化数据库" }))

    await user.click(
      await screen.findByRole("link", { name: "注册首个管理员账号" })
    )

    // 根门已经从共享 store 里拿到 initialized:true，不会再把人押回 /setup
    expect(
      await screen.findByRole("heading", { name: "注册 Ciki" })
    ).toBeInTheDocument()
  })

  it("站点名从公开配置读取，页签标题与登录标题同步", async () => {
    vi.mocked(siteApi.get).mockResolvedValue({ siteName: "团队知识库" })
    vi.mocked(meApi.get).mockRejectedValue(new ApiError(401, "Unauthorized"))
    renderApp("/")

    expect(
      await screen.findByRole("heading", { name: "登录 团队知识库" })
    ).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe("团队知识库"))
  })

  it("已登录且没有页面时，首页给新建入口", async () => {
    vi.mocked(meApi.get).mockResolvedValue(admin)
    renderApp("/")

    // 侧边栏空状态与首页空状态各一处
    expect((await screen.findAllByText("还没有页面")).length).toBeGreaterThan(0)
    expect(
      screen.getAllByRole("button", { name: /新建页面/ }).length
    ).toBeGreaterThan(0)
  })

  it("非管理员访问 /admin 会被送回首页", async () => {
    vi.mocked(meApi.get).mockResolvedValue(member)
    renderApp("/admin")

    expect((await screen.findAllByText("还没有页面")).length).toBeGreaterThan(0)
    expect(screen.queryByRole("heading", { name: "系统管理" })).toBeNull()
  })

  it("管理员可以进入系统管理页", async () => {
    vi.mocked(meApi.get).mockResolvedValue(admin)
    renderApp("/admin")

    expect(
      await screen.findByRole("heading", { name: "系统管理" })
    ).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "用户管理" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "空间总览" })).toBeInTheDocument()
    // 定版 §4：页面级「登录与注册」说明卡、页头副标题与回收站链接都不再出现
    expect(screen.queryByText("登录与注册")).toBeNull()
    expect(screen.queryByText(/站点级设置仅管理员可见/)).toBeNull()
    expect(screen.queryByRole("link", { name: /回收站/ })).toBeNull()
  })
})
