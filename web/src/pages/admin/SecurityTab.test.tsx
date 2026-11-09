import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SiteSettings } from "@/lib/api"
import { SecurityTab } from "@/pages/admin/SecurityTab"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      settings: vi.fn(),
      saveSettings: vi.fn()
    }
  }
})

const { adminApi } = await import("@/lib/api")

const settings: SiteSettings = {
  siteName: "Ciki",
  setupPageEnabled: false,
  registrationEnabled: true,
  registrationApprovalRequired: true,
  require2fa: false,
  emailConfigured: true
}

describe("系统管理 · 访问与安全", () => {
  beforeEach(() => {
    vi.mocked(adminApi.settings).mockResolvedValue(settings)
    vi.mocked(adminApi.saveSettings).mockReset()
  })

  it("强制两步验证与两个注册开关都是可操作的开关", async () => {
    render(<SecurityTab />)

    expect(
      await screen.findByRole("switch", { name: "强制两步验证" })
    ).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "开放注册" })).toBeEnabled()
    expect(
      screen.getByRole("switch", { name: "注册需要管理员批准" })
    ).toBeEnabled()
    // 权限模型里指向「用户管理」的那条已改为准确表述
    expect(screen.getByText(/待批准用户的处理/)).toBeInTheDocument()
    expect(screen.queryByText(/注册审批、账号停用/)).toBeNull()
  })

  it("切换「开放注册」把 registrationEnabled 写回后端", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.saveSettings).mockResolvedValue({ success: true })
    render(<SecurityTab />)

    const registration = await screen.findByRole("switch", {
      name: "开放注册"
    })
    await user.click(registration)

    expect(adminApi.saveSettings).toHaveBeenCalledWith({
      registrationEnabled: false
    })
    expect(registration).toHaveAttribute("aria-checked", "false")
  })

  it("开放注册关闭时「注册需要管理员批准」不可操作", async () => {
    vi.mocked(adminApi.settings).mockResolvedValue({
      ...settings,
      registrationEnabled: false
    })
    render(<SecurityTab />)

    expect(
      await screen.findByRole("switch", { name: "注册需要管理员批准" })
    ).toBeDisabled()
  })

  it("保存失败时回滚开关并显示错误", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.saveSettings).mockRejectedValue(
      new Error("network down")
    )
    render(<SecurityTab />)

    const registration = await screen.findByRole("switch", {
      name: "开放注册"
    })
    await user.click(registration)

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(registration).toHaveAttribute("aria-checked", "true")
  })
})
