import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import { ApiError, type Me, type SiteSettings } from "@/lib/api"
import { SmtpTab } from "@/pages/admin/SmtpTab"
import { useAuthStore } from "@/stores/auth"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      settings: vi.fn(),
      updateSettings: vi.fn(),
      testEmail: vi.fn(),
      smtp: vi.fn()
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

function mockSettings(overrides: Partial<SiteSettings> = {}): SiteSettings {
  return {
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
        port: 587,
        encryption: "starttls",
        username: "mailer",
        from: "noreply@example.com",
        fromName: "Ciki",
        passwordSet: true
      },
      resend: {
        from: "",
        fromName: "",
        apiKeySet: false
      },
      configured: true
    },
    ...overrides
  }
}

describe("系统管理 · 邮件配置 (SmtpTab / EmailSection)", () => {
  beforeEach(() => {
    useAuthStore.setState({ user: admin, status: "ready", restricted: false })
    vi.mocked(adminApi.settings).mockReset()
    vi.mocked(adminApi.updateSettings).mockReset()
    vi.mocked(adminApi.testEmail).mockReset()
    vi.mocked(adminApi.settings).mockResolvedValue(mockSettings())
  })

  it("按契约回填 SMTP 字段，密码回显只给「已设置」而不回填明文", async () => {
    render(<SmtpTab />)

    expect(await screen.findByLabelText("服务器")).toHaveValue(
      "smtp.example.com"
    )
    expect(screen.getByLabelText("端口")).toHaveValue("587")
    expect(screen.getByLabelText("用户名")).toHaveValue("mailer")
    expect(screen.getByLabelText("发件地址")).toHaveValue("noreply@example.com")
    expect(screen.getByLabelText("发件人名称")).toHaveValue("Ciki")

    const password = screen.getByLabelText("密码")
    expect(password).toHaveValue("")
    expect(password).toHaveAttribute("placeholder", "已设置，留空表示不修改")

    expect(screen.getByText("邮件已配置")).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/secret/)
  })

  it("provider 为 none 时渲染未配置状态且不展示 SMTP / Resend 字段", async () => {
    vi.mocked(adminApi.settings).mockResolvedValue(
      mockSettings({
        email: {
          provider: "none",
          smtp: {
            host: "",
            port: 587,
            username: "",
            from: "",
            fromName: "",
            passwordSet: false
          },
          resend: {
            from: "",
            fromName: "",
            apiKeySet: false
          },
          configured: false
        }
      })
    )

    render(<SmtpTab />)

    expect(await screen.findByText("邮件未配置")).toBeInTheDocument()
    expect(screen.queryByLabelText("服务器")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument()
  })

  it("provider 为 resend 时渲染 Resend 配置，API Key 只显掩码", async () => {
    vi.mocked(adminApi.settings).mockResolvedValue(
      mockSettings({
        email: {
          provider: "resend",
          smtp: {
            host: "",
            port: 587,
            username: "",
            from: "",
            fromName: "",
            passwordSet: false
          },
          resend: {
            from: "noreply@resend.dev",
            fromName: "Ciki Resend",
            apiKeySet: true
          },
          configured: true
        }
      })
    )

    render(<SmtpTab />)

    const apiKey = await screen.findByLabelText("API Key")
    expect(apiKey).toHaveValue("")
    expect(apiKey).toHaveAttribute("placeholder", "已设置，留空表示不修改")
    expect(screen.getByLabelText("发件地址")).toHaveValue("noreply@resend.dev")
    expect(screen.getByLabelText("发件人名称")).toHaveValue("Ciki Resend")
    expect(screen.queryByLabelText("服务器")).not.toBeInTheDocument()
  })

  it("保存时密码留空＝不改，其它字段照常提交", async () => {
    vi.mocked(adminApi.updateSettings).mockResolvedValue({ success: true })

    const user = userEvent.setup()
    render(<SmtpTab />)

    await screen.findByLabelText("服务器")
    await user.click(screen.getByRole("button", { name: "保存邮件配置" }))

    expect(adminApi.updateSettings).toHaveBeenCalledWith({
      email: {
        provider: "smtp",
        smtp: {
          host: "smtp.example.com",
          port: 587,
          encryption: "starttls",
          username: "mailer",
          from: "noreply@example.com",
          fromName: "Ciki",
          password: ""
        },
        resend: {
          from: "",
          fromName: "",
          apiKey: ""
        }
      }
    })
  })

  it("加密方式下拉随表单提交，默认回填 starttls", async () => {
    vi.mocked(adminApi.updateSettings).mockResolvedValue({ success: true })

    const user = userEvent.setup()
    render(<SmtpTab />)

    await screen.findByLabelText("服务器")
    // 后端保存的是 starttls，回填成中文选项文案
    expect(
      screen.getByRole("combobox", { name: "加密方式" })
    ).toHaveTextContent("STARTTLS")

    // 改成 TLS 后保存，加密方式随表单一起提交
    await user.click(screen.getByRole("combobox", { name: "加密方式" }))
    await user.click(
      screen.getByRole("option", { name: "TLS（465 端口，全程加密）" })
    )
    await user.click(screen.getByRole("button", { name: "保存邮件配置" }))

    expect(adminApi.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        email: expect.objectContaining({
          smtp: expect.objectContaining({ encryption: "tls" })
        })
      })
    )
  })

  it("重录密码才提交新值，保存成功后输入框清空", async () => {
    vi.mocked(adminApi.updateSettings).mockResolvedValue({ success: true })

    const user = userEvent.setup()
    render(<SmtpTab />)

    const password = await screen.findByLabelText("密码")
    await user.type(password, "new-secret-123")
    await user.click(screen.getByRole("button", { name: "保存邮件配置" }))

    expect(adminApi.updateSettings).toHaveBeenCalledWith({
      email: {
        provider: "smtp",
        smtp: {
          host: "smtp.example.com",
          port: 587,
          encryption: "starttls",
          username: "mailer",
          from: "noreply@example.com",
          fromName: "Ciki",
          password: "new-secret-123"
        },
        resend: {
          from: "",
          fromName: "",
          apiKey: ""
        }
      }
    })

    await waitFor(() => {
      expect(password).toHaveValue("")
    })
  })

  it("保存失败时展示服务端原因，密码输入框不被清空", async () => {
    vi.mocked(adminApi.updateSettings).mockRejectedValue(
      new ApiError(502, "smtp down", "EMAIL_SEND_FAILED")
    )

    const user = userEvent.setup()
    render(<SmtpTab />)

    const password = await screen.findByLabelText("密码")
    await user.type(password, "typed-secret")
    await user.click(screen.getByRole("button", { name: "保存邮件配置" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("邮件发送失败")
    expect(password).toHaveValue("typed-secret")
  })

  it("测试邮件：带出管理员邮箱并调用 testEmail", async () => {
    vi.mocked(adminApi.testEmail).mockResolvedValue({ success: true })

    const user = userEvent.setup()
    render(<SmtpTab />)

    const toInput = await screen.findByLabelText("收件人")
    expect(toInput).toHaveValue("admin@example.com")

    await user.clear(toInput)
    await user.type(toInput, "test-user@example.com")
    await user.click(screen.getByRole("button", { name: "发送" }))

    expect(adminApi.testEmail).toHaveBeenCalledWith("test-user@example.com")
  })

  it("测试邮件失败时直出 provider 原文（detail）在 monospace 区域", async () => {
    vi.mocked(adminApi.testEmail).mockRejectedValue(
      new ApiError(
        502,
        "Email send failed",
        "EMAIL_SEND_FAILED",
        undefined,
        undefined,
        undefined,
        "554 5.7.1 relay access denied"
      )
    )

    const user = userEvent.setup()
    render(<SmtpTab />)

    await screen.findByLabelText("收件人")
    await user.click(screen.getByRole("button", { name: "发送" }))

    expect(
      await screen.findByText("554 5.7.1 relay access denied")
    ).toBeInTheDocument()
  })

  it("英文界面下所有标签与按钮显示英文", async () => {
    await i18n.changeLanguage("en")
    render(<SmtpTab />)

    expect(
      await screen.findByRole("heading", { name: "Email" })
    ).toBeInTheDocument()
    expect(screen.getByText("Email configured")).toBeInTheDocument()
    expect(screen.getByLabelText("Provider")).toBeInTheDocument()
    expect(screen.getByLabelText("Host")).toHaveValue("smtp.example.com")
    expect(screen.getByLabelText("Port")).toHaveValue("587")
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "placeholder",
      "Set — leave blank to keep it"
    )
    expect(
      screen.getByRole("button", { name: "Save email settings" })
    ).toBeInTheDocument()
    expect(screen.getByText("Send a test email")).toBeInTheDocument()
    expect(screen.getByLabelText("Recipient")).toHaveValue("admin@example.com")
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument()
  })
})
