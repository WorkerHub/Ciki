import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { SettingsPage } from "@/pages/SettingsPage"
import { useAuthStore } from "@/stores/auth"

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
      passkeyDisableAll: vi.fn()
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

function setUser(twofa: { totpEnabled: boolean; passkeyCount: number }) {
  useAuthStore.setState({
    user: {
      id: "u1",
      email: "admin@example.com",
      role: "admin",
      approvalStatus: "approved",
      createdAt: "2026-11-07T00:00:00.000Z",
      twofa: { ...twofa, passkeyEnabled: twofa.passkeyCount > 0 }
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
      email: "admin@example.com",
      role: "admin",
      approvalStatus: "approved",
      createdAt: "2026-11-07T00:00:00.000Z",
      twofa: { totpEnabled: true, passkeyEnabled: false, passkeyCount: 0 }
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
    setUser({ totpEnabled: true, passkeyCount: 0 })
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
    setUser({ totpEnabled: false, passkeyCount: 0 })
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
      email: "admin@example.com",
      role: "admin",
      approvalStatus: "approved",
      createdAt: "2026-11-07T00:00:00.000Z",
      twofa: { totpEnabled: true, passkeyEnabled: false, passkeyCount: 0 }
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
    setUser({ totpEnabled: false, passkeyCount: 0 })
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
    setUser({ totpEnabled: true, passkeyCount: 0 })
    renderSettings()

    expect(await screen.findByText("导入令牌")).toBeInTheDocument()
    expect(meApi.importToken).toHaveBeenCalledTimes(1)
    expect(
      await screen.findByRole("button", { name: "生成令牌" })
    ).toBeInTheDocument()
  })
})
