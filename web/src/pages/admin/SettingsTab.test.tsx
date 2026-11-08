import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SiteSettings } from "@/lib/api"
import { SettingsTab } from "@/pages/admin/SettingsTab"
import { DEFAULT_SITE_NAME, useSiteStore } from "@/stores/site"

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
  require2fa: false
}

describe("系统管理 · 站点名称", () => {
  beforeEach(() => {
    useSiteStore.setState({ name: DEFAULT_SITE_NAME, loaded: true })
    vi.mocked(adminApi.settings).mockResolvedValue(settings)
    vi.mocked(adminApi.saveSettings).mockReset()
  })

  it("Enter 保存站点名后更新站点 store 并给成功提示", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.saveSettings).mockResolvedValue({ success: true })
    vi.mocked(adminApi.settings)
      .mockResolvedValueOnce(settings)
      .mockResolvedValueOnce({ ...settings, siteName: "团队知识库" })
    render(<SettingsTab />)

    const input = await screen.findByLabelText("站点名称")
    expect(input).toHaveValue("Ciki")

    await user.clear(input)
    await user.type(input, "团队知识库{Enter}")

    expect(adminApi.saveSettings).toHaveBeenCalledWith({
      siteName: "团队知识库"
    })
    expect(useSiteStore.getState().name).toBe("团队知识库")
    expect(screen.getByRole("status")).toHaveTextContent("全站即时生效")
  })

  it("保存失败时回滚输入并显示错误", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.saveSettings).mockRejectedValue(
      new Error("network down")
    )
    render(<SettingsTab />)

    const input = await screen.findByLabelText("站点名称")
    await user.clear(input)
    await user.type(input, "新名字{Enter}")

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(input).toHaveValue("Ciki")
    expect(useSiteStore.getState().name).toBe("Ciki")
  })

  it("空值不提交", async () => {
    const user = userEvent.setup()
    render(<SettingsTab />)

    const input = await screen.findByLabelText("站点名称")
    await user.clear(input)
    await user.type(input, "   {Enter}")

    expect(adminApi.saveSettings).not.toHaveBeenCalled()
    expect(input).toHaveValue("Ciki")
  })
})
