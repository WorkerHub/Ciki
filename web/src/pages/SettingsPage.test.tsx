import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import { ApiError } from "@/lib/api"
import { LANGUAGE_STORAGE_KEY } from "@/lib/language"
import { SettingsPage } from "@/pages/SettingsPage"
import { useAuthStore } from "@/stores/auth"
import { useSiteStore } from "@/stores/site"
import { useThemeStore } from "@/stores/theme"
import type { ThemeStyle } from "@/lib/theme"

vi.mock("@/lib/webauthn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/webauthn")>()
  return {
    ...actual,
    webauthnSupported: () => true,
    registrationCredential: vi.fn().mockResolvedValue({
      id: "mock-credential-id",
      type: "public-key"
    })
  }
})

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
      passkeyRename: vi.fn(),
      passkeyRemove: vi.fn(),
      passkeyDisableAll: vi.fn(),
      emailOtpSendVerify: vi.fn(),
      emailOtpEnable: vi.fn(),
      emailOtpDisable: vi.fn()
    },
    meApi: {
      ...actual.meApi,
      get: vi.fn(),
      sessions: vi.fn(),
      updateProfile: vi.fn(),
      updateThemeStyle: vi.fn(),
      changePassword: vi.fn(),
      tokens: vi.fn(),
      importTokens: vi.fn(),
      agents: {
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        tokens: vi.fn(),
        issueToken: vi.fn(),
        revokeToken: vi.fn()
      }
    }
  }
})

const { authApi, meApi } = await import("@/lib/api")

// 设置页里的令牌卡与 Agent 卡挂载时各拉一次列表：给默认值，别让旧用例打到真 fetch。
beforeEach(() => {
  vi.mocked(meApi.tokens).mockResolvedValue({ tokens: [] })
  vi.mocked(meApi.importTokens).mockResolvedValue({ tokens: [] })
  vi.mocked(meApi.agents.list).mockResolvedValue([])
  vi.mocked(meApi.updateThemeStyle).mockReset()
})

function setUser(twofa: {
  totpEnabled: boolean
  totpName?: string | null
  passkeyCount: number
  passkeys?: Array<{
    name: string
    createdAt: string
    lastUsedAt: string | null
    credentialId: string
  }>
  emailOtpEnabled?: boolean
}) {
  const passkeys =
    twofa.passkeys ??
    (twofa.passkeyCount > 0
      ? Array.from({ length: twofa.passkeyCount }, (_, i) => ({
          name: `Passkey ${i + 1}`,
          createdAt: "2026-11-20T00:00:00.000Z",
          lastUsedAt: null,
          credentialId: `cred-${i + 1}`
        }))
      : [])

  useAuthStore.setState({
    user: {
      id: 1,
      username: "管理员",
      avatarUrl: null,
      email: "admin@example.com",
      role: "admin",
      approvalStatus: "approved",
      createdAt: "2026-11-07T00:00:00.000Z",
      twofa: {
        totpEnabled: twofa.totpEnabled,
        totpName: twofa.totpEnabled ? (twofa.totpName ?? "TOTP") : null,
        passkeyEnabled: twofa.passkeyCount > 0,
        passkeyCount: twofa.passkeyCount,
        passkeys,
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
      id: 1,
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
    // 先出命名对话框，点继续后进入密码重认证
    await user.click(screen.getByRole("button", { name: "继续" }))
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
    // 先出 TOTP 命名对话框，点继续后进入密码重认证
    await user.click(screen.getByRole("button", { name: "继续" }))
    await user.type(await screen.findByLabelText("账号密码"), "reauth-pw")
    await user.click(screen.getByRole("button", { name: "继续" }))

    expect(authApi.totpSetup).toHaveBeenCalledWith("reauth-pw", undefined)
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument()
  })

  it("没有任何因子时不弹密码框，直接开始配置", async () => {
    const user = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 0, emailOtpEnabled: false })
    renderSettings()

    await user.click(screen.getByRole("button", { name: "开始配置" }))
    // 点命名对话框的继续按钮
    await user.click(screen.getByRole("button", { name: "继续" }))

    expect(authApi.totpSetup).toHaveBeenCalledWith(undefined, undefined)
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
      id: 1,
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
    await user.click(screen.getByRole("button", { name: "继续" }))
    await screen.findByText("JBSWY3DPEHPK3PXP")
    await user.type(screen.getByLabelText("6 位验证码"), "123456")
    await user.click(screen.getByRole("button", { name: "启用" }))

    expect(authApi.totpEnable).toHaveBeenCalledWith(
      "123456",
      undefined,
      undefined
    )
    expect(useAuthStore.getState().restricted).toBe(false)
    expect(sessionStorage.getItem("ciki-restricted-session")).toBeNull()
  })
})

