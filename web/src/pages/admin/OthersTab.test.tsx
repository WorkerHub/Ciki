import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import type { AdminStorage, R2CleanupSummary, SiteSettings } from "@/lib/api"
import { OthersTab } from "@/pages/admin/OthersTab"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      r2Cleanup: vi.fn(),
      runR2Cleanup: vi.fn(),
      storage: vi.fn(),
      settings: vi.fn(),
      saveSettings: vi.fn()
    }
  }
})

const { adminApi } = await import("@/lib/api")

const storage: AdminStorage = {
  pageCount: 12,
  trashedPageCount: 3,
  revisionCount: 40,
  databaseSizeBytes: 3_565_158,
  assetsSizeBytes: 2_097_152,
  contentSizeBytes: 524_288,
  assetsObjectCount: 24,
  contentObjectCount: 40,
  sizeScope: "own-database",
  measure: "cloudflare-d1-api"
}

const lastRun: R2CleanupSummary = {
  startedAt: "2026-11-01T17:00:00.000Z",
  finishedAt: "2026-11-01T17:00:03.000Z",
  trigger: "cron",
  status: "ok",
  dryRun: false,
  scanned: 128,
  referenced: 96,
  deleted: 8,
  youngSkipped: 22,
  failed: 0,
  truncated: false
}

const defaultSiteSettings: SiteSettings = {
  siteName: "Ciki",
  setupPageEnabled: false,
  tablePrefix: "ciki_",
  registrationEnabled: true,
  registrationApprovalRequired: true,
  require2fa: false,
  emailConfigured: true,
  revisionRetentionLimit: null
}

