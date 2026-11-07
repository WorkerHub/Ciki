import { render, screen } from "@testing-library/react"
import { createMemoryRouter, RouterProvider } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { routes } from "@/App"
import { ApiError, type Me } from "@/lib/api"
import { useAuthStore } from "@/stores/auth"
import { usePagesStore } from "@/stores/pages"

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
    searchApi: { ...actual.searchApi, query: vi.fn() },
    authApi: {
      ...actual.authApi,
      login: vi.fn(),
      verifyTotp: vi.fn(),
      config: vi.fn()
    },
    adminApi: { ...actual.adminApi, users: vi.fn(), settings: vi.fn() }
  }
})

const { setupApi, meApi, pagesApi, adminApi } = await import("@/lib/api")

const admin: Me = {
  id: "u1",
  email: "admin@example.com",
  role: "admin",
  approvalStatus: "approved",
  createdAt: "2026-11-07T00:00:00.000Z",
  twofa: { totpEnabled: false, passkeyEnabled: false, passkeyCount: 0 }
}

const member: Me = {
  ...admin,
  id: "u2",
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
    vi.mocked(setupApi.state).mockResolvedValue({
      initialized: true,
      enabled: true
    })
    vi.mocked(pagesApi.tree).mockResolvedValue([])
    vi.mocked(adminApi.users).mockResolvedValue([])
    vi.mocked(adminApi.settings).mockResolvedValue({
      setupPageEnabled: false,
      registrationEnabled: true,
      registrationApprovalRequired: true,
      require2fa: false
    })
    vi.mocked(meApi.sessions).mockResolvedValue([])
  })

  it("未登录访问任意页面都会跳到登录页，页脚带构建版本号", async () => {
    vi.mocked(meApi.get).mockRejectedValue(new ApiError(401, "Unauthorized"))
    renderApp("/")

    expect(
      await screen.findByRole("heading", { name: "登录 ciki" })
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
      await screen.findByRole("heading", { name: /ciki 初始化/ })
    ).toBeInTheDocument()
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
  })
})