describe("令牌卡接入", () => {
  beforeEach(() => {
    vi.mocked(meApi.sessions).mockResolvedValue([])
  })

  it("设置页渲染 API Token 与浏览器插件两张卡，旧的单令牌卡已下线", async () => {
    setUser({ totpEnabled: true, passkeyCount: 0, emailOtpEnabled: false })
    renderSettings()

    expect(await screen.findByText("API Token")).toBeInTheDocument()
    expect(screen.getByText("浏览器插件")).toBeInTheDocument()
    expect(meApi.tokens).toHaveBeenCalledTimes(1)
    expect(meApi.importTokens).toHaveBeenCalledTimes(1)
    expect(await screen.findByText("还没有 API Token")).toBeInTheDocument()
    expect(screen.getByText("还没有插件凭证")).toBeInTheDocument()
    // 旧的三张卡（导入 / 只读 / 读写）不再渲染
    expect(screen.queryByText("导入令牌")).toBeNull()
    expect(screen.queryByText("只读接口令牌")).toBeNull()
    expect(screen.queryByText("读写接口令牌")).toBeNull()
  })

  it("新建 Token 面内联展开，类型默认只读、名称留空提示自动名", async () => {
    setUser({ totpEnabled: true, passkeyCount: 0, emailOtpEnabled: false })
    const user = userEvent.setup()
    renderSettings()

    await user.click(await screen.findByRole("button", { name: "新建 Token" }))

    expect(screen.getByLabelText("名称")).toBeInTheDocument()
    expect(screen.getByText("留空将自动命名：只读 Token")).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "只读" })).toHaveAttribute(
      "aria-checked",
      "true"
    )
    expect(screen.getByRole("button", { name: "创建" })).toBeEnabled()
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
      id: 1,
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

/** 语言偏好：先选后存（暂存 + 独立保存按钮写回账号）；失败回滚（规格 §2.4 / 2026-11-25 拍板）。 */
describe("界面语言", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh")
    vi.mocked(meApi.sessions).mockResolvedValue([])
    vi.mocked(meApi.updateProfile).mockReset()
    vi.mocked(meApi.updateProfile).mockResolvedValue({
      id: 1,
      username: "管理员",
      avatarUrl: null,
      email: "admin@example.com",
      role: "admin",
      approvalStatus: "approved",
      createdAt: "2026-11-07T00:00:00.000Z",
      language: "en",
      twofa: {
        totpEnabled: false,
        passkeyEnabled: false,
        passkeyCount: 0,
        emailOtpEnabled: false
      }
    })
  })

  const getLanguageSaveBtn = () => {
    const card = screen
      .getByText("语言")
      .closest<HTMLElement>('[data-slot="card"]')!
    return within(card).getByRole("button", { name: "保存" })
  }

  it("点选语言只改暂存值，不立即切换界面语言、不写回账号", async () => {
    const user = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 0 })
    renderSettings()

    expect(i18n.language).toBe("zh")
    expect(screen.getByText("语言")).toBeInTheDocument()

    await user.click(screen.getByRole("radio", { name: "English" }))

    expect(i18n.language).toBe("zh")
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).not.toBe("en")
    expect(screen.getByText("语言")).toBeInTheDocument()
    expect(screen.queryByText("Language")).toBeNull()
    expect(meApi.updateProfile).not.toHaveBeenCalled()
  })

  it("保存按钮禁用/可点随暂存切换：初始禁用，选新语言可点，切回当前语言重新禁用", async () => {
    const user = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 0 })
    renderSettings()

    const saveBtn = getLanguageSaveBtn()
    expect(saveBtn).toBeDisabled()

    // 切换至 English，暂存值改变，保存按钮可用
    await user.click(screen.getByRole("radio", { name: "English" }))
    expect(saveBtn).toBeEnabled()

    // 切回 中文，暂存值与当前生效语言一致，保存按钮重新禁用
    await user.click(screen.getByRole("radio", { name: "中文" }))
    expect(saveBtn).toBeDisabled()
  })

  it("点保存才执行保存链：本地 changeLanguage 生效且写回账号，成功后保存按钮重置为禁用", async () => {
    const user = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 0 })
    renderSettings()

    const saveBtn = getLanguageSaveBtn()
    expect(saveBtn).toBeDisabled()

    await user.click(screen.getByRole("radio", { name: "English" }))
    expect(saveBtn).toBeEnabled()

    await user.click(saveBtn)

    expect(meApi.updateProfile).toHaveBeenCalledWith({ language: "en" })
    expect(i18n.language).toBe("en")
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en")
    expect(await screen.findByText("Language")).toBeInTheDocument()
    expect(saveBtn).toBeDisabled()
  })

  it("写回失败时回滚本地语言并走错误提示，保存按钮保持可用", async () => {
    vi.mocked(meApi.updateProfile).mockRejectedValue(
      new ApiError(400, "Invalid language", "INVALID_LANGUAGE")
    )
    const user = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 0 })
    renderSettings()

    const saveBtn = getLanguageSaveBtn()
    await user.click(screen.getByRole("radio", { name: "English" }))
    expect(saveBtn).toBeEnabled()

    await user.click(saveBtn)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "语言不受支持，只支持中文和英文。"
    )
    expect(i18n.language).toBe("zh")
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("zh")
    expect(screen.getByText("语言")).toBeInTheDocument()
    expect(saveBtn).toBeEnabled()
  })

  it("外部（如账号语言覆盖）更新生效语言时自动重同步暂存，避免保存按钮被误启用", async () => {
    await i18n.changeLanguage("en")
    setUser({ totpEnabled: false, passkeyCount: 0 })
    renderSettings()

    const card = screen
      .getByText("Language")
      .closest<HTMLElement>('[data-slot="card"]')!
    const saveBtn = within(card).getByRole("button", { name: "Save" })
    expect(saveBtn).toBeDisabled()

    // 模拟冷启动后 RootGate 用账号语言异步覆盖 i18n
    await act(async () => {
      await i18n.changeLanguage("zh")
    })

    const updatedCard = screen
      .getByText("语言")
      .closest<HTMLElement>('[data-slot="card"]')!
    const updatedSaveBtn = within(updatedCard).getByRole("button", {
      name: "保存"
    })
    expect(updatedSaveBtn).toBeDisabled()
    expect(screen.getByRole("radio", { name: "中文" })).toHaveAttribute(
      "data-state",
      "on"
    )
  })
  it("不再在设置页底部显示退出登录按钮", () => {
    vi.mocked(meApi.sessions).mockResolvedValue([])
    setUser({ totpEnabled: false, passkeyCount: 0 })
    renderSettings()

    expect(
      screen.queryByRole("button", { name: /退出登录|登出|Log out|Sign out/i })
    ).toBeNull()
  })
})

