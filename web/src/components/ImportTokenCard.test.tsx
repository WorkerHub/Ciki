import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ImportTokenCard } from "@/components/ImportTokenCard"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    meApi: {
      ...actual.meApi,
      importToken: vi.fn(),
      createImportToken: vi.fn(),
      revokeImportToken: vi.fn()
    }
  }
})

const { ApiError, meApi } = await import("@/lib/api")

// 假明文（43 字符，与契约的 base64url 长度一致），断言只关心它原样回显一次
const TOKEN = "ciki-demo-token-AAAA1111BBBB2222CCCC3333DDD"
const CREATED_AT = "2026-11-07T14:10:00.000Z"
const LAST_USED_AT = "2026-11-07T15:20:00.000Z"

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
  vi.mocked(meApi.importToken).mockResolvedValue({ ...EMPTY })
  vi.mocked(meApi.createImportToken).mockResolvedValue({
    token: TOKEN,
    createdAt: CREATED_AT
  })
  vi.mocked(meApi.revokeImportToken).mockResolvedValue({ success: true })
})

describe("导入令牌卡", () => {
  it("从未生成时只给「生成令牌」，没有重置 / 吊销", async () => {
    render(<ImportTokenCard />)

    expect(
      await screen.findByRole("button", { name: "生成令牌" })
    ).toBeInTheDocument()
    expect(screen.getByText("还没有导入令牌")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "重置" })).toBeNull()
    expect(screen.queryByRole("button", { name: "吊销" })).toBeNull()
  })

  it("生效中显示徽标、创建时间与最近使用时间", async () => {
    vi.mocked(meApi.importToken).mockResolvedValue({ ...ACTIVE })
    render(<ImportTokenCard />)

    expect(await screen.findByText("生效中")).toBeInTheDocument()
    // formatDateTime 统一按北京时间（UTC+8）展示
    expect(screen.getByText(/^创建于 /)).toHaveTextContent(
      "创建于 2026-11-07 22:10"
    )
    expect(screen.getByText(/^最近使用 /)).toHaveTextContent(
      "最近使用 2026-11-07 23:20"
    )
    expect(screen.queryByRole("button", { name: "生成令牌" })).toBeNull()
    expect(screen.getByRole("button", { name: "重置" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "吊销" })).toBeInTheDocument()
  })

  it("生成后明文只展示一次，「我已保存」后不再回显", async () => {
    const user = userEvent.setup()
    render(<ImportTokenCard />)

    await user.click(await screen.findByRole("button", { name: "生成令牌" }))

    expect(await screen.findByText(TOKEN)).toBeInTheDocument()
    expect(screen.getByText(/这串令牌只显示这一次/)).toBeInTheDocument()
    expect(meApi.createImportToken).toHaveBeenCalledTimes(1)
    // 生成后立刻进入生效中，不会同时显示「还没有导入令牌」
    expect(screen.getByText("生效中")).toBeInTheDocument()
    expect(screen.queryByText("还没有导入令牌")).toBeNull()

    await user.click(screen.getByRole("button", { name: "我已保存" }))
    expect(screen.queryByText(TOKEN)).toBeNull()
    expect(meApi.createImportToken).toHaveBeenCalledTimes(1)
  })

  it("「复制」把明文写进剪贴板并切到「已复制」", async () => {
    const user = userEvent.setup()
    render(<ImportTokenCard />)

    await user.click(await screen.findByRole("button", { name: "生成令牌" }))
    await user.click(await screen.findByRole("button", { name: "复制令牌" }))

    expect(await navigator.clipboard.readText()).toBe(TOKEN)
    expect(
      await screen.findByRole("button", { name: "已复制" })
    ).toBeInTheDocument()
  })

  it("复制被拒绝时提示手动复制，明文不消失", async () => {
    const user = userEvent.setup()
    render(<ImportTokenCard />)
    await user.click(await screen.findByRole("button", { name: "生成令牌" }))

    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new Error("NotAllowedError")
    )
    await user.click(screen.getByRole("button", { name: "复制令牌" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "复制失败，请手动选中令牌文本复制。"
    )
    expect(screen.getByText(TOKEN)).toBeInTheDocument()
  })

  it("重置要二次确认，确认后才发 POST 并给出新明文", async () => {
    vi.mocked(meApi.importToken).mockResolvedValue({ ...ACTIVE })
    const user = userEvent.setup()
    render(<ImportTokenCard />)

    await user.click(await screen.findByRole("button", { name: "重置" }))
    expect(await screen.findByText("重置导入令牌？")).toBeInTheDocument()
    expect(meApi.createImportToken).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "重置令牌" }))
    expect(meApi.createImportToken).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(TOKEN)).toBeInTheDocument()
  })

  it("吊销要二次确认，吊销后显示「已吊销」与吊销时间", async () => {
    vi.mocked(meApi.importToken)
      .mockResolvedValueOnce({ ...ACTIVE })
      .mockResolvedValueOnce({ ...REVOKED })
    const user = userEvent.setup()
    render(<ImportTokenCard />)

    await user.click(await screen.findByRole("button", { name: "吊销" }))
    expect(await screen.findByText("吊销导入令牌？")).toBeInTheDocument()
    expect(meApi.revokeImportToken).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "吊销令牌" }))
    expect(meApi.revokeImportToken).toHaveBeenCalledTimes(1)
    expect(await screen.findByText("已吊销")).toBeInTheDocument()
    expect(screen.getByText(/^吊销于 /)).toHaveTextContent(
      "吊销于 2026-11-07 23:20"
    )
    expect(screen.getByRole("button", { name: "重新生成" })).toBeInTheDocument()
  })

  it("吊销时 404 视为已不存在：刷新状态并提示，不报错", async () => {
    vi.mocked(meApi.importToken)
      .mockResolvedValueOnce({ ...ACTIVE })
      .mockResolvedValueOnce({ ...REVOKED })
    vi.mocked(meApi.revokeImportToken).mockRejectedValue(
      new ApiError(404, "Import token not found")
    )
    const user = userEvent.setup()
    render(<ImportTokenCard />)

    await user.click(await screen.findByRole("button", { name: "吊销" }))
    await user.click(await screen.findByRole("button", { name: "吊销令牌" }))

    expect(
      await screen.findByText("令牌已不存在，已刷新状态。")
    ).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(meApi.importToken).toHaveBeenCalledTimes(2)
    expect(await screen.findByText("已吊销")).toBeInTheDocument()
  })

  it("状态读取失败时给出错误与重试，且不渲染操作按钮", async () => {
    vi.mocked(meApi.importToken)
      .mockRejectedValueOnce(
        new ApiError(429, "Too many requests", "RATE_LIMITED")
      )
      .mockResolvedValueOnce({ ...EMPTY })
    const user = userEvent.setup()
    render(<ImportTokenCard />)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "尝试次数过多，请稍后再试。"
    )
    expect(screen.queryByRole("button", { name: "生成令牌" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "重试" }))
    expect(
      await screen.findByRole("button", { name: "生成令牌" })
    ).toBeInTheDocument()
    expect(meApi.importToken).toHaveBeenCalledTimes(2)
  })
})
