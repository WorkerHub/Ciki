import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import type { SiteSettings } from "@/lib/api"
import { MaxImageUploadCard } from "@/pages/admin/MaxImageUploadCard"

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
  emailConfigured: true,
  revisionRetentionLimit: null,
  maxImageUploadMb: 10
}

const INVALID_HINT = "上限需为 1–100 的整数，留空表示恢复默认（10MB）。"

describe("图片上传上限管理页配置项", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh")
    vi.mocked(adminApi.settings).mockReset().mockResolvedValue(settings)
    vi.mocked(adminApi.saveSettings)
      .mockReset()
      .mockResolvedValue({ success: true })
  })

  afterEach(async () => {
    await i18n.changeLanguage("zh")
  })

  it("默认展示当前生效值（默认 10）", () => {
    render(<MaxImageUploadCard limit={10} onSaved={vi.fn()} />)
    const input = screen.getByLabelText("图片上传上限 (MB)")
    expect(input).toHaveValue(10)
  })

  it("输入 1–100 整数后保存并回读确认", async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    vi.mocked(adminApi.settings).mockResolvedValue({
      ...settings,
      maxImageUploadMb: 25
    })
    render(<MaxImageUploadCard limit={10} onSaved={onSaved} />)

    const input = screen.getByLabelText("图片上传上限 (MB)")
    await user.clear(input)
    await user.type(input, "25{Enter}")
    await waitFor(() =>
      expect(adminApi.saveSettings).toHaveBeenCalledWith({
        maxImageUploadMb: 25
      })
    )
    expect(onSaved).toHaveBeenCalledWith({
      ...settings,
      maxImageUploadMb: 25
    })
    expect(await screen.findByRole("status")).toHaveTextContent(
      "图片上传上限已设为 25MB。"
    )
    expect(input).toHaveValue(25)
  })

  it("失焦（onBlur）也能触发保存", async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    vi.mocked(adminApi.settings).mockResolvedValue({
      ...settings,
      maxImageUploadMb: 50
    })
    render(<MaxImageUploadCard limit={10} onSaved={onSaved} />)

    const input = screen.getByLabelText("图片上传上限 (MB)")
    await user.clear(input)
    await user.type(input, "50")
    await user.tab()

    await waitFor(() =>
      expect(adminApi.saveSettings).toHaveBeenCalledWith({
        maxImageUploadMb: 50
      })
    )
    expect(onSaved).toHaveBeenCalledWith({
      ...settings,
      maxImageUploadMb: 50
    })
  })

  it("清空输入框保存为重置默认（null），回显 10", async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    vi.mocked(adminApi.settings).mockResolvedValue({
      ...settings,
      maxImageUploadMb: 10
    })
    render(<MaxImageUploadCard limit={25} onSaved={onSaved} />)

    const input = screen.getByLabelText("图片上传上限 (MB)")
    expect(input).toHaveValue(25)
    await user.clear(input)
    await user.type(input, "{Enter}")

    await waitFor(() =>
      expect(adminApi.saveSettings).toHaveBeenCalledWith({
        maxImageUploadMb: null
      })
    )
    expect(onSaved).toHaveBeenCalledWith({
      ...settings,
      maxImageUploadMb: 10
    })
    expect(await screen.findByRole("status")).toHaveTextContent(
      "图片上传上限已恢复为默认 10MB。"
    )
    expect(input).toHaveValue(10)
  })

  it("0 / 101 / 负数 / 小数 / 非数字都不提交，回退原值并提示", async () => {
    const user = userEvent.setup()
    render(<MaxImageUploadCard limit={10} onSaved={vi.fn()} />)
    const input = screen.getByLabelText("图片上传上限 (MB)")

    for (const invalid of ["0", "101", "-1", "1.5"]) {
      await user.clear(input)
      await user.type(input, `${invalid}{Enter}`)
      expect(await screen.findByRole("alert")).toHaveTextContent(INVALID_HINT)
      expect(input).toHaveValue(10)
    }
    expect(adminApi.saveSettings).not.toHaveBeenCalled()
  })

  it("值未改变时不提交保存", async () => {
    const user = userEvent.setup()
    render(<MaxImageUploadCard limit={10} onSaved={vi.fn()} />)
    const input = screen.getByLabelText("图片上传上限 (MB)")

    await user.type(input, "{Enter}")
    expect(adminApi.saveSettings).not.toHaveBeenCalled()
  })

  it("Escape 键还原输入框内容", async () => {
    const user = userEvent.setup()
    render(<MaxImageUploadCard limit={10} onSaved={vi.fn()} />)
    const input = screen.getByLabelText("图片上传上限 (MB)")

    await user.clear(input)
    await user.type(input, "30{Escape}")
    expect(input).toHaveValue(10)
    expect(adminApi.saveSettings).not.toHaveBeenCalled()
  })

  it("回读与提交不一致时不假装保存成功", async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    vi.mocked(adminApi.settings).mockResolvedValue({
      ...settings,
      maxImageUploadMb: 10
    })
    render(<MaxImageUploadCard limit={10} onSaved={onSaved} />)
    const input = screen.getByLabelText("图片上传上限 (MB)")

    await user.clear(input)
    await user.type(input, "25{Enter}")

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "图片上传上限没有保存成功，请刷新后重试。"
    )
    expect(input).toHaveValue(10)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it("保存异常时回滚输入并显示错误信息", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.saveSettings).mockRejectedValue(
      new Error("network failure")
    )
    render(<MaxImageUploadCard limit={10} onSaved={vi.fn()} />)
    const input = screen.getByLabelText("图片上传上限 (MB)")

    await user.clear(input)
    await user.type(input, "25{Enter}")

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(input).toHaveValue(10)
  })
})

describe("图片上传上限管理页配置项 · 英文界面", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en")
    vi.mocked(adminApi.settings).mockReset().mockResolvedValue(settings)
    vi.mocked(adminApi.saveSettings)
      .mockReset()
      .mockResolvedValue({ success: true })
  })

  afterEach(async () => {
    await i18n.changeLanguage("zh")
  })

  it("英文界面下标签、占位符与保存提示均为英文", async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    vi.mocked(adminApi.settings).mockResolvedValue({
      ...settings,
      maxImageUploadMb: 30
    })
    render(<MaxImageUploadCard limit={10} onSaved={onSaved} />)

    const input = screen.getByLabelText("Image upload limit (MB)")
    expect(input).toHaveValue(10)
    expect(input).toHaveAttribute("placeholder", "Default 10")

    await user.clear(input)
    await user.type(input, "30{Enter}")

    await waitFor(() =>
      expect(adminApi.saveSettings).toHaveBeenCalledWith({
        maxImageUploadMb: 30
      })
    )
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Image upload limit set to 30MB."
    )

    // 重置默认提示
    vi.mocked(adminApi.settings).mockResolvedValue({
      ...settings,
      maxImageUploadMb: 10
    })
    await user.clear(input)
    await user.type(input, "{Enter}")
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Image upload limit reset to default 10MB."
    )
  })
})
