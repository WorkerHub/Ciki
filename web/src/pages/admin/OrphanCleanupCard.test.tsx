import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import { ApiError, type R2CleanupRunResult } from "@/lib/api"
import { OrphanCleanupCard } from "@/pages/admin/OrphanCleanupCard"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      runR2Cleanup: vi.fn()
    }
  }
})

const { adminApi } = await import("@/lib/api")

/** dry run 的响应：多出 prunable / prunableBytes 两项。 */
const dryRun: R2CleanupRunResult = {
  startedAt: "2026-11-10T09:00:00.000Z",
  finishedAt: "2026-11-10T09:00:02.000Z",
  trigger: "manual",
  status: "ok",
  dryRun: true,
  scanned: 120,
  referenced: 90,
  deleted: 20,
  youngSkipped: 7,
  failed: 0,
  truncated: true,
  prunable: 260,
  prunableBytes: 2 * 1024 * 1024
}

/** 实跑的响应：与日志行同形，没有 prunable 两项。 */
const realRun: R2CleanupRunResult = {
  startedAt: "2026-11-10T09:05:00.000Z",
  finishedAt: "2026-11-10T09:05:04.000Z",
  trigger: "manual",
  status: "ok",
  dryRun: false,
  scanned: 120,
  referenced: 90,
  deleted: 200,
  youngSkipped: 7,
  failed: 0,
  truncated: true
}

function renderCard(
  props: Partial<{
    runningSeconds: number | null
    onBlocked: (seconds: number) => void
    onRefresh: () => void
  }> = {}
) {
  const onBlocked = props.onBlocked ?? vi.fn()
  const onRefresh = props.onRefresh ?? vi.fn()
  const view = render(
    <OrphanCleanupCard
      runningSeconds={props.runningSeconds ?? null}
      onBlocked={onBlocked}
      onRefresh={onRefresh}
    />
  )
  return { onBlocked, onRefresh, ...view }
}

