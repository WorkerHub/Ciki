import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
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
