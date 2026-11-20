import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import { ApiError, type SiteSettings } from "@/lib/api"
import { SecurityTab } from "@/pages/admin/SecurityTab"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      settings: vi.fn(),
      saveSettings: vi.fn()
    }
  }
})

const { adminApi } = await import("@/lib/api")

const settings: SiteSettings = {
  siteName: "Ciki",
  setupPageEnabled: false,
  registrationEnabled: true,
  registrationApprovalRequired: true,
  registrationEmailVerificationRequired: true,
  require2fa: false,
  emailConfigured: true,
  revisionRetentionLimit: null
}

describe("系统管理 · 访问与安全", () => {
  beforeEach(() => {
    vi.mocked(adminApi.settings).mockResolvedValue(settings)
    vi.mocked(adminApi.saveSettings).mockReset()
  })

  it("强制两步验证与三个注册开关都是可操作的开关", async () => {
    render(<SecurityTab />)

    expect(
      await screen.findByRole("switch", { name: "强制两步验证" })
    ).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "开放注册" })).toBeEnabled()
    expect(
      screen.getByRole("switch", { name: "注册需要管理员批准" })
    ).toBeEnabled()
    const emailVerify = screen.getByRole("switch", { name: "注册需邮箱验证" })
    expect(emailVerify).toBeEnabled()
    expect(emailVerify).toHaveAttribute("aria-checked", "true")
    // 权限模型里指向「用户管理」的那条已改为准确表述
    expect(screen.getByText(/待批准用户的处理/)).toBeInTheDocument()
    expect(screen.queryByText(/注册审批、账号停用/)).toBeNull()
  })

  it("切换「开放注册」把 registrationEnabled 写回后端", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.saveSettings).mockResolvedValue({ success: true })
    render(<SecurityTab />)

    const registration = await screen.findByRole("switch", {
      name: "开放注册"
    })
    await user.click(registration)

    expect(adminApi.saveSettings).toHaveBeenCalledWith({
      registrationEnabled: false
    })
    expect(registration).toHaveAttribute("aria-checked", "false")
  })

  it("切换「注册需邮箱验证」把 registrationEmailVerificationRequired 写回后端", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.saveSettings).mockResolvedValue({ success: true })
    render(<SecurityTab />)

    const emailVerify = await screen.findByRole("switch", {
      name: "注册需邮箱验证"
    })
    expect(emailVerify).toHaveAttribute("aria-checked", "true")
    await user.click(emailVerify)

    expect(adminApi.saveSettings).toHaveBeenCalledWith({
      registrationEmailVerificationRequired: false
    })
    expect(emailVerify).toHaveAttribute("aria-checked", "false")
  })

  it("邮件未配置且开关开启时，「注册需邮箱验证」置灰并提示暂不生效", async () => {
    vi.mocked(adminApi.settings).mockResolvedValue({
      ...settings,
      emailConfigured: false,
      registrationEmailVerificationRequired: true
    })
    render(<SecurityTab />)

    const emailVerify = await screen.findByRole("switch", {
      name: "注册需邮箱验证"
    })
    expect(emailVerify).toBeDisabled()
    expect(emailVerify).toHaveAttribute("aria-checked", "true")
    expect(
      screen.getByText(
        "邮件未配置，该开关暂不生效，新注册用户不会被要求验证邮箱。"
      )
    ).toBeInTheDocument()
  })

  it("邮件未配置且开关关闭时，「注册需邮箱验证」置灰并提示无法开启", async () => {
    vi.mocked(adminApi.settings).mockResolvedValue({
      ...settings,
      emailConfigured: false,
      registrationEmailVerificationRequired: false
    })
    render(<SecurityTab />)

    const emailVerify = await screen.findByRole("switch", {
      name: "注册需邮箱验证"
    })
    expect(emailVerify).toBeDisabled()
    expect(emailVerify).toHaveAttribute("aria-checked", "false")
    expect(
      screen.getByText(
        "邮件未配置，无法开启该开关；请先在邮件配置中设置发送通道。"
      )
    ).toBeInTheDocument()
  })

  it("切换「注册需邮箱验证」保存失败（409 EMAIL_NOT_CONFIGURED）时回滚并显示错误", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.settings).mockResolvedValue({
      ...settings,
      registrationEmailVerificationRequired: false
    })
    vi.mocked(adminApi.saveSettings).mockRejectedValue(
      new ApiError(
        409,
        "Email delivery is not configured",
        "EMAIL_NOT_CONFIGURED"
      )
    )
    render(<SecurityTab />)

    const emailVerify = await screen.findByRole("switch", {
      name: "注册需邮箱验证"
    })
    expect(emailVerify).toHaveAttribute("aria-checked", "false")
    await user.click(emailVerify)

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "还没有配置可用的 SMTP，请先在系统管理 → 邮件配置里填写。"
    )
    expect(emailVerify).toHaveAttribute("aria-checked", "false")
  })

  it("开放注册关闭时「注册需要管理员批准」不可操作", async () => {
    vi.mocked(adminApi.settings).mockResolvedValue({
      ...settings,
      registrationEnabled: false
    })
    render(<SecurityTab />)

    expect(
      await screen.findByRole("switch", { name: "注册需要管理员批准" })
    ).toBeDisabled()
  })

  it("保存失败时回滚开关并显示错误", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.saveSettings).mockRejectedValue(
      new Error("network down")
    )
    render(<SecurityTab />)

    const registration = await screen.findByRole("switch", {
      name: "开放注册"
    })
    await user.click(registration)

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(registration).toHaveAttribute("aria-checked", "true")
  })
})

describe("系统管理 · 访问与安全 · 英文界面", () => {
  beforeEach(() => {
    vi.mocked(adminApi.settings).mockResolvedValue(settings)
  })

  it("四个开关与权限模型说明都是英文", async () => {
    await i18n.changeLanguage("en")
    render(<SecurityTab />)

    expect(
      await screen.findByLabelText("Require two-factor authentication")
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Open registration")).toBeInTheDocument()
    expect(
      screen.getByLabelText("Registration requires admin approval")
    ).toBeInTheDocument()
    expect(
      screen.getByLabelText("Registration requires email verification")
    ).toBeInTheDocument()
    expect(screen.getByText("Permission model")).toBeInTheDocument()
  })
})