describe("孤儿图片清理 · 两步流程", () => {
  beforeEach(() => {
    vi.mocked(adminApi.runR2Cleanup).mockReset()
  })

  it("初始只有扫描按钮，不显示数字与第二步", () => {
    renderCard()

    expect(
      screen.getByRole("button", { name: "扫描孤儿图片" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "立即清理" })).toBeNull()
    expect(screen.queryByRole("status")).toBeNull()
    expect(adminApi.runR2Cleanup).not.toHaveBeenCalled()
  })

  it("扫描只算不删：显示四项数字，可清理数 >0 才给「立即清理」", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.runR2Cleanup).mockResolvedValue(dryRun)
    renderCard()

    await user.click(screen.getByRole("button", { name: "扫描孤儿图片" }))

    expect(adminApi.runR2Cleanup).toHaveBeenCalledWith(true)
    expect(
      await screen.findByText(
        "扫描 120 · 引用 90 · 可清理 260（2.0 MB） · 未满 30 天跳过 7"
      )
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "立即清理" })).toBeEnabled()
  })

  it("没有可清理对象时不给第二步", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.runR2Cleanup).mockResolvedValue({
      ...dryRun,
      deleted: 0,
      truncated: false,
      prunable: 0,
      prunableBytes: 0
    })
    renderCard()

    await user.click(screen.getByRole("button", { name: "扫描孤儿图片" }))

    expect(
      await screen.findByText(
        "扫描 120 · 引用 90 · 可清理 0（0 B） · 未满 30 天跳过 7"
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "立即清理" })).toBeNull()
  })

  it("确认框写明数量、大小与不可恢复，确认后实跑并交出本轮结果", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.runR2Cleanup)
      .mockResolvedValueOnce(dryRun)
      .mockResolvedValueOnce(realRun)
    const onRefresh = vi.fn()
    renderCard({ onRefresh })

    await user.click(screen.getByRole("button", { name: "扫描孤儿图片" }))
    await user.click(await screen.findByRole("button", { name: "立即清理" }))

    const confirm = await screen.findByRole("alertdialog")
    expect(
      within(confirm).getByText(
        "将永久删除 260 个对象（2.0 MB），删除后无法恢复。"
      )
    ).toBeInTheDocument()

    await user.click(
      within(confirm).getByRole("button", { name: "删除 260 个" })
    )

    expect(adminApi.runR2Cleanup).toHaveBeenNthCalledWith(2, false)
    expect(
      await screen.findByText("本轮已删除 200 · 失败 0，仍有剩余，可再扫描一轮")
    ).toBeInTheDocument()
    expect(onRefresh).toHaveBeenCalledTimes(1)
    // 扫出来的数已被这一轮消耗：第二步收起，要再删得重新扫描
    expect(screen.queryByRole("button", { name: "立即清理" })).toBeNull()
  })

  it("实跑未触顶时不提示剩余", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.runR2Cleanup)
      .mockResolvedValueOnce(dryRun)
      .mockResolvedValueOnce({ ...realRun, deleted: 12, truncated: false })
    renderCard()

    await user.click(screen.getByRole("button", { name: "扫描孤儿图片" }))
    await user.click(await screen.findByRole("button", { name: "立即清理" }))
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "删除 260 个"
      })
    )

    expect(
      await screen.findByText("本轮已删除 12 · 失败 0")
    ).toBeInTheDocument()
  })

  it("已有清理在跑时两个按钮都禁用并显示等待时长", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.runR2Cleanup).mockResolvedValue(dryRun)
    const { rerender, onBlocked, onRefresh } = renderCard()

    await user.click(screen.getByRole("button", { name: "扫描孤儿图片" }))
    expect(
      await screen.findByRole("button", { name: "立即清理" })
    ).toBeEnabled()

    rerender(
      <OrphanCleanupCard
        runningSeconds={90}
        onBlocked={onBlocked}
        onRefresh={onRefresh}
      />
    )

    expect(screen.getByRole("button", { name: "扫描孤儿图片" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "立即清理" })).toBeDisabled()
    expect(
      screen.getByText("清理进行中，约 2 分钟后可再试")
    ).toBeInTheDocument()
  })

  it("扫描撞 409 时按 retryAfter 切到进行中，不另报错", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.runR2Cleanup).mockRejectedValue(
      new ApiError(
        409,
        "Cleanup already running",
        "CLEANUP_IN_PROGRESS",
        42,
        undefined,
        "/admin/r2-cleanup"
      )
    )
    const onBlocked = vi.fn()
    renderCard({ onBlocked })

    await user.click(screen.getByRole("button", { name: "扫描孤儿图片" }))

    await waitFor(() => expect(onBlocked).toHaveBeenCalledWith(42))
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("干跑响应缺可清理数时报错，且不给第二步", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.runR2Cleanup).mockResolvedValue({
      ...dryRun,
      prunable: undefined,
      prunableBytes: undefined
    })
    renderCard()

    await user.click(screen.getByRole("button", { name: "扫描孤儿图片" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "扫描结果缺少可清理数与总大小，请确认后端版本后重试。"
    )
    expect(screen.queryByRole("button", { name: "立即清理" })).toBeNull()
  })

  it("实跑撞 409 时同样切到进行中、关掉确认框，也不另报错", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.runR2Cleanup)
      .mockResolvedValueOnce(dryRun)
      .mockRejectedValueOnce(
        new ApiError(
          409,
          "Cleanup already running",
          "CLEANUP_IN_PROGRESS",
          42,
          undefined,
          "/admin/r2-cleanup"
        )
      )
    const onBlocked = vi.fn()
    renderCard({ onBlocked })

    await user.click(screen.getByRole("button", { name: "扫描孤儿图片" }))
    await user.click(await screen.findByRole("button", { name: "立即清理" }))
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "删除 260 个"
      })
    )

    await waitFor(() => expect(onBlocked).toHaveBeenCalledWith(42))
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
    // 这一轮什么都没删：扫描结果留着，锁释放后可继续
    expect(screen.getByRole("button", { name: "立即清理" })).toBeInTheDocument()
  })
})

describe("孤儿图片清理 · 英文界面", () => {
  it("标题、按钮与锁等待时长都是英文", async () => {
    await i18n.changeLanguage("en")
    renderCard({ runningSeconds: 42 })

    expect(screen.getByText("Orphaned image cleanup")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Scan for orphaned images" })
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Cleanup in progress; try again in about 42 seconds\./)
    ).toBeInTheDocument()
  })
})
