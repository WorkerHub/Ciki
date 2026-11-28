import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import { ApiError, type SiteSettings } from "@/lib/api"
import { RevisionRetentionCard } from "@/pages/admin/RevisionRetentionCard"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      settings: vi.fn(),
      saveSettings: vi.fn(),
      revisionRetention: vi.fn(),
      pruneAllRevisions: vi.fn()
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
  revisionRetentionLimit: null
}

const INVALID_HINT = "保留数需为不小于 1 的整数，留空表示不限。"

describe("历史版本保留数", () => {
  beforeEach(() => {
    vi.mocked(adminApi.settings).mockReset().mockResolvedValue(settings)
    vi.mocked(adminApi.saveSettings)
      .mockReset()
      .mockResolvedValue({ success: true })
    vi.mocked(adminApi.revisionRetention).mockReset()
    vi.mocked(adminApi.pruneAllRevisions).mockReset()
  })

  it("输入正整数后保存并回读确认", async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    vi.mocked(adminApi.settings).mockResolvedValue({
      ...settings,
      revisionRetentionLimit: 3
    })
    render(<RevisionRetentionCard limit={null} onSaved={onSaved} />)

    const input = screen.getByLabelText("每页保留历史版本数")
    expect(input).toHaveValue(null)
    await user.type(input, "3{Enter}")

    await waitFor(() =>
      expect(adminApi.saveSettings).toHaveBeenCalledWith({
        revisionRetentionLimit: 3
      })
    )
    expect(onSaved).toHaveBeenCalledWith({
      ...settings,
      revisionRetentionLimit: 3
    })
    expect(await screen.findByRole("status")).toHaveTextContent(
      "保留数已设为 3 条。"
    )
  })

  it("输入正整数后点保存按钮保存并回读确认", async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    vi.mocked(adminApi.settings).mockResolvedValue({
      ...settings,
      revisionRetentionLimit: 3
    })
    render(<RevisionRetentionCard limit={null} onSaved={onSaved} />)

    const input = screen.getByLabelText("每页保留历史版本数")
    const saveBtn = screen.getByRole("button", { name: "保存" })
    expect(saveBtn).toBeDisabled()

    await user.type(input, "3")
    expect(saveBtn).toBeEnabled()

    await user.click(saveBtn)

    await waitFor(() =>
      expect(adminApi.saveSettings).toHaveBeenCalledWith({
        revisionRetentionLimit: 3
      })
    )
    expect(onSaved).toHaveBeenCalledWith({
      ...settings,
      revisionRetentionLimit: 3
    })
    expect(await screen.findByRole("status")).toHaveTextContent(
      "保留数已设为 3 条。"
    )
  })

  it("失焦不提交保留数改动，保留为草稿", async () => {
    const user = userEvent.setup()
    render(<RevisionRetentionCard limit={null} onSaved={vi.fn()} />)
    const input = screen.getByLabelText("每页保留历史版本数")

    await user.type(input, "3")
    await user.tab()

    expect(adminApi.saveSettings).not.toHaveBeenCalled()
    expect(input).toHaveValue(3)
  })

  it("Escape 键还原已保存值并禁用保存按钮", async () => {
    const user = userEvent.setup()
    render(<RevisionRetentionCard limit={null} onSaved={vi.fn()} />)
    const input = screen.getByLabelText("每页保留历史版本数")
    const saveBtn = screen.getByRole("button", { name: "保存" })

    await user.type(input, "3")
    expect(saveBtn).toBeEnabled()

    await user.keyboard("{Escape}")
    expect(input).toHaveValue(null)
    expect(saveBtn).toBeDisabled()
    expect(adminApi.saveSettings).not.toHaveBeenCalled()
  })

  it("留空保存为不限", async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    render(<RevisionRetentionCard limit={5} onSaved={onSaved} />)

    const input = screen.getByLabelText("每页保留历史版本数")
    expect(input).toHaveValue(5)
    await user.clear(input)
    await user.type(input, "{Enter}")

    await waitFor(() =>
      expect(adminApi.saveSettings).toHaveBeenCalledWith({
        revisionRetentionLimit: null
      })
    )
    expect(onSaved).toHaveBeenCalledWith(settings)
    expect(await screen.findByRole("status")).toHaveTextContent(
      "保留数已设为不限。"
    )
  })

  it("0 / 负数 / 小数都不提交，回退原值并提示", async () => {
    const user = userEvent.setup()
    render(<RevisionRetentionCard limit={null} onSaved={vi.fn()} />)
    const input = screen.getByLabelText("每页保留历史版本数")

    for (const invalid of ["0", "-1", "1.5"]) {
      await user.clear(input)
      await user.type(input, `${invalid}{Enter}`)
      expect(await screen.findByRole("alert")).toHaveTextContent(INVALID_HINT)
      expect(input).toHaveValue(null)
    }
    expect(adminApi.saveSettings).not.toHaveBeenCalled()
  })

  it("回读与提交不一致时不假装保存成功，保留草稿", async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    vi.mocked(adminApi.settings).mockResolvedValue({
      ...settings,
      revisionRetentionLimit: 5
    })
    render(<RevisionRetentionCard limit={null} onSaved={onSaved} />)
    const input = screen.getByLabelText("每页保留历史版本数")

    await user.type(input, "3{Enter}")

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "保留数没有保存成功，请刷新后重试。"
    )
    expect(input).toHaveValue(3)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it("保存接口报错时保留草稿并显示错误", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.saveSettings).mockRejectedValue(
      new Error("network failure")
    )
    render(<RevisionRetentionCard limit={null} onSaved={vi.fn()} />)
    const input = screen.getByLabelText("每页保留历史版本数")

    await user.type(input, "3{Enter}")

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(input).toHaveValue(3)
  })

  it("保存还在飞行时不允许开始修剪（避免读到旧口径）", async () => {
    const user = userEvent.setup()
    let release: () => void = () => {}
    vi.mocked(adminApi.saveSettings).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ success: true })
        })
    )
    render(<RevisionRetentionCard limit={5} onSaved={vi.fn()} />)
    const input = screen.getByLabelText("每页保留历史版本数")
    const prune = screen.getByRole("button", {
      name: "按当前设置修剪全部页面"
    })

    await user.type(input, "3{Enter}")

    expect(prune).toBeDisabled()
    expect(adminApi.revisionRetention).not.toHaveBeenCalled()
    release()
    await waitFor(() => expect(prune).not.toBeDisabled())
  })

  it("修剪前先显示将删除的版本总数，再执行", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.revisionRetention).mockResolvedValue({
      limit: 3,
      totalRevisions: 12,
      prunableRevisions: 4
    })
    vi.mocked(adminApi.pruneAllRevisions).mockResolvedValue({
      limit: 3,
      deleted: 4
    })
    render(<RevisionRetentionCard limit={3} onSaved={vi.fn()} />)

    await user.click(
      screen.getByRole("button", { name: "按当前设置修剪全部页面" })
    )

    const confirm = await screen.findByRole("alertdialog")
    expect(
      await within(confirm).findByText(/将删除 4 条旧版本（每页保留最新 3 条）/)
    ).toBeInTheDocument()

    await user.click(within(confirm).getByRole("button", { name: "删除 4 条" }))

    await waitFor(() =>
      expect(adminApi.pruneAllRevisions).toHaveBeenCalledTimes(1)
    )
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已删除 4 条版本。"
    )
  })

  it("不限时修剪按钮禁用", () => {
    render(<RevisionRetentionCard limit={null} onSaved={vi.fn()} />)
    expect(
      screen.getByRole("button", { name: "按当前设置修剪全部页面" })
    ).toBeDisabled()
  })

  it("服务端回报不限时不让确认", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.revisionRetention).mockResolvedValue({
      limit: null,
      totalRevisions: 3,
      prunableRevisions: 0
    })
    render(<RevisionRetentionCard limit={3} onSaved={vi.fn()} />)

    await user.click(
      screen.getByRole("button", { name: "按当前设置修剪全部页面" })
    )
    const confirm = await screen.findByRole("alertdialog")
    expect(
      await within(confirm).findByText("当前设置为不限，没有可修剪的版本。")
    ).toBeInTheDocument()
    expect(
      within(confirm).getByRole("button", { name: "删除 0 条" })
    ).toBeDisabled()
  })

  it("执行时服务端拒绝（409 不限）走中文文案", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.revisionRetention).mockResolvedValue({
      limit: 2,
      totalRevisions: 9,
      prunableRevisions: 5
    })
    vi.mocked(adminApi.pruneAllRevisions).mockRejectedValue(
      new ApiError(
        409,
        "Revision retention is unlimited",
        "RETENTION_UNLIMITED",
        undefined,
        undefined,
        "/admin/revisions/prune"
      )
    )
    render(<RevisionRetentionCard limit={2} onSaved={vi.fn()} />)

    await user.click(
      screen.getByRole("button", { name: "按当前设置修剪全部页面" })
    )
    const confirm = await screen.findByRole("alertdialog")
    await user.click(
      await within(confirm).findByRole("button", { name: "删除 5 条" })
    )

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "当前设置为不限，没有可修剪的版本。"
    )
  })
})

describe("历史版本保留数 · 英文界面", () => {
  it("标签、按钮与修剪确认都是英文", async () => {
    await i18n.changeLanguage("en")
    render(<RevisionRetentionCard limit={2} onSaved={vi.fn()} />)

    expect(screen.getByLabelText("Revisions kept per page")).toHaveValue(2)
    expect(
      screen.getByRole("button", { name: "Prune all pages by current setting" })
    ).toBeInTheDocument()
  })
})
