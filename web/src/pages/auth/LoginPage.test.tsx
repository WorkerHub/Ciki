import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import { ApiError } from "@/lib/api"
import type { VerifyEmailNavState } from "@/lib/email-verification"
import { LoginPage } from "@/pages/auth/LoginPage"
import { useSiteStore } from "@/stores/site"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    authApi: {
      ...actual.authApi,
      login: vi.fn(),
      verifySecondFactor: vi.fn(),
      sendLoginEmailCode: vi.fn(),
      resendVerificationEmail: vi.fn(),
      config: vi.fn()
    },
    meApi: { ...actual.meApi, get: vi.fn() }
  }
})

const { authApi, meApi } = await import("@/lib/api")

/** 验证页占位：把 login 带过去的路由状态原样打出来，供断言。 */
function VerifyProbe() {
  const state = useLocation().state as VerifyEmailNavState | null
  return (
    <p>
      验证页占位 {state?.email} {state?.codeSent ? "已发码" : "未发码"}
    </p>
  )
}

const renderLogin = () =>
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <LoginPage />
    </MemoryRouter>
  )

/**
 * 未登录页的旧标语已整行删除（用户 2026-11-10 拍板，不留替代文案）：
 * AuthShell 的 subtitle 可选，不传就不渲染 <p>，标题块不留空位。
 */