describe("系统管理 · 其他", () => {
  beforeEach(() => {
    vi.mocked(adminApi.r2Cleanup).mockReset()
    vi.mocked(adminApi.runR2Cleanup).mockReset()
    vi.mocked(adminApi.storage).mockReset()
    vi.mocked(adminApi.settings).mockReset()
    vi.mocked(adminApi.saveSettings).mockReset()
    vi.mocked(adminApi.r2Cleanup).mockResolvedValue({
      lastRun: null,
      running: null
    })
    vi.mocked(adminApi.storage).mockResolvedValue(storage)
    vi.mocked(adminApi.settings).mockResolvedValue(defaultSiteSettings)
    vi.mocked(adminApi.saveSettings).mockResolvedValue({ success: true })
  })

  it("无手动升级入口且旧说明文字不再渲染", () => {
    render(<OthersTab />)

    expect(screen.getByText("孤儿图片清理")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /升级/ })).toBeNull()
    expect(screen.queryByText("数据库升级")).toBeNull()
    expect(screen.queryByText("数据库迁移")).toBeNull()
    expect(screen.queryByText(/没有删表/)).toBeNull()
    expect(screen.queryByText(/按站点约定/)).toBeNull()
    expect(screen.queryByText(/迁移是追加式的/)).toBeNull()
  })

  it("有清理记录时只渲染一行六项摘要（Asia/Shanghai 口径）", async () => {
    vi.mocked(adminApi.r2Cleanup).mockResolvedValue({
      lastRun,
      running: null
    })
    render(<OthersTab />)

    expect(
      await screen.findByText(
        "最近清理 2026-11-02 01:00 · 扫描 128 · 引用 96 · 删除 8 · 未满 30 天跳过 22 · 失败 0"
      )
    ).toBeInTheDocument()
    expect(screen.getAllByText(/最近清理/)).toHaveLength(1)
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.queryByText(/每月/)).toBeNull()
  })

  it("库体积、两个桶体积与页数并成一行：按桶分开显示，不合并", async () => {
    render(<OthersTab />)

    expect(
      await screen.findByText(
        "数据库体积 3.4 MB · 图片体积 2.0 MB · 正文体积 512.0 KB · 页面 12"
      )
    ).toBeInTheDocument()
    // 只此一行、无说明文字，也不出现共享库 scope 字样、不显示对象数
    expect(screen.queryByText(/共享/)).toBeNull()
    expect(screen.queryByText(/PRAGMA/)).toBeNull()
    expect(screen.getAllByText(/数据库体积/)).toHaveLength(1)
    expect(screen.queryByText(/个对象/)).toBeNull()
  })

  it("某一桶统计失败时整项不渲染，其余项照常", async () => {
    vi.mocked(adminApi.storage).mockResolvedValue({
      ...storage,
      assetsSizeBytes: null
    })
    render(<OthersTab />)

    expect(
      await screen.findByText("数据库体积 3.4 MB · 正文体积 512.0 KB · 页面 12")
    ).toBeInTheDocument()
    expect(screen.queryByText(/图片体积/)).toBeNull()
    expect(screen.queryByText(/不可得/)).toBeNull()
  })

  it("空桶的 0 字节是真数，照实显示 0 B", async () => {
    vi.mocked(adminApi.storage).mockResolvedValue({
      ...storage,
      contentSizeBytes: 0,
      contentObjectCount: 0
    })
    render(<OthersTab />)

    expect(
      await screen.findByText(
        "数据库体积 3.4 MB · 图片体积 2.0 MB · 正文体积 0 B · 页面 12"
      )
    ).toBeInTheDocument()
  })

  it("体积读不到时显式「不可得」，不拿页数估算", async () => {
    vi.mocked(adminApi.storage).mockResolvedValue({
      ...storage,
      databaseSizeBytes: null,
      assetsSizeBytes: null,
      contentSizeBytes: null
    })
    render(<OthersTab />)

    expect(
      await screen.findByText("数据库体积 不可得 · 页面 12")
    ).toBeInTheDocument()
    expect(screen.queryByText(/\d MB/)).toBeNull()
  })

  it("体积接口失败时整行不渲染，也不占错误位", async () => {
    vi.mocked(adminApi.storage).mockRejectedValue(new Error("boom"))
    render(<OthersTab />)

    await waitFor(() => expect(adminApi.storage).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/数据库体积/)).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("没有清理记录时不渲染摘要，也不留空态文字", async () => {
    render(<OthersTab />)

    await waitFor(() => expect(adminApi.r2Cleanup).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/最近清理/)).toBeNull()
  })

  it("摘要读取失败不打扰用户，也不显示错误", async () => {
    vi.mocked(adminApi.r2Cleanup).mockRejectedValue(new Error("boom"))
    render(<OthersTab />)

    await waitFor(() => expect(adminApi.r2Cleanup).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.queryByText(/最近清理/)).toBeNull()
  })

  it("页面加载即按 GET 的 running 判定「进行中」，锁释放后自动解禁", async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(adminApi.r2Cleanup)
        .mockResolvedValueOnce({
          lastRun: null,
          running: {
            startedAt: "2026-11-10T09:00:00.000Z",
            trigger: "manual",
            dryRun: false,
            retryAfter: 20
          }
        })
        .mockResolvedValueOnce({ lastRun: null, running: null })
      render(<OthersTab />)

      // 首轮 GET 落盘后再看渲染结果
      await act(async () => {
        await Promise.resolve()
      })

      expect(
        screen.getByRole("button", { name: "扫描孤儿图片" })
      ).toBeDisabled()
      expect(
        screen.getByText("清理进行中，约 20 秒后可再试")
      ).toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })

      expect(adminApi.r2Cleanup).toHaveBeenCalledTimes(2)
      expect(screen.getByRole("button", { name: "扫描孤儿图片" })).toBeEnabled()
      expect(screen.queryByText(/清理进行中/)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("实跑结束后重拉最近一轮摘要行", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.r2Cleanup)
      .mockResolvedValueOnce({ lastRun: null, running: null })
      .mockResolvedValueOnce({ lastRun, running: null })
    vi.mocked(adminApi.runR2Cleanup)
      .mockResolvedValueOnce({
        startedAt: "2026-11-10T09:00:00.000Z",
        finishedAt: "2026-11-10T09:00:02.000Z",
        trigger: "manual",
        status: "ok",
        dryRun: true,
        scanned: 128,
        referenced: 96,
        deleted: 8,
        youngSkipped: 22,
        failed: 0,
        truncated: false,
        prunable: 8,
        prunableBytes: 4096
      })
      .mockResolvedValueOnce({
        startedAt: "2026-11-10T09:05:00.000Z",
        finishedAt: "2026-11-10T09:05:03.000Z",
        trigger: "manual",
        status: "ok",
        dryRun: false,
        scanned: 128,
        referenced: 96,
        deleted: 8,
        youngSkipped: 22,
        failed: 0,
        truncated: false
      })
    render(<OthersTab />)

    await user.click(
      await screen.findByRole("button", { name: "扫描孤儿图片" })
    )
    await user.click(await screen.findByRole("button", { name: "立即清理" }))
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "删除 8 个"
      })
    )

    expect(
      await screen.findByText(
        "最近清理 2026-11-02 01:00 · 扫描 128 · 引用 96 · 删除 8 · 未满 30 天跳过 22 · 失败 0"
      )
    ).toBeInTheDocument()
    expect(adminApi.r2Cleanup).toHaveBeenCalledTimes(2)
  })

  it("包含初始化页面开关与生效表前缀展示，并能切换", async () => {
    const user = userEvent.setup()
    render(<OthersTab />)

    expect(
      await screen.findByRole("heading", { name: "其他" })
    ).toBeInTheDocument()
    expect(screen.getByText("生效表前缀")).toBeInTheDocument()
    expect(screen.getByText("ciki_")).toBeInTheDocument()

    const setupSwitch = screen.getByRole("switch", { name: "开放初始化页面" })
    expect(setupSwitch).toHaveAttribute("aria-checked", "false")

    await user.click(setupSwitch)
    expect(adminApi.saveSettings).toHaveBeenCalledWith({
      setupPageEnabled: true
    })
  })
})

describe("系统管理 · 其他 · 英文界面", () => {
  beforeEach(() => {
    vi.mocked(adminApi.r2Cleanup).mockReset().mockResolvedValue({
      lastRun: null,
      running: null
    })
    vi.mocked(adminApi.storage).mockReset().mockResolvedValue(storage)
    vi.mocked(adminApi.settings).mockReset().mockResolvedValue(defaultSiteSettings)
    vi.mocked(adminApi.saveSettings).mockReset().mockResolvedValue({ success: true })
  })

  it("清理区与体积行都是英文，无手动升级按钮", async () => {
    await i18n.changeLanguage("en")
    render(<OthersTab />)

    expect(screen.getByText("Orphaned image cleanup")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /upgrade/i })
    ).not.toBeInTheDocument()
    expect(
      await screen.findByText(/^Database size 3\.4 MB · Image size 2\.0 MB/)
    ).toBeInTheDocument()
  })
})
