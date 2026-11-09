import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api"
import { SettingsPage } from "@/pages/SettingsPage"
import { useAuthStore } from "@/stores/auth"
import { useSiteStore } from "@/stores/site"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    authApi: {
      ...actual.authApi,
      totpSetup: vi.fn(),
      totpEnable: vi.fn(),
      totpDisable: vi.fn(),
      passkeyRegisterOptions: vi.fn(),
      passkeyRegisterVerify: vi.fn(),
      passkeyDisableAll: vi.fn(),
      emailOtpSendVerify: vi.fn(),
      emailOtpEnable: vi.fn(),
      emailOtpDisable: vi.fn()
    },
    meApi: {
      ...actual.meApi,
      get: vi.fn(),
      sessions: vi.fn(),
      changePassword: vi.fn(),
      importToken: vi.fn(),
      createImportToken: vi.fn(),
      revokeImportToken: vi.fn()
    }
  }
})

const { authApi, meApi } = await import("@/lib/api")

// 设置页里的导入令牌卡挂载时会拉一次状态：给默认值，别让旧用例打到真 fetch。
beforeEach(() => {
  vi.mocked(meApi.importToken).mockResolvedValue({
    active: false,
    createdAt: null,
    lastUsedAt: null,
    revokedAt: null
  })
})

function setUser(twofa: {
  totpEnabled: boolean
  passkeyCount: number
  emailOtpEnabled?: boolean
}) {
  useAuthStore.setState({
    user: {
      id: "u1",
      publicId: "AB23CD45",
      username: "管理员",
      avatarUrl: null,
      email: "admin@example.com",
      role: "admin",
      approvalStatus: "approved",
      createdAt: "2026-11-07T00:00:00.000Z",
      twofa: {
        totpEnabled: twofa.totpEnabled,
        passkeyEnabled: twofa.passkeyCount > 0,
        passkeyCount: twofa.passkeyCount,
        emailOtpEnabled: twofa.emailOtpEnabled ?? false
      }
    },
    status: "ready",
    restricted: false
  })
}

const renderSettings = () =>
  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <SettingsPage />
    </MemoryRouter>
  )

/**
 * 契约变更：账号已有因子时，TOTP setup/enable 与 Passkey 注册必须带 password 重认证；
 * 一个因子都没有时不弹密码框（受强制 2FA 引导的新用户不该被再拦一道）。
 */
describe("两步验证新增因子的重认证", () => {
  beforeAll(() => {
    // jsdom 没有 WebAuthn：让 webauthnSupported() 为真，Passkey 按钮才可点
    Object.defineProperty(window, "PublicKeyCredential", {
      value: function PublicKeyCredential() {},
      configurable: true,
      writable: true
    })
  })

  beforeEach(() => {
    vi.mocked(meApi.sessions).mockResolvedValue([])
    vi.mocked(meApi.get).mockResolvedValue({
      id: "u1",
      publicId: "AB23CD45",
      username: "管理员",
      avatarUrl: null,
      email: "admin@example.com",
      role: "admin",
      approvalStatus: "approved",
      createdAt: "2026-11-07T00:00:00.000Z",
      twofa: {
        totpEnabled: true,
        passkeyEnabled: false,
        passkeyCount: 0,
        emailOtpEnabled: false
      }
    })
    vi.mocked(authApi.passkeyRegisterOptions).mockRejectedValue(
      new Error("测试里不真的走 WebAuthn")
    )
    vi.mocked(authApi.passkeyRegisterVerify).mockResolvedValue({
      success: true
    })
    vi.mocked(authApi.totpSetup).mockResolvedValue({
      secret: "JBSWY3DPEHPK3PXP",
      uri: "otpauth://totp/ciki:admin?secret=JBSWY3DPEHPK3PXP"
    })
  })

  it("已有 TOTP 时先要密码，再带 password 调 setup", async () => {
    const user = userEvent.setup()
    setUser({ totpEnabled: true, passkeyCount: 0, emailOtpEnabled: false })
    renderSettings()

    // 已开启 TOTP 时没有「开始配置」，先关掉再新增：用 Passkey 分支验证弹窗更直接
    expect(screen.queryByRole("button", { name: "开始配置" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "添加 Passkey" }))
    const password = await screen.findByLabelText("账号密码")
    await user.type(password, "reauth-pw")
    await user.click(screen.getByRole("button", { name: "继续" }))

    expect(authApi.passkeyRegisterOptions).toHaveBeenCalledWith("reauth-pw")
  })

  it("已有 Passkey 时新增 TOTP 也要密码", async () => {
    const user = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 1 })
    renderSettings()

    await user.click(screen.getByRole("button", { name: "开始配置" }))
    await user.type(await screen.findByLabelText("账号密码"), "reauth-pw")
    await user.click(screen.getByRole("button", { name: "继续" }))

    expect(authApi.totpSetup).toHaveBeenCalledWith("reauth-pw")
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument()
  })

  it("没有任何因子时不弹密码框，直接开始配置", async () => {
    const user = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 0, emailOtpEnabled: false })
    renderSettings()

    await user.click(screen.getByRole("button", { name: "开始配置" }))

    expect(authApi.totpSetup).toHaveBeenCalledWith(undefined)
    expect(screen.queryByLabelText("账号密码")).toBeNull()
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument()
  })
})

