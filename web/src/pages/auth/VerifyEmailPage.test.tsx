import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api"
import type { VerifyEmailNavState } from "@/lib/email-verification"
import { VerifyEmailPage } from "@/pages/auth/VerifyEmailPage"
import { DEFAULT_SITE_NAME, useSiteStore } from "@/stores/site"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    authApi: {
      ...actual.authApi,
      verifyEmail: vi.fn(),
      resendVerificationEmail: vi.fn()
    }
  }
})

const { authApi } = await import("@/lib/api")

const renderPage = (state?: VerifyEmailNavState | null, search = "") =>
  render(
    <MemoryRouter
      initialEntries={[{ pathname: "/verify-email", state, search }]}
    >
      <VerifyEmailPage />
    </MemoryRouter>
  )

const RESENT = { success: true as const, cooldownSeconds: 60 }

beforeEach(() => {
  useSiteStore.setState({
    name: DEFAULT_SITE_NAME,
    emailConfigured: true,
    loaded: true
  })
  vi.mocked(authApi.verifyEmail).mockResolvedValue({ success: true })
  vi.mocked(authApi.resendVerificationEmail).mockResolvedValue(RESENT)
})

/**
 * 注册邮箱验证（#85 冻结契约）：未登录可访问，只认邮箱 + 6 位码；
 * 成功后不发放会话，引导回登录页。
 */
describe("验证页：从注册页带过来的状态", () => {
  const FROM_REGISTER: VerifyEmailNavState = {
    email: "a@b.c",
    codeSent: true,
    approvalRequired: false
  }

  it("邮箱预填、说明发到哪里，重发先按 60 秒冷却锁住", () => {
    renderPage(FROM_REGISTER)

    expect(
      screen.getByRole("heading", { name: "验证邮箱" })
    ).toBeInTheDocument()
    expect(
      screen.getByText(/输入发到 a@b\.c 的 6 位验证码/)
    ).toBeInTheDocument()
    expect(screen.getByLabelText("邮箱")).toHaveValue("a@b.c")
    expect(screen.getByText(/10 分钟内有效/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "60s 后可重发" })).toBeDisabled()
  })

  it("输入 6 位码提交后置为已验证，给出回登录页的入口", async () => {
    const events = userEvent.setup()
    renderPage(FROM_REGISTER)

    // 码不足 6 位时提交按钮不装能点
    expect(screen.getByRole("button", { name: "验证" })).toBeDisabled()
    await events.type(screen.getByLabelText("邮箱验证码"), "123456")
    await events.click(screen.getByRole("button", { name: "验证" }))

    expect(authApi.verifyEmail).toHaveBeenCalledWith("a@b.c", "123456")
    expect(
      await screen.findByRole("heading", { name: "邮箱已验证" })
    ).toBeInTheDocument()
    expect(
      screen.getByText(/a@b\.c 已验证通过，现在可以用它登录了/)
    ).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "去登录" })).toHaveAttribute(
      "href",
      "/login"
    )
  })

  it("账号还在等管理员批准时，成功页如实说明还要等审批", async () => {
    const events = userEvent.setup()
    renderPage({ ...FROM_REGISTER, approvalRequired: true })

    await events.type(screen.getByLabelText("邮箱验证码"), "123456")
    await events.click(screen.getByRole("button", { name: "验证" }))

    expect(
      await screen.findByText(
        /账号还在等待管理员批准，批准后就能用这个邮箱登录/
      )
    ).toBeInTheDocument()
  })

  it("验证码只接受 6 位数字", async () => {
    const events = userEvent.setup()
    renderPage(FROM_REGISTER)

    await events.type(screen.getByLabelText("邮箱验证码"), "12ab345678")
    expect(screen.getByLabelText("邮箱验证码")).toHaveValue("123456")
  })
})

