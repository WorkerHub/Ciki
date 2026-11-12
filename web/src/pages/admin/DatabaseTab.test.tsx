import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AdminStorage, R2CleanupSummary, SetupResult } from "@/lib/api"
import { DatabaseTab } from "@/pages/admin/DatabaseTab"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      runAsAdmin: vi.fn(),
      r2Cleanup: vi.fn(),
      runR2Cleanup: vi.fn(),
      storage: vi.fn()
    }
  }
})

const { adminApi } = await import("@/lib/api")

const result: SetupResult = {
  success: true,
  tablePrefix: "ciki_",
  migrations: [{ name: "schema_v1", status: "applied" }]
}

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

describe("系统管理 · 数据库升级", () => {
  beforeEach(() => {
    vi.mocked(adminApi.runAsAdmin).mockReset()
    vi.mocked(adminApi.r2Cleanup).mockReset()
    vi.mocked(adminApi.runR2Cleanup).mockReset()
    vi.mocked(adminApi.storage).mockReset()
    vi.mocked(adminApi.r2Cleanup).mockResolvedValue({
      lastRun: null,
      running: null
    })
    vi.mocked(adminApi.storage).mockResolvedValue(storage)
  })

  it("只保留升级区：旧说明文字不再渲染", () => {
    render(<DatabaseTab />)

    expect(screen.getByText("数据库升级")).toBeInTheDocument()
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
    render(<DatabaseTab />)

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
    render(<DatabaseTab />)

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
    render(<DatabaseTab />)

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
    render(<DatabaseTab />)

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
    render(<DatabaseTab />)

    expect(
      await screen.findByText("数据库体积 不可得 · 页面 12")
    ).toBeInTheDocument()
    expect(screen.queryByText(/\d MB/)).toBeNull()
  })

  it("体积接口失败时整行不渲染，也不占错误位", async () => {
    vi.mocked(adminApi.storage).mockRejectedValue(new Error("boom"))
    render(<DatabaseTab />)

    await waitFor(() => expect(adminApi.storage).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/数据库体积/)).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("没有清理记录时不渲染摘要，也不留空态文字", async () => {
    render(<DatabaseTab />)

    await waitFor(() => expect(adminApi.r2Cleanup).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/最近清理/)).toBeNull()
  })

  it("摘要读取失败不影响升级，也不显示错误", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.r2Cleanup).mockRejectedValue(new Error("boom"))
    vi.mocked(adminApi.runAsAdmin).mockResolvedValue(result)
    render(<DatabaseTab />)

    await waitFor(() => expect(adminApi.r2Cleanup).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("alert")).toBeNull()

    await user.click(screen.getByRole("button", { name: "检查并升级数据库" }))

    expect(await screen.findByText("当前表前缀")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.queryByText(/最近清理/)).toBeNull()
  })

  it("点「检查并升级数据库」后回显当前表前缀与迁移结果", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.runAsAdmin).mockResolvedValue(result)
    render(<DatabaseTab />)

    await user.click(screen.getByRole("button", { name: "检查并升级数据库" }))

    expect(adminApi.runAsAdmin).toHaveBeenCalledTimes(1)
    expect(await screen.findByText("当前表前缀")).toBeInTheDocument()
    expect(screen.queryByText("生效的表前缀")).toBeNull()
    expect(screen.getByText("ciki_")).toBeInTheDocument()
    expect(screen.getByText("schema_v1")).toBeInTheDocument()
    expect(screen.getByText("已应用")).toBeInTheDocument()
    await waitFor(() => expect(adminApi.r2Cleanup).toHaveBeenCalledTimes(2))
    // 升级后体积行同样重拉一次
    await waitFor(() => expect(adminApi.storage).toHaveBeenCalledTimes(2))
  })

  it("已记账的迁移（skipped）显示「已是最新」而非「已应用」", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.runAsAdmin).mockResolvedValue({
      ...result,
      migrations: [{ name: "schema_v1", status: "skipped" }]
    })
    render(<DatabaseTab />)

    await user.click(screen.getByRole("button", { name: "检查并升级数据库" }))

    expect(await screen.findByText("已是最新")).toBeInTheDocument()
    expect(screen.queryByText("已应用")).toBeNull()
  })

  it("失败时回显错误且不显示升级结果", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.runAsAdmin).mockRejectedValue(new Error("boom"))
    render(<DatabaseTab />)

    await user.click(screen.getByRole("button", { name: "检查并升级数据库" }))

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(screen.queryByText("当前表前缀")).toBeNull()
  })

  it("升级源被拒（409 MIGRATION_REJECTED）时回显指路文案，不显示升级结果", async () => {
    const user = userEvent.setup()
    const { ApiError } = await import("@/lib/api")
    vi.mocked(adminApi.runAsAdmin).mockRejectedValue(
      new ApiError(
        409,
        "Unsupported database shape for schema_v1: table ciki_users is missing",
        "MIGRATION_REJECTED"
      )
    )
    render(<DatabaseTab />)

    await user.click(screen.getByRole("button", { name: "检查并升级数据库" }))

    expect(
      await screen.findByText(/请先用上一版升到最新，再回来点一次/)
    ).toBeInTheDocument()
    expect(screen.queryByText("当前表前缀")).toBeNull()
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
      render(<DatabaseTab />)

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
    render(<DatabaseTab />)

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
})
