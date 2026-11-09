import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api"
import { ForgotPasswordPage } from "@/pages/auth/ForgotPasswordPage"
import { DEFAULT_SITE_NAME, useSiteStore } from "@/stores/site"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    authApi: {
      ...actual.authApi,
      passwordForgot: vi.fn(),
      passwordVerify: vi.fn(),
      passwordReset: vi.fn()
    }
  }
})

const { authApi } = await import("@/lib/api")

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/forgot-password"]}>
      <ForgotPasswordPage />
    </MemoryRouter>
  )

const CODE_SENT = { success: true as const, cooldownSeconds: 60 }
const GRANT = {
  success: true as const,
  resetToken: "reset-token-1",
  expiresIn: 600
}

/** 走到输码步骤：填邮箱 → 发码。 */
async function toCodeStep(email = "a@b.c") {
  const events = userEvent.setup()
  renderPage()
  await events.type(screen.getByLabelText("邮箱"), email)
  await events.click(screen.getByRole("button", { name: /发送验证码/ }))
  await screen.findByLabelText("邮箱验证码")
  return events
}

/** 走到设密步骤：再输 6 位码通过验码。 */
async function toPasswordStep() {
  const events = await toCodeStep()
  await events.type(screen.getByLabelText("邮箱验证码"), "123456")
  await events.click(screen.getByRole("button", { name: "验证" }))
  await screen.findByLabelText("新密码（至少 8 位）")
  return events
}

beforeEach(() => {
  useSiteStore.setState({
    name: DEFAULT_SITE_NAME,
    emailConfigured: false,
    loaded: false
  })
  vi.mocked(authApi.passwordForgot).mockResolvedValue(CODE_SENT)
  vi.mocked(authApi.passwordVerify).mockResolvedValue(GRANT)
  vi.mocked(authApi.passwordReset).mockResolvedValue({ success: true })
})

/**
 * 邮箱找回密码（契约 #48/#51）：发码 → 验码换 resetToken → 设新密码。
 * 三条硬要求：发码结果不暴露账号是否存在、错码只说一句话、设密成功引导重新登录。
 */
describe("找回密码：三步流程", () => {
  it("站点配好发信时先要邮箱；发码后用中性文案进入输码，60s 内不能重发", async () => {
    await toCodeStep()

    expect(authApi.passwordForgot).toHaveBeenCalledWith("a@b.c")
    // 不断言「已发送到 xxx」：账号存在与否必须是同一句话
    expect(
      screen.getByText(/如果 a@b\.c 已注册，验证码会在几分钟内送达/)
    ).toBeInTheDocument()
    expect(screen.getByText(/连续输错 5 次会作废/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "60s 后可重发" })).toBeDisabled()
    expect(authApi.passwordForgot).toHaveBeenCalledTimes(1)
  })

  it("验码通过后设置新密码，成功后引导重新登录", async () => {
    const events = await toPasswordStep()

    expect(authApi.passwordVerify).toHaveBeenCalledWith("a@b.c", "123456")
    expect(screen.getByText(/请在 10 分钟内完成设置/)).toBeInTheDocument()

    await events.type(
      screen.getByLabelText("新密码（至少 8 位）"),
      "new-password-1"
    )
    await events.type(screen.getByLabelText("再次输入新密码"), "new-password-1")
    await events.click(screen.getByRole("button", { name: /保存新密码/ }))

    expect(authApi.passwordReset).toHaveBeenCalledWith(
      "reset-token-1",
      "new-password-1"
    )
    expect(
      await screen.findByRole("heading", { name: "密码已重置" })
    ).toBeInTheDocument()
    expect(
      screen.getByText(/这个账号之前的所有登录状态都已失效/)
    ).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "去登录" })).toHaveAttribute(
      "href",
      "/login"
    )
  })

  it("新密码不足 8 位或两次不一致时不提交，文案与注册页一致", async () => {
    const events = await toPasswordStep()

    await events.type(screen.getByLabelText("新密码（至少 8 位）"), "short")
    await events.type(screen.getByLabelText("再次输入新密码"), "short")
    await events.click(screen.getByRole("button", { name: /保存新密码/ }))

    expect(screen.getByRole("alert")).toHaveTextContent("新密码至少 8 位")
    expect(authApi.passwordReset).not.toHaveBeenCalled()

    await events.clear(screen.getByLabelText("新密码（至少 8 位）"))
    await events.type(
      screen.getByLabelText("新密码（至少 8 位）"),
      "long-enough-1"
    )
    await events.click(screen.getByRole("button", { name: /保存新密码/ }))

    expect(screen.getByRole("alert")).toHaveTextContent("两次输入的密码不一致")
    expect(authApi.passwordReset).not.toHaveBeenCalled()
  })

  it("换一个邮箱可以从输码步骤退回，邮箱保留", async () => {
    const events = await toCodeStep("first@example.com")

    await events.click(screen.getByRole("button", { name: "返回上一步" }))

    const input = await screen.findByLabelText("邮箱")
    expect(input).toHaveValue("first@example.com")
  })
})

