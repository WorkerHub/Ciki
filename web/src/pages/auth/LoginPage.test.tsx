import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api"
import { LoginPage } from "@/pages/auth/LoginPage"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    authApi: {
      ...actual.authApi,
      login: vi.fn(),
      verifyTotp: vi.fn(),
      config: vi.fn()
    },
    meApi: { ...actual.meApi, get: vi.fn() }
  }
})

const { authApi, meApi } = await import("@/lib/api")

const renderLogin = () =>
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <LoginPage />
    </MemoryRouter>
  )

/**
 * 规格 §8：两步登录换步必须换 DOM 节点，且 TOTP 输入框不能继承密码框的
 * type/autocomplete —— 否则 Bitwarden 之类的填充器会把账号密码填进验证码框。
 */
describe("登录两步表单", () => {
  beforeEach(() => {
    vi.mocked(authApi.login).mockResolvedValue({
      requires2fa: true,
      tempToken: "temp-token",
      availableMethods: ["totp"]
    })
    vi.mocked(meApi.get).mockResolvedValue({
      id: "u1",
      publicId: "AB23CD45",
      username: "管理员",
      avatarUrl: null,
      email: "a@b.c",
      role: "admin",
      approvalStatus: "approved",
      createdAt: "2026-11-07T00:00:00.000Z",
      twofa: { totpEnabled: true, passkeyEnabled: false, passkeyCount: 0 }
    })
  })

  it("第一步的密码框是 type=password，且不叫 otp-code", () => {
    renderLogin()
    const password = screen.getByLabelText("密码")
    expect(password).toHaveAttribute("type", "password")
    expect(password).toHaveAttribute("name", "password")
  })

  it("换步时密码框与表单都换成新的 DOM 节点", async () => {
    const user = userEvent.setup()
    renderLogin()

    const passwordForm = document.getElementById("password-step")
    const passwordInput = screen.getByLabelText("密码")
    expect(passwordForm).not.toBeNull()
    expect(passwordInput).toBeInTheDocument()

    await user.type(screen.getByLabelText("邮箱"), "a@b.c")
    await user.type(screen.getByLabelText("密码"), "secret-password")
    await user.click(screen.getByRole("button", { name: "登录" }))

    await screen.findByLabelText("动态验证码")

    const twoFaForm = document.getElementById("twofa-step")
    expect(twoFaForm).not.toBeNull()
    expect(twoFaForm).not.toBe(passwordForm)
    // 第一步的表单与输入框已经不在文档里，不存在「被复用」的可能
    expect(passwordForm?.isConnected).toBe(false)
    expect(passwordInput.isConnected).toBe(false)
  })

  it("TOTP 输入框是 text + one-time-code + numeric，name/id 不含 password", async () => {
    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText("邮箱"), "a@b.c")
    await user.type(screen.getByLabelText("密码"), "secret-password")
    await user.click(screen.getByRole("button", { name: "登录" }))

    const otp = await screen.findByLabelText("动态验证码")
    expect(otp).toHaveAttribute("type", "text")
    expect(otp).toHaveAttribute("autocomplete", "one-time-code")
    expect(otp).toHaveAttribute("inputmode", "numeric")
    expect(otp).toHaveAttribute("name", "otp-code")
    expect(otp).toHaveAttribute("id", "otp-code")
    expect(otp.getAttribute("name")).not.toMatch(/password/i)
    expect(otp.getAttribute("id")).not.toMatch(/password/i)

    const twoFaForm = document.getElementById("twofa-step")
    expect(twoFaForm?.querySelector('input[type="password"]')).toBeNull()
  })

  it("验证码只接受 6 位数字", async () => {
    const user = userEvent.setup()
    vi.mocked(authApi.login).mockResolvedValue({
      requires2fa: true,
      tempToken: "temp-token",
      availableMethods: ["totp"]
    })
    renderLogin()

    await user.type(screen.getByLabelText("邮箱"), "a@b.c")
    await user.type(screen.getByLabelText("密码"), "secret-password")
    await user.click(screen.getByRole("button", { name: "登录" }))

    const otp = await screen.findByLabelText("动态验证码")
    await user.type(otp, "12ab345678")
    expect(otp).toHaveValue("123456")
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "验证并登录" })).toBeEnabled()
    })
  })
})

/**
 * QA ciki #4 §9.6：两步验证输错码时提示「登录状态已失效」是误报 ——
 * 后端的 401 在此处表示「验证码不对」，不是 Cookie 会话过期。
 */
describe("两步验证的错误提示", () => {
  const toTwoFaStep = async () => {
    const user = userEvent.setup()
    renderLogin()
    await user.type(screen.getByLabelText("邮箱"), "a@b.c")
    await user.type(screen.getByLabelText("密码"), "secret-password")
    await user.click(screen.getByRole("button", { name: "登录" }))
    await screen.findByLabelText("动态验证码")
    return user
  }

  beforeEach(() => {
    vi.mocked(authApi.login).mockResolvedValue({
      requires2fa: true,
      tempToken: "temp-token",
      availableMethods: ["totp"]
    })
  })

  it("输错 6 位码 → 说验证码不对，停在两步表单，不说会话过期", async () => {
    const user = await toTwoFaStep()
    vi.mocked(authApi.verifyTotp).mockRejectedValue(
      new ApiError(
        401,
        "Invalid verification code",
        undefined,
        undefined,
        { error: "Invalid verification code" },
        "/auth/2fa/verify"
      )
    )

    await user.type(screen.getByLabelText("动态验证码"), "000000")
    await user.click(screen.getByRole("button", { name: "验证并登录" }))

    const alert = await screen.findByRole("alert")
    expect(document.getElementById("twofa-step")?.contains(alert)).toBe(true)
    expect(alert).toHaveTextContent("验证码不正确")
    expect(alert).not.toHaveTextContent("登录状态已失效")
    // 表单还在、输入框还能改：只清错误重输即可，不用回上一步
    expect(screen.getByLabelText("动态验证码")).toBeEnabled()
  })

  it("挑战已过期 → 提示回上一步重新登录", async () => {
    const user = await toTwoFaStep()
    vi.mocked(authApi.verifyTotp).mockRejectedValue(
      new ApiError(
        401,
        "Invalid or expired 2FA session",
        undefined,
        undefined,
        { error: "Invalid or expired 2FA session" },
        "/auth/2fa/verify"
      )
    )

    await user.type(screen.getByLabelText("动态验证码"), "123456")
    await user.click(screen.getByRole("button", { name: "验证并登录" }))

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("两步验证已失效，请返回上一步重新登录。")
  })

  it("第一步密码错 → 说邮箱或密码不正确", async () => {
    const user = userEvent.setup()
    renderLogin()
    vi.mocked(authApi.login).mockRejectedValue(
      new ApiError(
        401,
        "Invalid credentials",
        undefined,
        undefined,
        { error: "Invalid credentials" },
        "/auth/login"
      )
    )

    await user.type(screen.getByLabelText("邮箱"), "a@b.c")
    await user.type(screen.getByLabelText("密码"), "wrong-password")
    await user.click(screen.getByRole("button", { name: "登录" }))

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("邮箱或密码不正确。")
    expect(alert).not.toHaveTextContent("登录状态已失效")
  })
})
