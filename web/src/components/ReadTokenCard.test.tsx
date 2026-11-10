import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ReadTokenCard } from "@/components/ReadTokenCard"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    meApi: {
      ...actual.meApi,
      readToken: vi.fn(),
      createReadToken: vi.fn(),
      revokeReadToken: vi.fn()
    }
  }
})

const { ApiError, meApi } = await import("@/lib/api")

// 假明文：断言只关心它原样回显一次，不写 storage、不进日志
const TOKEN = "ciki-read-2026testtoken"
const CREATED_AT = "2026-11-10T14:10:00.000Z"
const LAST_USED_AT = "2026-11-10T15:20:00.000Z"

const EMPTY = {
  active: false,
  createdAt: null,
  lastUsedAt: null,
  revokedAt: null
} as const
const ACTIVE = {
  active: true,
  createdAt: CREATED_AT,
  lastUsedAt: LAST_USED_AT,
  revokedAt: null
} as const
const REVOKED = {
  active: false,
  createdAt: CREATED_AT,
  lastUsedAt: LAST_USED_AT,
  revokedAt: LAST_USED_AT
} as const

beforeEach(() => {
  vi.mocked(meApi.readToken).mockResolvedValue({ ...EMPTY })
  vi.mocked(meApi.createReadToken).mockResolvedValue({
    token: TOKEN,
    createdAt: CREATED_AT
  })
  vi.mocked(meApi.revokeReadToken).mockResolvedValue({ success: true })
})

describe("只读接口令牌卡", () => {
  it("从未生成时只给「生成令牌」，没有重置 / 吊销", async () => {
    render(<ReadTokenCard />)

    expect(await screen.findByText("只读接口令牌")).toBeInTheDocument()
    expect(
      await screen.findByRole("button", { name: "生成令牌" })
    ).toBeInTheDocument()
    expect(screen.getByText("还没有只读接口令牌")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "重置" })).toBeNull()
    expect(screen.queryByRole("button", { name: "吊销" })).toBeNull()
  })

  it("生效中显示徽标、创建时间与最近使用时间", async () => {
    vi.mocked(meApi.readToken).mockResolvedValue({ ...ACTIVE })
    render(<ReadTokenCard />)

    expect(await screen.findByText("生效中")).toBeInTheDocument()
    // formatDateTime 统一按 Asia/Shanghai（UTC+8）展示
    expect(screen.getByText(/^创建于 /)).toHaveTextContent(
      "创建于 2026-11-10 22:10"
    )
    expect(screen.getByText(/^最近使用 /)).toHaveTextContent(
      "最近使用 2026-11-10 23:20"
    )
    expect(screen.queryByRole("button", { name: "生成令牌" })).toBeNull()
    expect(screen.getByRole("button", { name: "重置" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "吊销" })).toBeInTheDocument()
  })

  it("生成后明文只展示一次，「我已保存」后不再回显", async () => {
    const user = userEvent.setup()
    render(<ReadTokenCard />)

    await user.click(await screen.findByRole("button", { name: "生成令牌" }))

    expect(await screen.findByText(TOKEN)).toBeInTheDocument()
    expect(screen.getByText(/这串令牌只显示这一次/)).toBeInTheDocument()
    expect(meApi.createReadToken).toHaveBeenCalledTimes(1)
    expect(screen.getByText("生效中")).toBeInTheDocument()
    // 明文不进 storage：刷新/离开后只能重新生成
    expect(window.localStorage.length).toBe(0)

    await user.click(screen.getByRole("button", { name: "我已保存" }))
    expect(screen.queryByText(TOKEN)).toBeNull()
    expect(meApi.createReadToken).toHaveBeenCalledTimes(1)
  })

  it("重置要二次确认，确认后才发 POST 并给出新明文", async () => {
    vi.mocked(meApi.readToken).mockResolvedValue({ ...ACTIVE })
    const user = userEvent.setup()
    render(<ReadTokenCard />)

    await user.click(await screen.findByRole("button", { name: "重置" }))
    expect(await screen.findByText("重置只读接口令牌？")).toBeInTheDocument()
    expect(meApi.createReadToken).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "重置令牌" }))
    expect(meApi.createReadToken).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(TOKEN)).toBeInTheDocument()
    expect(screen.getByText("令牌已重置，旧令牌立即失效。")).toBeInTheDocument()
  })

  it("吊销要二次确认，吊销后显示「已吊销」与吊销时间", async () => {
    vi.mocked(meApi.readToken)
      .mockResolvedValueOnce({ ...ACTIVE })
      .mockResolvedValueOnce({ ...REVOKED })
    const user = userEvent.setup()
    render(<ReadTokenCard />)

    await user.click(await screen.findByRole("button", { name: "吊销" }))
    expect(await screen.findByText("吊销只读接口令牌？")).toBeInTheDocument()
    expect(meApi.revokeReadToken).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "吊销令牌" }))
    expect(meApi.revokeReadToken).toHaveBeenCalledTimes(1)
    expect(
      await screen.findByText("令牌已吊销，外部应用里的旧令牌立即失效。")
    ).toBeInTheDocument()
    expect(await screen.findByText("已吊销")).toBeInTheDocument()
    expect(screen.getByText(/^吊销于 /)).toHaveTextContent(
      "吊销于 2026-11-10 23:20"
    )
    expect(screen.getByRole("button", { name: "重新生成" })).toBeInTheDocument()
  })

  it("吊销时 404 视为已不存在：刷新状态并提示，不报错", async () => {
    vi.mocked(meApi.readToken)
      .mockResolvedValueOnce({ ...ACTIVE })
      .mockResolvedValueOnce({ ...REVOKED })
    vi.mocked(meApi.revokeReadToken).mockRejectedValue(
      new ApiError(404, "Read token not found")
    )
    const user = userEvent.setup()
    render(<ReadTokenCard />)

    await user.click(await screen.findByRole("button", { name: "吊销" }))
    await user.click(screen.getByRole("button", { name: "吊销令牌" }))

    expect(
      await screen.findByText("令牌已不存在，已刷新状态。")
    ).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(meApi.readToken).toHaveBeenCalledTimes(2)
    expect(await screen.findByText("已吊销")).toBeInTheDocument()
  })

  it("状态读取失败时给出错误与重试，且不渲染操作按钮", async () => {
    vi.mocked(meApi.readToken)
      .mockRejectedValueOnce(
        new ApiError(429, "Too many requests", "RATE_LIMITED")
      )
      .mockResolvedValueOnce({ ...EMPTY })
    const user = userEvent.setup()
    render(<ReadTokenCard />)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "尝试次数过多，请稍后再试。"
    )
    expect(screen.queryByRole("button", { name: "生成令牌" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "重试" }))
    expect(
      await screen.findByRole("button", { name: "生成令牌" })
    ).toBeInTheDocument()
    expect(meApi.readToken).toHaveBeenCalledTimes(2)
  })

  it("只动只读接口令牌：生成 / 吊销都不碰导入令牌接口", async () => {
    const createImport = vi.spyOn(meApi, "createImportToken")
    const revokeImport = vi.spyOn(meApi, "revokeImportToken")
    const user = userEvent.setup()
    render(<ReadTokenCard />)

    await user.click(await screen.findByRole("button", { name: "生成令牌" }))
    await screen.findByText(TOKEN)
    await user.click(screen.getByRole("button", { name: "吊销" }))
    await user.click(screen.getByRole("button", { name: "吊销令牌" }))

    expect(createImport).not.toHaveBeenCalled()
    expect(revokeImport).not.toHaveBeenCalled()
    createImport.mockRestore()
    revokeImport.mockRestore()
  })
})