describe("受限会话在配置完成后解除", () => {
  beforeAll(() => {
    Object.defineProperty(window, "PublicKeyCredential", {
      value: function PublicKeyCredential() {},
      configurable: true,
      writable: true
    })
  })

  beforeEach(() => {
    vi.mocked(meApi.sessions).mockResolvedValue([])
    vi.mocked(meApi.get).mockResolvedValue({
      id: "u1",
      publicId: "AB23CD45",
      username: "管理员",
      avatarUrl: null,
      email: "admin@example.com",
      role: "admin",
      approvalStatus: "approved",
      createdAt: "2026-11-07T00:00:00.000Z",
      twofa: {
        totpEnabled: true,
        passkeyEnabled: false,
        passkeyCount: 0,
        emailOtpEnabled: false
      }
    })
    vi.mocked(authApi.totpSetup).mockResolvedValue({
      secret: "JBSWY3DPEHPK3PXP",
      uri: "otpauth://totp/ciki:admin?secret=JBSWY3DPEHPK3PXP"
    })
    vi.mocked(authApi.totpEnable).mockResolvedValue({ success: true })
    useAuthStore.setState({ restricted: true })
    sessionStorage.setItem("ciki-restricted-session", "1")
  })

  it("启用 TOTP 成功后清掉受限标记，用户不再被拉回设置页", async () => {
    const user = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 0, emailOtpEnabled: false })
    renderSettings()

    await user.click(screen.getByRole("button", { name: "开始配置" }))
    await screen.findByText("JBSWY3DPEHPK3PXP")
    await user.type(screen.getByLabelText("6 位验证码"), "123456")
    await user.click(screen.getByRole("button", { name: "启用" }))

    expect(authApi.totpEnable).toHaveBeenCalledWith("123456", undefined)
    expect(useAuthStore.getState().restricted).toBe(false)
    expect(sessionStorage.getItem("ciki-restricted-session")).toBeNull()
  })
})

describe("导入令牌卡接入", () => {
  beforeEach(() => {
    vi.mocked(meApi.sessions).mockResolvedValue([])
  })

  it("设置页里渲染导入令牌卡并拉一次状态", async () => {
    setUser({ totpEnabled: true, passkeyCount: 0, emailOtpEnabled: false })
    renderSettings()

    expect(await screen.findByText("导入令牌")).toBeInTheDocument()
    expect(meApi.importToken).toHaveBeenCalledTimes(1)
    expect(
      await screen.findByRole("button", { name: "生成令牌" })
    ).toBeInTheDocument()
  })
})

/**
 * 邮箱验证码 2FA（契约 #48/#50）：send-verify 先发码、enable 拿码验过才开启；
 * 已有任何因子时发码要密码重认证；emailConfigured=false 时入口直接不可用并
 * 一句话写清去哪里配，不做「点了才报错」的死按钮。
 */
