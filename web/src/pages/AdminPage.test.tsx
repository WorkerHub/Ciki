import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, Navigate, RouterProvider } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import type { AdminStorage, Me, SiteSettings, SmtpSettings } from "@/lib/api"
import { AdminPage } from "@/pages/AdminPage"
import { OthersTab } from "@/pages/admin/OthersTab"
import { SecurityTab } from "@/pages/admin/SecurityTab"
import { SettingsTab } from "@/pages/admin/SettingsTab"
import { SmtpTab } from "@/pages/admin/SmtpTab"
import { SpacesTab } from "@/pages/admin/SpacesTab"
import { UsersTab } from "@/pages/admin/UsersTab"
import { useAuthStore } from "@/stores/auth"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      users: vi.fn(),
      spaces: vi.fn(),
      settings: vi.fn(),
      saveSettings: vi.fn(),
      updateSettings: vi.fn(),
      smtp: vi.fn(),
      saveSmtp: vi.fn(),
      testSmtp: vi.fn(),
      testEmail: vi.fn(),
      storage: vi.fn(),
      r2Cleanup: vi.fn(),
      runR2Cleanup: vi.fn()
    }
  }
})

const { adminApi } = await import("@/lib/api")

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

const settings: SiteSettings = {
  siteName: "Ciki",
  setupPageEnabled: false,
  registrationEnabled: true,
  registrationApprovalRequired: true,
  require2fa: false,
  emailConfigured: true,
  revisionRetentionLimit: null,
  email: {
    provider: "smtp",
    smtp: {
      host: "smtp.example.com",
      port: 465,
      encryption: "tls",
      username: "notify@example.com",
      from: "no-reply@example.com",
      fromName: "Ciki",
      passwordSet: true
    },
    resend: {
      from: "",
      fromName: "",
      apiKeySet: false
    },
    configured: true
  }
}

const smtp: SmtpSettings = {
  host: "smtp.example.com",
  port: 465,
  encryption: "tls",
  username: "notify@example.com",
  from: "no-reply@example.com",
  fromName: "Ciki",
  passwordSet: true
}

const storage: AdminStorage = {
  pageCount: 12,
  trashedPageCount: 3,
  revisionCount: 40,
  databaseSizeBytes: 3_565_158,
  assetsSizeBytes: 2_097_152,
  contentSizeBytes: 524_288,
  assetsObjectCount: 24,
  contentObjectCount: 40,
  sizeScope: "own-database",
  measure: "cloudflare-d1-api"
}

function renderAdmin(initialEntry = "/admin") {
  const router = createMemoryRouter(
    [
      {
        path: "admin",
        element: <AdminPage />,
        children: [
          { index: true, element: <Navigate to="/admin/users" replace /> },
          { path: "users", element: <UsersTab /> },
          { path: "spaces", element: <SpacesTab /> },
          { path: "site", element: <SettingsTab /> },
          { path: "security", element: <SecurityTab /> },
          { path: "email", element: <SmtpTab /> },
          { path: "others", element: <OthersTab /> }
        ]
      }
    ],
    { initialEntries: [initialEntry] }
  )
  return { ...render(<RouterProvider router={router} />), router }
}