describe("验证页：错码与限流", () => {
  it("错码、过期、未知邮箱同一句话，输入还在、可以就地重试", async () => {
    vi.mocked(authApi.verifyEmail).mockRejectedValue(
      new ApiError(
        400,
        "Invalid or expired code",
        "INVALID_CODE",
        undefined,
        { error: "Invalid or expired code", code: "INVALID_CODE" },
        "/auth/email/verify"
      )
    )
    const events = userEvent.setup()
    renderPage({ email: "a@b.c" })

    await events.type(screen.getByLabelText("邮箱验证码"), "000000")
    await events.click(screen.getByRole("button", { name: "验证" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "验证码不正确或已过期。"
    )
    expect(screen.getByLabelText("邮箱验证码")).toHaveValue("000000")
    expect(screen.getByRole("button", { name: "验证" })).toBeEnabled()
  })

  it("验码被限流时按 retryAfter 挡住提交并给出剩余时间", async () => {
    vi.mocked(authApi.verifyEmail).mockRejectedValue(
      new ApiError(429, "Too many requests", "RATE_LIMITED", 90)
    )
    const events = userEvent.setup()
    renderPage({ email: "a@b.c" })

    await events.type(screen.getByLabelText("邮箱验证码"), "000000")
    await events.click(screen.getByRole("button", { name: "验证" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "操作过于频繁，请在 2 分钟后重试。"
    )
    expect(screen.getByRole("button", { name: "验证" })).toBeDisabled()
  })
})

describe("验证页：重发验证码", () => {
  it("直接开链接（?email=）时重发可点，成功后进入 60 秒冷却并清掉旧码", async () => {
    const events = userEvent.setup()
    renderPage(null, "?email=c@d.e")

    expect(screen.getByLabelText("邮箱")).toHaveValue("c@d.e")
    await events.type(screen.getByLabelText("邮箱验证码"), "123456")
    await events.click(screen.getByRole("button", { name: "重新发送验证码" }))

    expect(authApi.resendVerificationEmail).toHaveBeenCalledWith("c@d.e")
    expect(await screen.findByRole("status")).toHaveTextContent(
      "验证码已发送到 c@d.e，10 分钟内有效。"
    )
    expect(screen.getByRole("button", { name: "60s 后可重发" })).toBeDisabled()
    expect(screen.getByLabelText("邮箱验证码")).toHaveValue("")
  })

  it("重发被限流时按 retryAfter 起冷却，并说清还要等多久", async () => {
    vi.mocked(authApi.resendVerificationEmail).mockRejectedValue(
      new ApiError(429, "Too many requests", "RATE_LIMITED", 300)
    )
    const events = userEvent.setup()
    renderPage({ email: "a@b.c" })

    await events.click(screen.getByRole("button", { name: "重新发送验证码" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "操作过于频繁，请在 5 分钟后重试。"
    )
    expect(screen.getByRole("button", { name: "300s 后可重发" })).toBeDisabled()
  })

  it("重发时服务端回 EMAIL_NOT_CONFIGURED，当场切成不可用并同步站点状态", async () => {
    vi.mocked(authApi.resendVerificationEmail).mockRejectedValue(
      new ApiError(
        503,
        "Email delivery is not configured",
        "EMAIL_NOT_CONFIGURED"
      )
    )
    const events = userEvent.setup()
    renderPage({ email: "a@b.c" })

    await events.click(screen.getByRole("button", { name: "重新发送验证码" }))

    expect(
      await screen.findByText(
        /站点还没有配置发信（SMTP），暂时无法通过邮件验证邮箱/
      )
    ).toBeInTheDocument()
    expect(useSiteStore.getState().emailConfigured).toBe(false)
  })
})

describe("验证页：站点没配发信", () => {
  it("公开配置说不可用就整页换成说明，不摆一个收不到码的表单", () => {
    useSiteStore.setState({ loaded: true, emailConfigured: false })
    renderPage({ email: "a@b.c" })

    expect(
      screen.getByText(/站点还没有配置发信（SMTP），暂时无法通过邮件验证邮箱/)
    ).toBeInTheDocument()
    expect(screen.getByText(/系统管理 → 邮件配置/)).toBeInTheDocument()
    expect(screen.queryByLabelText("邮箱验证码")).toBeNull()
    expect(screen.getByRole("link", { name: "返回登录" })).toHaveAttribute(
      "href",
      "/login"
    )
  })

  it("站点信息还没读到时先按可用渲染，不闪一下「不可用」", () => {
    useSiteStore.setState({ loaded: false, emailConfigured: false })
    renderPage({ email: "a@b.c" })

    expect(screen.getByLabelText("邮箱验证码")).toBeInTheDocument()
    expect(screen.queryByText(/暂时无法通过邮件验证邮箱/)).toBeNull()
  })
})