describe("设置页 · 英文界面", () => {
  it("卡片标题、两步验证与两张令牌卡都是英文", async () => {
    vi.mocked(meApi.sessions).mockResolvedValue([])
    setUser({
      totpEnabled: true,
      passkeyCount: 1,
      passkeys: [
        {
          name: "My MacBook Passkey",
          createdAt: "2026-11-20T00:00:00.000Z",
          lastUsedAt: null,
          credentialId: "cred-1"
        }
      ]
    })
    await i18n.changeLanguage("en")
    renderSettings()

    expect(screen.getByText("Settings")).toBeInTheDocument()
    expect(screen.getByText("Theme")).toBeInTheDocument()
    expect(screen.getByText("Change password")).toBeInTheDocument()
    expect(screen.getByText("Two-factor authentication")).toBeInTheDocument()
    expect(screen.getByText("My MacBook Passkey")).toBeInTheDocument()
    expect(screen.getByText(/Created/)).toBeInTheDocument()
    expect(screen.getByText(/Never used/)).toBeInTheDocument()
    expect(await screen.findByText("API Token")).toBeInTheDocument()
    expect(screen.getByText("Browser extension")).toBeInTheDocument()
    expect(screen.getByText("No API Token yet")).toBeInTheDocument()
    expect(screen.getByText("No extension credentials yet")).toBeInTheDocument()
    expect(screen.getByText("Signed-in devices")).toBeInTheDocument()
  })
})

