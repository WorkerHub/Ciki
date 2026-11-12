import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import { ApiError, type Me, type SmtpSettings } from "@/lib/api"
import { SmtpTab } from "@/pages/admin/SmtpTab"
import { useAuthStore } from "@/stores/auth"
import { DEFAULT_SITE_NAME, useSiteStore } from "@/stores/site"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      smtp: vi.fn(),
      saveSmtp: vi.fn(),
      testSmtp: vi.fn(),
      settings: vi.fn()
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

const config: SmtpSettings = {
  host: "smtp.example.com",
  port: 587,
  encryption: "starttls",
  username: "notify@example.com",
  from: "no-reply@example.com",
  fromName: "Ciki",
  passwordSet: true
}

/** GET /admin/system/smtp 的真实形状：状态标志 + 非密配置。 */
const state = { emailConfigured: true, config }

describe("系统管理 · 邮件配置", () => {
  const siteLoad = vi.fn(async () => {})

  beforeEach(() => {
    useAuthStore.setState({ user: admin, status: "ready", restricted: false })
    useSiteStore.setState({
      name: DEFAULT_SITE_NAME,
      loaded: true,
      load: siteLoad
    })
    siteLoad.mockClear()
    vi.mocked(adminApi.smtp).mockReset()
    vi.mocked(adminApi.saveSmtp).mockReset()
    vi.mocked(adminApi.testSmtp).mockReset()
    vi.mocked(adminApi.smtp).mockResolvedValue(state)
  })

  it("按契约回填七个字段，密码只显掩码、不回显明文", async () => {
    render(<SmtpTab />)

    expect(await screen.findByLabelText("服务器地址")).toHaveValue(
      "smtp.example.com"
    )
    expect(screen.getByLabelText("端口")).toHaveValue(587)
    expect(
      screen.getByRole("combobox", { name: "加密方式" })
    ).toHaveTextContent("STARTTLS")
    expect(screen.getByLabelText("用户名")).toHaveValue("notify@example.com")
    expect(screen.getByLabelText("发件人地址")).toHaveValue(
      "no-reply@example.com"
    )
    expect(screen.getByLabelText("发件人名称")).toHaveValue("Ciki")

    const password = screen.getByLabelText("密码")
    expect(password).toHaveValue("")
    expect(password).toHaveAttribute(
      "placeholder",
      "•••••••• 已保存，留空保持不变"
    )
    expect(screen.getByText("已配置")).toBeInTheDocument()
    // 已存的密码不能以任何形式出现在 DOM 里
    expect(document.body.textContent).not.toMatch(/s3cret/)
  })

  it("密码留空保存时提交空串（保留原密文），并回读服务端状态", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.saveSmtp).mockResolvedValue({
      success: true,
      emailConfigured: true
    })
    render(<SmtpTab />)

    await screen.findByLabelText("服务器地址")
    await user.click(screen.getByRole("button", { name: "保存配置" }))

    expect(adminApi.saveSmtp).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 587,
      encryption: "starttls",
      username: "notify@example.com",
      password: "",
      from: "no-reply@example.com",
      fromName: "Ciki"
    })
    expect(await screen.findByRole("status")).toHaveTextContent(
      "SMTP 配置已保存"
    )
    expect(adminApi.smtp).toHaveBeenCalledTimes(2)
    // 站点级 emailConfigured 跟着重拉，设置页的邮箱 2FA 入口保存后即可用
    expect(siteLoad).toHaveBeenCalled()
  })

  it("重录密码才提交新值，保存后输入框清空", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.saveSmtp).mockResolvedValue({
      success: true,
      emailConfigured: true
    })
    render(<SmtpTab />)

    const password = await screen.findByLabelText("密码")
    await user.type(password, "s3cret")
    await user.click(screen.getByRole("button", { name: "保存配置" }))

    expect(adminApi.saveSmtp).toHaveBeenCalledWith(
      expect.objectContaining({ password: "s3cret" })
    )
    expect(await screen.findByRole("status")).toBeInTheDocument()
    expect(screen.getByLabelText("密码")).toHaveValue("")
  })

  it("服务端判定还不能发信时如实提示，不假装成功", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.saveSmtp).mockResolvedValue({
      success: true,
      emailConfigured: false
    })
    render(<SmtpTab />)

    await screen.findByLabelText("密码")
    await user.click(screen.getByRole("button", { name: "保存配置" }))

    expect(await screen.findByRole("status")).toHaveTextContent("还不能发信")
  })

  it("从未保存过（config 为 null）时表单给默认值，状态是未配置", async () => {
    vi.mocked(adminApi.smtp).mockResolvedValue({
      emailConfigured: false,
      config: null
    })
    render(<SmtpTab />)

    expect(await screen.findByLabelText("服务器地址")).toHaveValue("")
    expect(screen.getByLabelText("端口")).toHaveValue(587)
    expect(
      screen.getByRole("combobox", { name: "加密方式" })
    ).toHaveTextContent("STARTTLS")
    expect(screen.getByText("未配置")).toBeInTheDocument()
    expect(screen.getByLabelText("密码")).toHaveAttribute(
      "placeholder",
      "未设置"
    )
  })

  it("用户名与密码必须成对：只填用户名时本地拦下", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.smtp).mockResolvedValue({
      emailConfigured: false,
      config: { ...config, username: "", passwordSet: false }
    })
    render(<SmtpTab />)

    const username = await screen.findByLabelText("用户名")
    await user.type(username, "notify@example.com")
    await user.click(screen.getByRole("button", { name: "保存配置" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "填了用户名就要一起填密码"
    )
    expect(adminApi.saveSmtp).not.toHaveBeenCalled()
  })

  it("测试邮件成功时当场提示收件管理员邮箱", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.testSmtp).mockResolvedValue({ success: true })
    render(<SmtpTab />)

    await user.click(
      await screen.findByRole("button", { name: "发送测试邮件" })
    )

    expect(adminApi.testSmtp).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole("status")).toHaveTextContent(
      "admin@example.com"
    )
  })

  it("测试邮件失败时展示服务端脱敏后的真实原因", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.testSmtp).mockRejectedValue(
      new ApiError(
        502,
        "SMTP send failed: 535 5.7.8 authentication failed",
        "SMTP_SEND_FAILED"
      )
    )
    render(<SmtpTab />)

    await user.click(
      await screen.findByRole("button", { name: "发送测试邮件" })
    )

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "发信失败：535 5.7.8 authentication failed"
    )
  })

  it("未配置时只给一句去向，测试按钮不可点", async () => {
    vi.mocked(adminApi.smtp).mockResolvedValue({
      emailConfigured: false,
      config: { ...config, host: "", from: "" }
    })
    render(<SmtpTab />)

    expect(await screen.findByText("未配置")).toBeInTheDocument()
    expect(
      screen.getByText("填好并保存后，邮箱验证码两步验证与找回密码才会启用。")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "发送测试邮件" })).toBeDisabled()
  })

  it("服务器地址为空时本地拦下，不发请求", async () => {
    const user = userEvent.setup()
    render(<SmtpTab />)

    await user.clear(await screen.findByLabelText("服务器地址"))
    await user.click(screen.getByRole("button", { name: "保存配置" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "请填写 SMTP 服务器地址"
    )
    expect(adminApi.saveSmtp).not.toHaveBeenCalled()
  })

  it("端口超出范围时本地拦下，不发请求", async () => {
    const user = userEvent.setup()
    render(<SmtpTab />)

    const port = await screen.findByLabelText("端口")
    await user.clear(port)
    await user.type(port, "70000")
    await user.click(screen.getByRole("button", { name: "保存配置" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "端口需为 1–65535 的整数"
    )
    expect(adminApi.saveSmtp).not.toHaveBeenCalled()
  })

  it("加密方式三态可切换，保存时提交选中值", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.saveSmtp).mockResolvedValue({
      success: true,
      emailConfigured: true
    })
    render(<SmtpTab />)

    await user.click(await screen.findByRole("combobox", { name: "加密方式" }))
    await user.click(
      await screen.findByRole("option", { name: "TLS（465 端口，全程加密）" })
    )
    await user.click(screen.getByRole("button", { name: "保存配置" }))

    expect(adminApi.saveSmtp).toHaveBeenCalledWith(
      expect.objectContaining({ encryption: "tls" })
    )
  })

  it("保存失败时展示服务端原因，表单不改动", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.saveSmtp).mockRejectedValue(
      new ApiError(
        400,
        "Invalid SMTP config: from must be a valid email address",
        "INVALID_SMTP_CONFIG"
      )
    )
    render(<SmtpTab />)

    await screen.findByLabelText("服务器地址")
    await user.click(screen.getByRole("button", { name: "保存配置" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "SMTP 配置不合法：from must be a valid email address"
    )
    expect(screen.getByLabelText("服务器地址")).toHaveValue("smtp.example.com")
  })
})

describe("系统管理 · 邮件配置 · 英文界面", () => {
  beforeEach(() => {
    useAuthStore.setState({ user: admin, status: "ready", restricted: false })
    useSiteStore.setState({ name: DEFAULT_SITE_NAME, loaded: true })
    vi.mocked(adminApi.smtp).mockReset().mockResolvedValue(state)
  })

  it("字段标签、加密选项与页脚说明都是英文", async () => {
    await i18n.changeLanguage("en")
    render(<SmtpTab />)

    expect(await screen.findByLabelText("Server address")).toHaveValue(
      "smtp.example.com"
    )
    expect(screen.getByLabelText("Port")).toHaveValue(587)
    expect(
      screen.getByRole("combobox", { name: "Encryption" })
    ).toHaveTextContent("STARTTLS")
    expect(screen.getByText("Configured")).toBeInTheDocument()
    expect(
      screen.getByText(
        "Test emails only go to the current admin inbox (admin@example.com) using the saved configuration."
      )
    ).toBeInTheDocument()
  })
})
