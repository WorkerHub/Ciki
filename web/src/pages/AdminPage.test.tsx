import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Me, SiteSettings, SmtpSettings } from "@/lib/api"
import { AdminPage } from "@/pages/AdminPage"
import { useAuthStore } from "@/stores/auth"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      users: vi.fn(),
      settings: vi.fn(),
      smtp: vi.fn(),
      saveSmtp: vi.fn(),
      testSmtp: vi.fn(),
      r2Cleanup: vi.fn()
    }
  }
})

const { adminApi } = await import("@/lib/api")

const admin: Me = {
  id: "u-admin",
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

const settings: SiteSettings = {
  siteName: "Ciki",
  setupPageEnabled: false,
  registrationEnabled: true,
  registrationApprovalRequired: true,
  require2fa: false,
  emailConfigured: true,
  revisionRetentionLimit: null
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

describe("系统管理 · 页签", () => {
  beforeEach(() => {
    useAuthStore.setState({ user: admin, status: "ready", restricted: false })
    vi.mocked(adminApi.users).mockResolvedValue([])
    vi.mocked(adminApi.settings).mockResolvedValue(settings)
    vi.mocked(adminApi.smtp).mockResolvedValue({
      emailConfigured: true,
      config: smtp
    })
    vi.mocked(adminApi.r2Cleanup).mockResolvedValue({
      lastRun: null,
      running: null
    })
  })

  it("「邮件配置」页签切出 SMTP 表单", async () => {
    const user = userEvent.setup()
    render(<AdminPage />)

    const tab = await screen.findByRole("tab", { name: "邮件配置" })
    expect(tab).toBeInTheDocument()
    await user.click(tab)

    expect(await screen.findByLabelText("服务器地址")).toHaveValue(
      "smtp.example.com"
    )
    expect(adminApi.smtp).toHaveBeenCalledTimes(1)
  })
})