describe("主题风格设置", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh")
    vi.mocked(meApi.sessions).mockResolvedValue([])
    useThemeStore.setState({ style: "nova", mode: "auto", migratedAt: null })
  })

  const getThemeSaveBtn = () => {
    const card = screen
      .getByText("主题")
      .closest<HTMLElement>('[data-slot="card"]')!
    return within(card).getByRole("button", { name: "保存" })
  }

  it("渲染风格选项（Nova / 纸面）与保存按钮，初始无变更时禁用；不包含亮暗三档控件", () => {
    setUser({ totpEnabled: false, passkeyCount: 0 })
    renderSettings()

    // 区域标题改为「主题」
    expect(screen.getByText("主题")).toBeInTheDocument()

    // 包含 Nova 与 纸面 两个风格选项
    expect(screen.getByRole("radio", { name: "Nova" })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "纸面" })).toBeInTheDocument()

    // 保存按钮存在且因无变更而处于禁用状态
    const saveBtn = getThemeSaveBtn()
    expect(saveBtn).toBeDisabled()

    // 删除亮暗三档控件（深色 / 浅色 / 自动 不出现在设置页中）
    expect(screen.queryByRole("radio", { name: "浅色" })).toBeNull()
    expect(screen.queryByRole("radio", { name: "深色" })).toBeNull()
    expect(screen.queryByRole("radio", { name: "自动" })).toBeNull()
  })

  it("选择新风格后保存按钮可用，但在点击保存前不直接改本地 store 风格", async () => {
    const userEventSetup = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 0 })
    renderSettings()

    const saveBtn = getThemeSaveBtn()
    expect(saveBtn).toBeDisabled()

    // 切换至「纸面」
    await userEventSetup.click(screen.getByRole("radio", { name: "纸面" }))

    // 保存按钮变为可用
    expect(saveBtn).toBeEnabled()

    // 本地 store 中的 style 此时仍维持 nova，未被修改
    expect(useThemeStore.getState().style).toBe("nova")

    // 切回 Nova，保存按钮重新禁用
    await userEventSetup.click(screen.getByRole("radio", { name: "Nova" }))
    expect(saveBtn).toBeDisabled()
  })

  it("点击保存后调用 meApi.updateThemeStyle，成功后更新账号状态与本地 store 并显示成功提示", async () => {
    const userEventSetup = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 0 })
    const updatedUser = {
      ...useAuthStore.getState().user!,
      themeStyle: "paper" as ThemeStyle
    }
    vi.mocked(meApi.updateThemeStyle).mockResolvedValue(updatedUser)

    renderSettings()

    const saveBtn = getThemeSaveBtn()
    await userEventSetup.click(screen.getByRole("radio", { name: "纸面" }))
    expect(saveBtn).toBeEnabled()

    // 点击保存
    await userEventSetup.click(saveBtn)

    // 调用接口保存
    expect(meApi.updateThemeStyle).toHaveBeenCalledWith("paper")

    // 更新了 auth store 与 theme store
    expect(useAuthStore.getState().user?.themeStyle).toBe("paper")
    expect(useThemeStore.getState().style).toBe("paper")
    expect(useThemeStore.getState().migratedAt).toBeTruthy()
    expect(localStorage.getItem("ciki-theme")).toContain('"migratedAt":')

    // 显示成功提示反馈
    expect(await screen.findByText("主题风格已保存。")).toBeInTheDocument()

    // 保存按钮重置为禁用
    expect(saveBtn).toBeDisabled()
  })

  it("保存失败时显示错误提示，本地 store 保持不变，保存按钮保持可用", async () => {
    const userEventSetup = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 0 })
    vi.mocked(meApi.updateThemeStyle).mockRejectedValue(
      new ApiError(
        400,
        "themeStyle must be nova or paper",
        "INVALID_THEME_STYLE"
      )
    )

    renderSettings()

    const saveBtn = getThemeSaveBtn()
    await userEventSetup.click(screen.getByRole("radio", { name: "纸面" }))
    await userEventSetup.click(saveBtn)

    // 本地 store 保持 nova
    expect(useThemeStore.getState().style).toBe("nova")
    expect(useThemeStore.getState().migratedAt).toBeNull()

    // 弹出错误提示
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "themeStyle must be nova or paper"
    )

    // 保存按钮保持可用以支持重试
    expect(saveBtn).toBeEnabled()
  })
})