describe("邮箱验证码 2FA", () => {
  const sent = {
    success: true as const,
    cooldownSeconds: 60,
    expiresInSeconds: 600
  }

  beforeEach(() => {
    vi.mocked(meApi.sessions).mockResolvedValue([])
    vi.mocked(authApi.emailOtpSendVerify).mockResolvedValue(sent)
    vi.mocked(authApi.emailOtpEnable).mockResolvedValue({ success: true })
    vi.mocked(authApi.emailOtpDisable).mockResolvedValue({ success: true })
    useSiteStore.setState({ emailConfigured: true })
  })

  it("站点没配发信时入口不可用，并写明去哪里配", () => {
    useSiteStore.setState({ emailConfigured: false })
    setUser({ totpEnabled: false, passkeyCount: 0 })
    renderSettings()

    expect(
      screen.getByText(/站点未配置发信，邮箱验证码不可用/)
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "开启邮箱验证码" })
    ).toBeDisabled()
  })

  it("已有因子时先要密码，再带 password 发码并进入输码步骤", async () => {
    const user = userEvent.setup()
    setUser({ totpEnabled: true, passkeyCount: 0 })
    renderSettings()

    await user.click(screen.getByRole("button", { name: "开启邮箱验证码" }))
    await user.type(await screen.findByLabelText("账号密码"), "reauth-pw")
    await user.click(screen.getByRole("button", { name: "继续" }))

    expect(authApi.emailOtpSendVerify).toHaveBeenCalledWith("reauth-pw")
    expect(await screen.findByLabelText("邮箱验证码")).toBeInTheDocument()
    expect(
      screen.getByText("验证码已发送到 admin@example.com，10 分钟内有效。")
    ).toBeInTheDocument()
    // 60s 冷却期内不能重发
    expect(screen.getByRole("button", { name: /重新发送/ })).toBeDisabled()
  })

  it("没有其它因子时不弹密码框，直接发码", async () => {
    const user = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 0 })
    renderSettings()

    await user.click(screen.getByRole("button", { name: "开启邮箱验证码" }))

    expect(authApi.emailOtpSendVerify).toHaveBeenCalledWith(undefined)
    expect(screen.queryByLabelText("账号密码")).toBeNull()
    expect(await screen.findByLabelText("邮箱验证码")).toBeInTheDocument()
  })

  it("输 6 位码点启用：带上重认证密码，成功后清受限标记并显示已开启", async () => {
    const user = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 1 })
    vi.mocked(meApi.get).mockResolvedValue({
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
        passkeyEnabled: true,
        passkeyCount: 1,
        emailOtpEnabled: true
      }
    })
    useAuthStore.setState({ restricted: true })
    sessionStorage.setItem("ciki-restricted-session", "1")
    renderSettings()

    await user.click(screen.getByRole("button", { name: "开启邮箱验证码" }))
    await user.type(await screen.findByLabelText("账号密码"), "reauth-pw")
    await user.click(screen.getByRole("button", { name: "继续" }))

    const code = await screen.findByLabelText("邮箱验证码")
    await user.type(code, "654321")
    await user.click(screen.getByRole("button", { name: "启用" }))

    expect(authApi.emailOtpEnable).toHaveBeenCalledWith("654321", "reauth-pw")
    expect(useAuthStore.getState().restricted).toBe(false)
    expect(sessionStorage.getItem("ciki-restricted-session")).toBeNull()
    expect(
      await screen.findByText(/已开启：登录第二步可以向 admin@example.com/)
    ).toBeInTheDocument()
  })

  it("发码后点取消：入口在冷却期内不可点，不留一个必 429 的按钮", async () => {
    const user = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 0 })
    renderSettings()

    await user.click(screen.getByRole("button", { name: "开启邮箱验证码" }))
    await screen.findByLabelText("邮箱验证码")
    await user.click(screen.getByRole("button", { name: "取消" }))

    // 面板收起、回到未开启态，但冷却还在：按钮显示剩余秒数并禁用
    expect(screen.queryByLabelText("邮箱验证码")).toBeNull()
    const entry = screen.getByRole("button", { name: /重新发送（\d+s）/ })
    expect(entry).toBeDisabled()
    expect(authApi.emailOtpSendVerify).toHaveBeenCalledTimes(1)
  })

  it("服务端回没配发信时，入口当场切成不可用并给出方向", async () => {
    const user = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 0 })
    vi.mocked(authApi.emailOtpSendVerify).mockRejectedValue(
      new ApiError(
        503,
        "Email delivery is not configured",
        "EMAIL_NOT_CONFIGURED"
      )
    )
    renderSettings()

    await user.click(screen.getByRole("button", { name: "开启邮箱验证码" }))

    expect(
      await screen.findByText(
        "还没有配置可用的 SMTP，请先在系统管理 → 邮件配置里填写。"
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(/站点未配置发信，邮箱验证码不可用/)
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "开启邮箱验证码" })
    ).toBeDisabled()
  })

  it("已开启时点关闭要密码，调 disable 后提示已关闭", async () => {
    const user = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 0, emailOtpEnabled: true })
    renderSettings()

    await user.click(screen.getByRole("button", { name: "关闭邮箱验证码" }))
    await user.type(await screen.findByLabelText("账号密码"), "reauth-pw")
    await user.click(screen.getByRole("button", { name: "确认关闭" }))

    expect(authApi.emailOtpDisable).toHaveBeenCalledWith("reauth-pw")
  })

  it("发信被关掉但因子已开启时，关闭按钮仍然可用（不把人锁死）", () => {
    useSiteStore.setState({ emailConfigured: false })
    setUser({ totpEnabled: false, passkeyCount: 0, emailOtpEnabled: true })
    renderSettings()

    expect(screen.getByRole("button", { name: "关闭邮箱验证码" })).toBeEnabled()
    expect(screen.getByText(/已开启，但站点没有配置发信/)).toBeInTheDocument()
  })
})
