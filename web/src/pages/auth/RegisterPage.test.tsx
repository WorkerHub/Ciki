import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api"
import type { VerifyEmailNavState } from "@/lib/email-verification"
import { RegisterPage } from "@/pages/auth/RegisterPage"
import { DEFAULT_SITE_NAME, useSiteStore } from "@/stores/site"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    authApi: {
      ...actual.authApi,
      config: vi.fn(),
      register: vi.fn()
    }
  }
})

const { authApi } = await import("@/lib/api")

/** 验证页占位：把注册页带过去的路由状态原样打印出来，供断言。 */
function VerifyProbe() {
  const state = useLocation().state as VerifyEmailNavState | null
  return (
    <p>
      验证页占位 {state?.email} {state?.codeSent ? "已发码" : "未发码"}{" "}
      {state?.approvalRequired ? "待审批" : "免审批"}
    </p>
  )
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/register"]}>
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/verify-email" element={<VerifyProbe />} />
      </Routes>
    </MemoryRouter>
  )

const CONFIG = {
  registrationEnabled: true,
  registrationApprovalRequired: true,
  siteName: DEFAULT_SITE_NAME,
  emailConfigured: true
}

async function fillAndSubmit() {
  const events = userEvent.setup()
  await events.type(screen.getByLabelText("邮箱"), "a@b.c")
  await events.type(screen.getByLabelText("密码（至少 8 位）"), "password-1")
  await events.type(screen.getByLabelText("再次输入密码"), "password-1")
  await events.click(screen.getByRole("button", { name: "注册" }))
  return events
}

beforeEach(() => {
  useSiteStore.setState({
    name: DEFAULT_SITE_NAME,
    emailConfigured: true,
    loaded: true
  })
  vi.mocked(authApi.config).mockResolvedValue(CONFIG)
  vi.mocked(authApi.register).mockResolvedValue({
    success: true,
    approvalRequired: true,
    emailVerificationRequired: true
  })
})

/**
 * 自助注册（#85 契约）：成功后必须先去验证邮箱；
 * 站点没配发信时入口整页收起，不让用户填完才撞 503。
 */
describe("注册页：邮箱验证衔接", () => {
  it("注册成功后带去验证页，并把邮箱、已发码、待审批三个状态一起带上", async () => {
    renderPage()
    await fillAndSubmit()

    expect(authApi.register).toHaveBeenCalledWith("a@b.c", "password-1")
    expect(
      await screen.findByText("验证页占位 a@b.c 已发码 待审批")
    ).toBeInTheDocument()
  })

  it("不需要验证邮箱时（首个管理员）仍在原页给出「已提交」", async () => {
    vi.mocked(authApi.register).mockResolvedValue({
      success: true,
      approvalRequired: false
    })
    renderPage()
    await fillAndSubmit()

    expect(
      await screen.findByRole("heading", { name: "注册申请已提交" })
    ).toBeInTheDocument()
    expect(screen.getByText(/账号已创建并激活/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "去登录" })).toBeInTheDocument()
  })

  it("密码不合格时不发请求，文案与改密口径一致", async () => {
    renderPage()
    const events = userEvent.setup()
    await events.type(screen.getByLabelText("邮箱"), "a@b.c")
    await events.type(screen.getByLabelText("密码（至少 8 位）"), "short")
    await events.type(screen.getByLabelText("再次输入密码"), "short")
    await events.click(screen.getByRole("button", { name: "注册" }))

    expect(screen.getByRole("alert")).toHaveTextContent("密码至少 8 位")
    expect(authApi.register).not.toHaveBeenCalled()
  })

  it("提交时服务端回 EMAIL_NOT_CONFIGURED：当场切成不可用并同步站点状态", async () => {
    vi.mocked(authApi.register).mockRejectedValue(
      new ApiError(
        503,
        "Email delivery is not configured",
        "EMAIL_NOT_CONFIGURED"
      )
    )
    renderPage()
    await fillAndSubmit()

    await waitFor(() => {
      expect(
        screen.getByText(/站点还没有配置发信（SMTP），自助注册暂不可用/)
      ).toBeInTheDocument()
    })
    expect(useSiteStore.getState().emailConfigured).toBe(false)
    expect(screen.queryByLabelText("邮箱")).toBeNull()
  })
})

describe("注册页：入口开关", () => {
  it("站点没配发信时整页换成说明，不渲染表单", () => {
    useSiteStore.setState({ loaded: true, emailConfigured: false })
    renderPage()

    expect(
      screen.getByText(/站点还没有配置发信（SMTP），自助注册暂不可用/)
    ).toBeInTheDocument()
    expect(screen.getByText(/系统管理 → 邮件配置/)).toBeInTheDocument()
    expect(screen.queryByLabelText("邮箱")).toBeNull()
    expect(screen.getByRole("link", { name: "返回登录" })).toHaveAttribute(
      "href",
      "/login"
    )
  })

  it("站点信息还没读到时按可注册渲染，不闪一下「不可用」", () => {
    useSiteStore.setState({ loaded: false, emailConfigured: false })
    renderPage()

    expect(screen.getByLabelText("邮箱")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "注册" })).toBeInTheDocument()
  })

  it("关闭自助注册时说明并给回登录页的入口", async () => {
    vi.mocked(authApi.config).mockResolvedValue({
      ...CONFIG,
      registrationEnabled: false
    })
    renderPage()

    expect(
      await screen.findByText("站点当前关闭了自助注册。")
    ).toBeInTheDocument()
    expect(screen.queryByLabelText("邮箱")).toBeNull()
  })
})
