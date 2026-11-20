import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import type { SiteSettings } from "@/lib/api"
import { OthersSection } from "@/pages/admin/others-section"

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

const defaultSettings: SiteSettings = {
  siteName: "Ciki",
  setupPageEnabled: false,
  tablePrefix: "ciki_",
  registrationEnabled: true,
  registrationApprovalRequired: true,
  require2fa: false,
  emailConfigured: true,
  revisionRetentionLimit: null
}

describe("系统管理 · 其他设置区块 (OthersSection)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh")
    vi.mocked(adminApi.settings).mockReset()
    vi.mocked(adminApi.saveSettings).mockReset()
    vi.mocked(adminApi.settings).mockResolvedValue(defaultSettings)
    vi.mocked(adminApi.saveSettings).mockResolvedValue({ success: true })
  })

  it("展示生效表前缀，为空时回显（无前缀）", async () => {
    vi.mocked(adminApi.settings).mockResolvedValue({
      ...defaultSettings,
      tablePrefix: "custom_prefix_"
    })

    const { unmount } = render(<OthersSection />)

    expect(await screen.findByText("生效表前缀")).toBeInTheDocument()
    expect(screen.getByText("custom_prefix_")).toBeInTheDocument()

    unmount()

    vi.mocked(adminApi.settings).mockResolvedValue({
      ...defaultSettings,
      tablePrefix: ""
    })
    render(<OthersSection />)

    expect(await screen.findByText("生效表前缀")).toBeInTheDocument()
    expect(screen.getByText("（无前缀）")).toBeInTheDocument()
  })

  it("切换「开放初始化页面」开关提交扁平 setupPageEnabled 契约", async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()

    render(<OthersSection onSaved={onSaved} />)

    expect(
      await screen.findByRole("heading", { name: "其他" })
    ).toBeInTheDocument()

    const setupSwitch = screen.getByRole("switch", { name: "开放初始化页面" })
    expect(setupSwitch).toHaveAttribute("aria-checked", "false")

    await user.click(setupSwitch)

    expect(adminApi.saveSettings).toHaveBeenCalledWith({
      setupPageEnabled: true
    })
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        setupPageEnabled: true
      })
    )
    expect(setupSwitch).toHaveAttribute("aria-checked", "true")
  })

  it("保存失败时回滚开关状态并显示错误提示", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.saveSettings).mockRejectedValue(
      new Error("network error")
    )

    render(<OthersSection />)

    const setupSwitch = await screen.findByRole("switch", {
      name: "开放初始化页面"
    })
    expect(setupSwitch).toHaveAttribute("aria-checked", "false")

    await user.click(setupSwitch)

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(setupSwitch).toHaveAttribute("aria-checked", "false")
  })

  it("支持直接接收 settings props", async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    const initialPropsSettings: SiteSettings = {
      ...defaultSettings,
      setupPageEnabled: true,
      tablePrefix: "prop_prefix_"
    }

    render(
      <OthersSection settings={initialPropsSettings} onSaved={onSaved} />
    )

    expect(screen.getByText("prop_prefix_")).toBeInTheDocument()
    const setupSwitch = screen.getByRole("switch", { name: "开放初始化页面" })
    expect(setupSwitch).toHaveAttribute("aria-checked", "true")

    await user.click(setupSwitch)

    expect(adminApi.saveSettings).toHaveBeenCalledWith({
      setupPageEnabled: false
    })
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        setupPageEnabled: false
      })
    )
  })

  it("英文界面渲染英文标题、说明与表前缀标签", async () => {
    await i18n.changeLanguage("en")
    render(<OthersSection />)

    expect(
      await screen.findByRole("heading", { name: "Others" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("switch", { name: "Open the setup page" })
    ).toBeInTheDocument()
    expect(screen.getByText("Effective table prefix")).toBeInTheDocument()
    expect(
      screen.getByText(
        "This only gates the page; the endpoint still requires the deployment secret."
      )
    ).toBeInTheDocument()
  })
})
