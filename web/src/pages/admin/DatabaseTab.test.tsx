import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { R2CleanupSummary, SetupResult } from "@/lib/api"
import { DatabaseTab } from "@/pages/admin/DatabaseTab"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      runAsAdmin: vi.fn(),
      r2Cleanup: vi.fn()
    }
  }
})

const { adminApi } = await import("@/lib/api")

const result: SetupResult = {
  success: true,
  tablePrefix: "ciki_",
  migrations: [{ name: "schema_v1", status: "applied" }]
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
    vi.mocked(adminApi.r2Cleanup).mockResolvedValue({ lastRun: null })
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
    vi.mocked(adminApi.r2Cleanup).mockResolvedValue({ lastRun })
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
})