describe("找回密码：错码与限流", () => {
  const invalidCode = () =>
    new ApiError(
      400,
      "Invalid or expired code",
      "INVALID_CODE",
      undefined,
      { error: "Invalid or expired code", code: "INVALID_CODE" },
      "/auth/password/verify"
    )

  it("错码只说「验证码不正确或已过期」，连错 5 次按契约作废", async () => {
    vi.mocked(authApi.passwordVerify).mockRejectedValue(invalidCode())
    const events = await toCodeStep()
    await events.type(screen.getByLabelText("邮箱验证码"), "000000")

    await events.click(screen.getByRole("button", { name: "验证" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "验证码不正确或已过期，请重新获取。"
    )

    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await events.click(screen.getByRole("button", { name: "验证" }))
    }

    expect(screen.getByRole("alert")).toHaveTextContent(
      "验证码连续输错 5 次已作废，请重新发送验证码。"
    )
    // 码已作废：输入被清空，提交按钮不再装能点
    expect(screen.getByLabelText("邮箱验证码")).toHaveValue("")
    expect(screen.getByRole("button", { name: "验证" })).toBeDisabled()
  })

  it("验码被限流时按 retryAfter 挡住提交并给出剩余时间", async () => {
    vi.mocked(authApi.passwordVerify).mockRejectedValue(
      new ApiError(429, "Too many requests", "RATE_LIMITED", 120)
    )
    const events = await toCodeStep()

    await events.type(screen.getByLabelText("邮箱验证码"), "000000")
    await events.click(screen.getByRole("button", { name: "验证" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "操作过于频繁，请在 2 分钟后重试。"
    )
    expect(screen.getByRole("button", { name: "验证" })).toBeDisabled()
  })

  it("发码被限流时按 retryAfter 起冷却，不让按钮空转", async () => {
    vi.mocked(authApi.passwordForgot).mockRejectedValue(
      new ApiError(429, "Too many requests", "RATE_LIMITED", 300)
    )
    const events = userEvent.setup()
    renderPage()

    await events.type(screen.getByLabelText("邮箱"), "a@b.c")
    await events.click(screen.getByRole("button", { name: /发送验证码/ }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "操作过于频繁，请在 5 分钟后重试。"
    )
    // 留在第一步，邮箱还在
    expect(screen.getByLabelText("邮箱")).toHaveValue("a@b.c")
  })

  it("resetToken 过期时提示重新获取验证码，并能退回第一步", async () => {
    vi.mocked(authApi.passwordReset).mockRejectedValue(
      new ApiError(400, "Invalid or expired reset token", "INVALID_RESET_TOKEN")
    )
    const events = await toPasswordStep()

    await events.type(
      screen.getByLabelText("新密码（至少 8 位）"),
      "new-password-1"
    )
    await events.type(screen.getByLabelText("再次输入新密码"), "new-password-1")
    await events.click(screen.getByRole("button", { name: /保存新密码/ }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "这次重置已失效（验证码换来的凭证过期或已被使用），请重新获取验证码。"
    )

    await events.click(screen.getByRole("button", { name: "重新获取验证码" }))
    expect(
      await screen.findByRole("heading", { name: "找回密码" })
    ).toBeInTheDocument()
    expect(screen.getByLabelText("邮箱")).toHaveValue("a@b.c")
  })
})

describe("找回密码：站点没配发信", () => {
  it("入口整页换成不可用分支，一句话写明去系统管理配置 SMTP", () => {
    useSiteStore.setState({ loaded: true, emailConfigured: false })
    renderPage()

    expect(
      screen.getByText(/站点还没有配置发信（SMTP），暂时无法通过邮件找回密码/)
    ).toBeInTheDocument()
    expect(screen.getByText(/系统管理 → 邮件配置/)).toBeInTheDocument()
    expect(screen.queryByLabelText("邮箱")).toBeNull()
    expect(screen.getByRole("link", { name: "返回登录" })).toHaveAttribute(
      "href",
      "/login"
    )
  })

  it("发码时服务端回 EMAIL_NOT_CONFIGURED，当场切成不可用并同步站点状态", async () => {
    useSiteStore.setState({ loaded: true, emailConfigured: true })
    vi.mocked(authApi.passwordForgot).mockRejectedValue(
      new ApiError(
        503,
        "Email delivery is not configured",
        "EMAIL_NOT_CONFIGURED"
      )
    )
    const events = userEvent.setup()
    renderPage()

    await events.type(screen.getByLabelText("邮箱"), "a@b.c")
    await events.click(screen.getByRole("button", { name: /发送验证码/ }))

    await waitFor(() => {
      expect(screen.getByText(/站点还没有配置发信（SMTP）/)).toBeInTheDocument()
    })
    expect(useSiteStore.getState().emailConfigured).toBe(false)
  })
})