describe("登录页标语", () => {
  it("标题块只有 Logo 与标题，不渲染标语段落（故不留空位）", () => {
    renderLogin()
    const heading = screen.getByRole("heading", { level: 1 })
    const header = heading.parentElement as HTMLElement
    // AuthShell 的 subtitle 可选：不传就完全没有 <p>，没有留给标语的空段落
    expect(header.querySelector("p")).toBeNull()
    expect(header.textContent?.trim()).toBe(heading.textContent?.trim())
  })
})

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
      id: 1,
      username: "管理员",
      avatarUrl: null,
      email: "a@b.c",
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
    vi.mocked(authApi.verifySecondFactor).mockRejectedValue(
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
    vi.mocked(authApi.verifySecondFactor).mockRejectedValue(
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

/**
 * 邮箱验证码作为第二种登录方式（契约 #48/#50）：
 * 第二步沿用现有多方式界面，选「邮箱验证码」即向账号邮箱发码，输对放行。
 */
describe("登录第二步的邮箱验证码", () => {
  const user = () => ({
    id: 1,
    username: "管理员",
    avatarUrl: null,
    email: "a@b.c",
    role: "admin" as const,
    approvalStatus: "approved" as const,
    createdAt: "2026-11-07T00:00:00.000Z",
    twofa: {
      totpEnabled: true,
      passkeyEnabled: true,
      passkeyCount: 1,
      emailOtpEnabled: true
    }
  })

  const toSecondStep = async (methods: string[]) => {
    vi.mocked(authApi.login).mockResolvedValue({
      requires2fa: true,
      tempToken: "temp-token",
      availableMethods: methods
    })
    const events = userEvent.setup()
    renderLogin()
    await events.type(screen.getByLabelText("邮箱"), "a@b.c")
    await events.type(screen.getByLabelText("密码"), "secret-password")
    await events.click(screen.getByRole("button", { name: "登录" }))
    return events
  }

  beforeEach(() => {
    vi.mocked(meApi.get).mockResolvedValue(user())
    vi.mocked(authApi.sendLoginEmailCode).mockResolvedValue({
      success: true,
      cooldownSeconds: 60,
      expiresInSeconds: 600
    })
  })

  it("多方式时列出邮箱验证码；选中即发码，输入 6 位码按 email_otp 验证", async () => {
    const events = await toSecondStep(["totp", "passkey", "email_otp"])

    // 默认落在第一个可用方式（TOTP），三种方式都在切换器里
    await screen.findByLabelText("动态验证码")
    expect(
      screen.getByRole("radio", { name: "验证器 App" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("radio", { name: "邮箱验证码" })
    ).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "Passkey" })).toBeInTheDocument()
    expect(authApi.sendLoginEmailCode).not.toHaveBeenCalled()

    await events.click(screen.getByRole("radio", { name: "邮箱验证码" }))

    await waitFor(() => {
      expect(authApi.sendLoginEmailCode).toHaveBeenCalledWith("temp-token")
    })
    const code = await screen.findByLabelText("邮箱验证码")
    expect(code).toHaveAttribute("type", "text")
    expect(code).toHaveAttribute("autocomplete", "one-time-code")
    expect(code.getAttribute("name")).not.toMatch(/password/i)
    expect(screen.getByText(/验证码已发送到 a@b.c/)).toBeInTheDocument()
    // 60s 冷却期内不能重发
    expect(screen.getByRole("button", { name: /后可重发/ })).toBeDisabled()

    await events.type(code, "654321")
    await events.click(screen.getByRole("button", { name: "验证并登录" }))

    expect(authApi.verifySecondFactor).toHaveBeenCalledWith(
      "temp-token",
      "email_otp",
      "654321"
    )
  })

  it("只启用邮箱验证码时自动发一封，不出现切换器", async () => {
    await toSecondStep(["email_otp"])

    expect(await screen.findByLabelText("邮箱验证码")).toBeInTheDocument()
    await waitFor(() => {
      expect(authApi.sendLoginEmailCode).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByRole("radio", { name: "验证器 App" })).toBeNull()
  })

  it("退回第一步再登录（仍拿到同一个 tempToken）会重新自动发码", async () => {
    const events = await toSecondStep(["email_otp"])
    await waitFor(() => {
      expect(authApi.sendLoginEmailCode).toHaveBeenCalledTimes(1)
    })

    await events.click(screen.getByRole("button", { name: "返回上一步" }))
    await screen.findByLabelText("密码")
    // 第一步的输入值还在（组件没卸载），重输前先清空，别把两次内容拼起来
    await events.clear(screen.getByLabelText("邮箱"))
    await events.type(screen.getByLabelText("邮箱"), "a@b.c")
    await events.clear(screen.getByLabelText("密码"))
    await events.type(screen.getByLabelText("密码"), "secret-password")
    await events.click(screen.getByRole("button", { name: "登录" }))
    await screen.findByLabelText("邮箱验证码")

    // 旧的「已自动发过码」记账必须作废，否则同一个 tempToken 会卡在未发送状态
    await waitFor(() => {
      expect(authApi.sendLoginEmailCode).toHaveBeenCalledTimes(2)
    })
  })

  it("站点发信未配置时说明原因，不停在一句网络异常", async () => {
    vi.mocked(authApi.sendLoginEmailCode).mockRejectedValue(
      new ApiError(
        503,
        "Email delivery is not configured",
        "EMAIL_NOT_CONFIGURED",
        undefined,
        {
          error: "Email delivery is not configured",
          code: "EMAIL_NOT_CONFIGURED"
        },
        "/auth/2fa/email-otp/send-login"
      )
    )
    await toSecondStep(["email_otp"])

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(
      "还没有配置可用的 SMTP，请先在系统管理 → 邮件配置里填写。"
    )
  })
})

/**
 * 找回密码入口（契约 #54）：登录页只放入口链接，三步流程在 /forgot-password。
 * 站点没配发信时入口不可点，并在同一屏写明去哪里配置 —— 不摆点了才报错的链接。
 */
describe("忘记密码入口", () => {
  it("站点配好发信时给出可点的「忘记密码？」链接", () => {
    useSiteStore.setState({ loaded: true, emailConfigured: true })
    renderLogin()

    expect(screen.getByRole("link", { name: "忘记密码？" })).toHaveAttribute(
      "href",
      "/forgot-password"
    )
  })

  it("站点没配发信时入口不可点，并写明去系统管理 → 邮件配置", () => {
    useSiteStore.setState({ loaded: true, emailConfigured: false })
    renderLogin()

    expect(screen.queryByRole("link", { name: "忘记密码？" })).toBeNull()
    expect(screen.getByText("忘记密码？")).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    expect(screen.getByText(/系统管理 → 邮件配置/)).toBeInTheDocument()
  })

  it("站点信息还没读到时先按可用渲染，不闪一下「不可用」", () => {
    useSiteStore.setState({ loaded: false, emailConfigured: false })
    renderLogin()

    expect(screen.getByRole("link", { name: "忘记密码？" })).toBeInTheDocument()
    expect(screen.queryByText(/系统管理 → 邮件配置/)).toBeNull()
  })
})

/**
 * 登录门禁里的「邮箱未验证」（#85 契约）：密码对了但 email_verified=0 时是
 * 403 `EMAIL_NOT_VERIFIED`。登录页不能只说一句错，要给验证页与重发两个入口。
 */
describe("登录遇未验证邮箱", () => {
  const notVerified = () =>
    new ApiError(
      403,
      "Email not verified",
      "EMAIL_NOT_VERIFIED",
      undefined,
      { error: "Email not verified", code: "EMAIL_NOT_VERIFIED" },
      "/auth/login"
    )

  const attemptLogin = async () => {
    const events = userEvent.setup()
    renderLogin()
    await events.type(screen.getByLabelText("邮箱"), "a@b.c")
    await events.type(screen.getByLabelText("密码"), "secret-password")
    await events.click(screen.getByRole("button", { name: "登录" }))
    return events
  }

  beforeEach(() => {
    vi.mocked(authApi.login).mockRejectedValue(notVerified())
    vi.mocked(authApi.resendVerificationEmail).mockResolvedValue({
      success: true,
      cooldownSeconds: 60
    })
  })

  it("提示邮箱未验证，并给「去验证」与「重新发送验证码」两个入口", async () => {
    await attemptLogin()

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("a@b.c 还没有验证邮箱，验证后才能登录。")
    // 与「会话失效」区分开：这是账号状态，不是登录态过期
    expect(alert).not.toHaveTextContent("登录状态已失效")
    expect(screen.getByRole("link", { name: "去验证" })).toHaveAttribute(
      "href",
      "/verify-email"
    )
    expect(screen.getByRole("button", { name: "重新发送验证码" })).toBeEnabled()
    // 密码框还在，换账号重试也方便
    expect(screen.getByLabelText("密码")).toBeInTheDocument()
  })

  it("点「重新发送验证码」发到同一个邮箱，成功后进入 60 秒冷却", async () => {
    const events = await attemptLogin()
    await screen.findByRole("alert")

    await events.click(screen.getByRole("button", { name: "重新发送验证码" }))

    expect(authApi.resendVerificationEmail).toHaveBeenCalledWith("a@b.c")
    expect(await screen.findByRole("status")).toHaveTextContent(
      "验证码已发送到 a@b.c，10 分钟内有效。"
    )
    expect(screen.getByRole("button", { name: "60s 后可重发" })).toBeDisabled()
  })

  it("重发被限流时按 retryAfter 起冷却并带出剩余时间", async () => {
    vi.mocked(authApi.resendVerificationEmail).mockRejectedValue(
      new ApiError(429, "Too many requests", "RATE_LIMITED", 120)
    )
    const events = await attemptLogin()
    await screen.findByRole("alert")

    await events.click(screen.getByRole("button", { name: "重新发送验证码" }))

    expect(await screen.findByRole("status")).toHaveTextContent(
      "操作过于频繁，请在 2 分钟后重试。"
    )
    expect(screen.getByRole("button", { name: "120s 后可重发" })).toBeDisabled()
  })

  it("刚在这页重发过再点「去验证」：验证页接着按冷却计，邮箱一并带过去", async () => {
    const events = userEvent.setup()
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/verify-email" element={<VerifyProbe />} />
        </Routes>
      </MemoryRouter>
    )

    await events.type(screen.getByLabelText("邮箱"), "a@b.c")
    await events.type(screen.getByLabelText("密码"), "secret-password")
    await events.click(screen.getByRole("button", { name: "登录" }))
    await screen.findByRole("alert")
    await events.click(screen.getByRole("button", { name: "重新发送验证码" }))
    await screen.findByRole("status")
    await events.click(screen.getByRole("link", { name: "去验证" }))

    expect(
      await screen.findByText("验证页占位 a@b.c 已发码")
    ).toBeInTheDocument()
  })

  it("换一次登录会清掉未验证提示，不把上一次的结论留在屏上", async () => {
    const events = await attemptLogin()
    await screen.findByRole("alert")

    vi.mocked(authApi.login).mockRejectedValue(
      new ApiError(
        403,
        "Account was rejected",
        "ACCOUNT_REJECTED",
        undefined,
        { error: "Account was rejected", code: "ACCOUNT_REJECTED" },
        "/auth/login"
      )
    )
    await events.click(screen.getByRole("button", { name: "登录" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "该账号的注册申请已被拒绝，请联系管理员。"
    )
    expect(screen.queryByRole("link", { name: "去验证" })).toBeNull()
  })
})

/**
 * 注册入口（#85 契约）：自助注册后必须验证邮箱，站点没配发信时注册走不通，
 * 入口整条收起并说明原因，不摆一个点了必然 503 的链接。
 */
describe("注册入口与发信状态", () => {
  it("站点配好发信时给出可点的「注册」链接", () => {
    useSiteStore.setState({ loaded: true, emailConfigured: true })
    renderLogin()

    expect(screen.getByRole("link", { name: "注册" })).toHaveAttribute(
      "href",
      "/register"
    )
  })

  it("站点没配发信时收起注册入口，并说明账号找管理员开通", () => {
    useSiteStore.setState({ loaded: true, emailConfigured: false })
    renderLogin()

    expect(screen.queryByRole("link", { name: "注册" })).toBeNull()
    expect(screen.getByText("账号请联系管理员开通。")).toBeInTheDocument()
    // 上面那行原因说明同时覆盖找回密码与自助注册，不重复解释 SMTP
    expect(
      screen.getByText(/邮件找回密码与自助注册暂不可用/)
    ).toBeInTheDocument()
  })

  it("站点信息还没读到时先按可注册渲染", () => {
    useSiteStore.setState({ loaded: false, emailConfigured: false })
    renderLogin()

    expect(screen.getByRole("link", { name: "注册" })).toBeInTheDocument()
  })
})

/** 英文界面：登录页（含两步验证步）全英文，无中文残留。 */
describe("登录页：英文界面", () => {
  it("第一步的标题、标签与两个入口都是英文", async () => {
    useSiteStore.setState({ name: "Ciki", loaded: true, emailConfigured: true })
    await i18n.changeLanguage("en")
    const { container } = renderLogin()

    expect(
      screen.getByRole("heading", { name: "Sign in to Ciki" })
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Email")).toBeInTheDocument()
    expect(screen.getByLabelText("Password")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Register" })).toHaveAttribute(
      "href",
      "/register"
    )
    expect(
      screen.getByRole("link", { name: "Forgot password?" })
    ).toHaveAttribute("href", "/forgot-password")
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it("第二步的方式名与按钮也是英文", async () => {
    vi.mocked(authApi.login).mockResolvedValue({
      requires2fa: true,
      tempToken: "temp-token",
      availableMethods: ["totp", "email_otp"]
    })
    await i18n.changeLanguage("en")
    const events = userEvent.setup()
    const { container } = renderLogin()
    await events.type(screen.getByLabelText("Email"), "a@b.c")
    await events.type(screen.getByLabelText("Password"), "secret-password")
    await events.click(screen.getByRole("button", { name: "Sign in" }))

    expect(
      await screen.findByRole("heading", { name: "Two-factor authentication" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("radio", { name: "Authenticator app" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Verify and sign in" })
    ).toBeDisabled()
    expect(
      await screen.findByLabelText("Authentication code")
    ).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/)
  })
})