describe("系统管理 · 真实路由子导航", () => {
  beforeEach(() => {
    useAuthStore.setState({ user: admin, status: "ready", restricted: false })
    vi.mocked(adminApi.users).mockResolvedValue([])
    vi.mocked(adminApi.spaces).mockResolvedValue([])
    vi.mocked(adminApi.settings).mockResolvedValue(settings)
    vi.mocked(adminApi.smtp).mockResolvedValue({
      emailConfigured: true,
      config: smtp
    })
    vi.mocked(adminApi.storage).mockResolvedValue(storage)
    vi.mocked(adminApi.r2Cleanup).mockResolvedValue({
      lastRun: null,
      running: null
    })
  })

  afterEach(async () => {
    await i18n.changeLanguage("zh")
  })

  it("访问 /admin 自动重定向至 /admin/users 且激活用户管理", async () => {
    const { router } = renderAdmin("/admin")
    expect(router.state.location.pathname).toBe("/admin/users")

    const usersLink = screen.getByRole("link", { name: "用户管理" })
    expect(usersLink).toBeInTheDocument()
    expect(usersLink).toHaveAttribute("href", "/admin/users")
    expect(usersLink.className).toContain("bg-background")

    expect(
      await screen.findByRole("button", { name: "新建用户" })
    ).toBeInTheDocument()
    expect(screen.getByText("还没有用户。")).toBeInTheDocument()
  })

  it("用户列表中正确展示 Agent 徽标", async () => {
    vi.mocked(adminApi.users).mockResolvedValue([
      {
        id: 2,
        email: "agent-bot@internal",
        role: "user",
        isActive: true,
        approvalStatus: "approved",
        isAgent: true,
        kind: "agent",
        ownerUserId: 1,
        owner: { id: 1, username: "管理员" },
        createdAt: "2026-11-08T00:00:00.000Z"
      }
    ])
    renderAdmin("/admin/users")

    expect(await screen.findByText("agent-bot@internal")).toBeInTheDocument()
    expect(screen.getByText("Agent")).toBeInTheDocument()
  })

  it("用户列表中带有 ownerName 时呈现「{agent}（{owner} 的 Agent）」且不展示 Agent 徽标", async () => {
    vi.mocked(adminApi.users).mockResolvedValue([
      {
        id: 2,
        email: "agent-bot@internal",
        role: "user",
        isActive: true,
        approvalStatus: "approved",
        isAgent: true,
        kind: "agent",
        ownerUserId: 1,
        owner: { id: 1, username: "管理员" },
        ownerName: "管理员",
        createdAt: "2026-11-08T00:00:00.000Z"
      }
    ])
    renderAdmin("/admin/users")

    expect(
      await screen.findByText("agent-bot@internal（管理员 的 Agent）")
    ).toBeInTheDocument()
    expect(screen.queryByText("Agent")).toBeNull()
  })

  it("渲染全部六个分区子导航链接并指向对应绝对路径", () => {
    renderAdmin("/admin/users")

    expect(screen.getByRole("link", { name: "用户管理" })).toHaveAttribute(
      "href",
      "/admin/users"
    )
    expect(screen.getByRole("link", { name: "空间总览" })).toHaveAttribute(
      "href",
      "/admin/spaces"
    )
    expect(screen.getByRole("link", { name: "应用设置" })).toHaveAttribute(
      "href",
      "/admin/site"
    )
    expect(screen.getByRole("link", { name: "访问与安全" })).toHaveAttribute(
      "href",
      "/admin/security"
    )
    expect(screen.getByRole("link", { name: "邮件配置" })).toHaveAttribute(
      "href",
      "/admin/email"
    )
    expect(screen.getByRole("link", { name: "其他" })).toHaveAttribute(
      "href",
      "/admin/others"
    )
  })

  it("点击子导航链接可切换路由、更新激活态并装载对应分区", async () => {
    const user = userEvent.setup()
    const { router } = renderAdmin("/admin/users")

    const emailLink = screen.getByRole("link", { name: "邮件配置" })
    const usersLink = screen.getByRole("link", { name: "用户管理" })

    expect(usersLink.className).toContain("bg-background")
    expect(emailLink.className).not.toContain("bg-background")

    await user.click(emailLink)

    expect(router.state.location.pathname).toBe("/admin/email")
    expect(emailLink.className).toContain("bg-background")
    expect(usersLink.className).not.toContain("bg-background")

    expect(await screen.findByLabelText("服务器")).toHaveValue(
      "smtp.example.com"
    )
    expect(screen.getByText("邮件已配置")).toBeInTheDocument()
  })

  it("支持直达各个子分区路由且激活态正确", async () => {
    const { unmount: unmountSpaces } = renderAdmin("/admin/spaces")
    expect(screen.getByRole("link", { name: "空间总览" }).className).toContain(
      "bg-background"
    )
    expect(
      await screen.findByRole("heading", { level: 2, name: "空间总览" })
    ).toBeInTheDocument()
    unmountSpaces()

    const { unmount: unmountSite } = renderAdmin("/admin/site")
    expect(screen.getByRole("link", { name: "应用设置" }).className).toContain(
      "bg-background"
    )
    expect(await screen.findByLabelText("站点名称")).toHaveValue("Ciki")
    unmountSite()

    const { unmount: unmountSecurity } = renderAdmin("/admin/security")
    expect(
      screen.getByRole("link", { name: "访问与安全" }).className
    ).toContain("bg-background")
    expect(await screen.findByText("强制两步验证")).toBeInTheDocument()
    unmountSecurity()

    const { unmount: unmountOthers } = renderAdmin("/admin/others")
    expect(screen.getByRole("link", { name: "其他" }).className).toContain(
      "bg-background"
    )
    expect(await screen.findByText("开放初始化页面")).toBeInTheDocument()
    unmountOthers()
  })

  it("英文界面下页标题与六个分区链接正确渲染", async () => {
    await i18n.changeLanguage("en")
    renderAdmin("/admin/users")

    expect(await screen.findByText("Admin")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Users" })).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "Space overview" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "Site settings" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "Access & security" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "Email delivery" })
    ).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Others" })).toBeInTheDocument()

    // 默认落在「用户管理」分区
    expect(
      await screen.findByRole("button", { name: "New user" })
    ).toBeInTheDocument()
    expect(screen.getByText("No users yet.")).toBeInTheDocument()
  })
})