describe("Passkey 与 TOTP 加名字与管理功能", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh")
    vi.mocked(meApi.sessions).mockResolvedValue([])
    vi.mocked(authApi.totpSetup).mockReset()
    vi.mocked(authApi.totpEnable).mockReset()
    vi.mocked(authApi.passkeyRegisterOptions).mockReset()
    vi.mocked(authApi.passkeyRegisterVerify).mockReset()
    vi.mocked(authApi.passkeyRename).mockReset()
    vi.mocked(authApi.passkeyRemove).mockReset()
    vi.mocked(authApi.passkeyDisableAll).mockReset()
  })

  it("添加 Passkey 弹出命名对话框，输入名字后注册随请求提交", async () => {
    const user = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 0 })
    vi.mocked(authApi.passkeyRegisterOptions).mockResolvedValue({
      challenge: "mock-challenge"
    })
    vi.mocked(authApi.passkeyRegisterVerify).mockResolvedValue({
      success: true
    })
    renderSettings()

    await user.click(screen.getByRole("button", { name: "添加 Passkey" }))
    expect(screen.getByLabelText("Passkey 名称")).toBeInTheDocument()

    await user.type(screen.getByLabelText("Passkey 名称"), "我的工作笔记本")
    await user.click(screen.getByRole("button", { name: "继续" }))

    expect(authApi.passkeyRegisterOptions).toHaveBeenCalledWith(undefined)
    expect(authApi.passkeyRegisterVerify).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mock-credential-id" }),
      undefined,
      "我的工作笔记本"
    )
  })

  it("添加 Passkey 留空名字时，以 undefined 提交给后端自动生成默认名", async () => {
    const user = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 0 })
    vi.mocked(authApi.passkeyRegisterOptions).mockResolvedValue({
      challenge: "mock-challenge"
    })
    vi.mocked(authApi.passkeyRegisterVerify).mockResolvedValue({
      success: true
    })
    renderSettings()

    await user.click(screen.getByRole("button", { name: "添加 Passkey" }))
    await user.click(screen.getByRole("button", { name: "继续" }))

    expect(authApi.passkeyRegisterVerify).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mock-credential-id" }),
      undefined,
      undefined
    )
  })

  it("Passkey 逐个列表显示：名字、创建时间、最近使用时间（未使用与具体时间）、改名与删除按钮", () => {
    setUser({
      totpEnabled: false,
      passkeyCount: 2,
      passkeys: [
        {
          name: "公司电脑",
          createdAt: "2026-11-20T08:30:00.000Z",
          lastUsedAt: null,
          credentialId: "cred-work"
        },
        {
          name: "个人手机",
          createdAt: "2026-11-21T10:00:00.000Z",
          lastUsedAt: "2026-11-25T05:00:00.000Z",
          credentialId: "cred-mobile"
        }
      ]
    })
    renderSettings()

    expect(screen.getByText("公司电脑")).toBeInTheDocument()
    expect(screen.getByText("个人手机")).toBeInTheDocument()

    // 公司电脑 lastUsedAt 为空 -> 显示「未使用」
    expect(screen.getByText(/最近使用：未使用/)).toBeInTheDocument()
    // 创建时间
    expect(screen.getAllByText(/创建于/).length).toBe(2)

    // 每行都有改名与删除
    expect(screen.getAllByRole("button", { name: "改名" })).toHaveLength(2)
    expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(2)
    // 存在凭证时显示「全部移除」
    expect(screen.getByRole("button", { name: "全部移除" })).toBeInTheDocument()
  })

  it("Passkey 改名：打开改名对话框，输入新名称保存后调 PATCH /passkey/:credentialId，无需密码", async () => {
    const user = userEvent.setup()
    setUser({
      totpEnabled: false,
      passkeyCount: 1,
      passkeys: [
        {
          name: "旧名字",
          createdAt: "2026-11-20T08:30:00.000Z",
          lastUsedAt: null,
          credentialId: "cred-1"
        }
      ]
    })
    vi.mocked(authApi.passkeyRename).mockResolvedValue({
      success: true,
      name: "新名字"
    })
    renderSettings()

    await user.click(screen.getByRole("button", { name: "改名" }))
    const input = screen.getByLabelText("Passkey 名称")
    expect(input).toHaveValue("旧名字")

    await user.clear(input)
    await user.type(input, "新名字")
    await user.click(screen.getByRole("button", { name: "保存" }))

    expect(authApi.passkeyRename).toHaveBeenCalledWith("cred-1", "新名字")
    // 不会弹出密码确认框
    expect(screen.queryByLabelText("账号密码")).toBeNull()
  })

  it("Passkey 单个删除：点击删除弹出密码确认对话框，验证后调 DELETE /passkey/:credentialId", async () => {
    const user = userEvent.setup()
    setUser({
      totpEnabled: false,
      passkeyCount: 1,
      passkeys: [
        {
          name: "待删凭证",
          createdAt: "2026-11-20T08:30:00.000Z",
          lastUsedAt: null,
          credentialId: "cred-del"
        }
      ]
    })
    vi.mocked(authApi.passkeyRemove).mockResolvedValue({ success: true })
    renderSettings()

    // 模拟先触发一个其它操作的页面级报错（例如两次输入密码不一致）
    await user.type(screen.getByLabelText("当前密码"), "oldpassword")
    await user.type(screen.getByLabelText("新密码（至少 8 位）"), "password123")
    await user.type(screen.getByLabelText("再次输入新密码"), "different")
    await user.click(screen.getByRole("button", { name: "更新密码" }))
    expect(screen.getByText("两次输入的新密码不一致")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "删除" }))
    // 弹出密码确认对话框
    expect(screen.getByText("删除 Passkey")).toBeInTheDocument()
    expect(
      screen.getByText("确定要删除「待删凭证」吗？删除后无法再使用它登录。")
    ).toBeInTheDocument()
    // 打开删除弹窗时已清理 error，弹窗内不应残留前置错误
    expect(screen.queryByText("两次输入的新密码不一致")).toBeNull()

    const passwordInput = screen.getByLabelText("账号密码")
    await user.type(passwordInput, "my-pass")
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "删除" })
    )

    expect(authApi.passkeyRemove).toHaveBeenCalledWith("cred-del", "my-pass")
  })

  it("Passkey 全部移除：调用 passkeyDisableAll", async () => {
    const user = userEvent.setup()
    setUser({
      totpEnabled: false,
      passkeyCount: 2
    })
    vi.mocked(authApi.passkeyDisableAll).mockResolvedValue({ success: true })
    renderSettings()

    await user.click(screen.getByRole("button", { name: "全部移除" }))
    expect(screen.getByText("移除全部 Passkey")).toBeInTheDocument()

    const passwordInput = screen.getByLabelText("账号密码")
    await user.type(passwordInput, "my-pass")
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "全部移除"
      })
    )

    expect(authApi.passkeyDisableAll).toHaveBeenCalledWith("my-pass")
  })

  it("TOTP 设置流程：在生成二维码之前输入名字，setup 与 enable 均提交该名字", async () => {
    const user = userEvent.setup()
    setUser({ totpEnabled: false, passkeyCount: 0 })
    vi.mocked(authApi.totpSetup).mockResolvedValue({
      secret: "JBSWY3DPEHPK3PXP",
      uri: "otpauth://totp/ciki:我的手机?secret=JBSWY3DPEHPK3PXP"
    })
    vi.mocked(authApi.totpEnable).mockResolvedValue({ success: true })
    renderSettings()

    await user.click(screen.getByRole("button", { name: "开始配置" }))
    expect(screen.getByLabelText("验证器名称")).toBeInTheDocument()

    await user.type(screen.getByLabelText("验证器名称"), "我的手机")
    await user.click(screen.getByRole("button", { name: "继续" }))

    expect(authApi.totpSetup).toHaveBeenCalledWith(undefined, "我的手机")

    // 输入验证码并启用
    await screen.findByText("JBSWY3DPEHPK3PXP")
    await user.type(screen.getByLabelText("6 位验证码"), "654321")
    await user.click(screen.getByRole("button", { name: "启用" }))

    expect(authApi.totpEnable).toHaveBeenCalledWith(
      "654321",
      undefined,
      "我的手机"
    )
  })

  it("TOTP 显示：已启用时展示名字 Badge，未启用时不展示", () => {
    // 未启用状态
    setUser({ totpEnabled: false, passkeyCount: 0 })
    const { unmount } = renderSettings()
    expect(screen.queryByText("默认手机验证器")).toBeNull()
    unmount()

    // 已启用状态，带自定义 totpName
    setUser({
      totpEnabled: true,
      totpName: "默认手机验证器",
      passkeyCount: 0
    })
    renderSettings()
    expect(screen.getByText("默认手机验证器")).toBeInTheDocument()
  })
})
