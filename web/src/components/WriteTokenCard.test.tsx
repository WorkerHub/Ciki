import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import { WriteTokenCard } from "@/components/WriteTokenCard"
import { useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    meApi: {
      ...actual.meApi,
      writeToken: vi.fn(),
      createWriteToken: vi.fn(),
      revokeWriteToken: vi.fn(),
      setWriteTokenSpaces: vi.fn()
    }
  }
})

const { ApiError, meApi } = await import("@/lib/api")

// 假明文：断言只关心它原样回显一次，不写 storage、不进日志
const TOKEN = "{{SECRET_wq8m2vnd}}"
const CREATED_AT = "2026-11-12T02:10:00.000Z"
const LAST_USED_AT = "2026-11-12T03:20:00.000Z"

const EMPTY = {
  active: false,
  createdAt: null,
  lastUsedAt: null,
  revokedAt: null,
  spaceIds: null
} as const
const ACTIVE = {
  active: true,
  createdAt: CREATED_AT,
  lastUsedAt: LAST_USED_AT,
  revokedAt: null,
  spaceIds: null
} as const
const REVOKED = {
  active: false,
  createdAt: CREATED_AT,
  lastUsedAt: LAST_USED_AT,
  revokedAt: LAST_USED_AT,
  spaceIds: null
} as const

beforeEach(() => {
  // 令牌卡里的空间范围读会话空间 store，这里给空列表即可（用例不展开勾选）
  useSpacesStore.setState({ spaces: [], status: "ready", currentId: null })
  vi.mocked(meApi.writeToken).mockResolvedValue({ ...EMPTY })
  vi.mocked(meApi.createWriteToken).mockResolvedValue({
    token: TOKEN,
    createdAt: CREATED_AT
  })
  vi.mocked(meApi.revokeWriteToken).mockResolvedValue({ success: true })
})

describe("读写接口令牌卡", () => {
  it("从未生成时只给「生成令牌」，没有重置 / 吊销", async () => {
    render(<WriteTokenCard />)

    expect(await screen.findByText("读写接口令牌")).toBeInTheDocument()
    expect(
      await screen.findByRole("button", { name: "生成令牌" })
    ).toBeInTheDocument()
    expect(screen.getByText("还没有读写接口令牌")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "重置" })).toBeNull()
    expect(screen.queryByRole("button", { name: "吊销" })).toBeNull()
  })

  it("生成后明文只展示一次，「我已保存」后不再回显", async () => {
    const user = userEvent.setup()
    render(<WriteTokenCard />)

    await user.click(await screen.findByRole("button", { name: "生成令牌" }))

    expect(await screen.findByText(TOKEN)).toBeInTheDocument()
    expect(screen.getByText(/这串令牌只显示这一次/)).toBeInTheDocument()
    expect(meApi.createWriteToken).toHaveBeenCalledTimes(1)
    expect(screen.getByText("生效中")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "我已保存" }))
    expect(screen.queryByText(TOKEN)).toBeNull()
    expect(meApi.createWriteToken).toHaveBeenCalledTimes(1)
  })

  it("生效中显示创建时间与最近使用时间", async () => {
    vi.mocked(meApi.writeToken).mockResolvedValue({ ...ACTIVE })
    render(<WriteTokenCard />)

    expect(await screen.findByText("生效中")).toBeInTheDocument()
    expect(screen.getByText(/^创建于 /)).toHaveTextContent(
      "创建于 2026-11-12 10:10"
    )
    expect(screen.getByText(/^最近使用 /)).toHaveTextContent(
      "最近使用 2026-11-12 11:20"
    )
    expect(screen.getByRole("button", { name: "重置" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "吊销" })).toBeInTheDocument()
  })

  it("重置要二次确认，确认后才发 POST 并给出新明文", async () => {
    vi.mocked(meApi.writeToken).mockResolvedValue({ ...ACTIVE })
    const user = userEvent.setup()
    render(<WriteTokenCard />)

    await user.click(await screen.findByRole("button", { name: "重置" }))
    expect(await screen.findByText("重置读写接口令牌？")).toBeInTheDocument()
    expect(meApi.createWriteToken).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "重置令牌" }))
    expect(meApi.createWriteToken).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(TOKEN)).toBeInTheDocument()
    expect(screen.getByText("令牌已重置，旧令牌立即失效。")).toBeInTheDocument()
  })

  it("吊销要二次确认，吊销后显示「已吊销」与吊销时间", async () => {
    vi.mocked(meApi.writeToken)
      .mockResolvedValueOnce({ ...ACTIVE })
      .mockResolvedValueOnce({ ...REVOKED })
    const user = userEvent.setup()
    render(<WriteTokenCard />)

    await user.click(await screen.findByRole("button", { name: "吊销" }))
    expect(await screen.findByText("吊销读写接口令牌？")).toBeInTheDocument()
    expect(meApi.revokeWriteToken).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "吊销令牌" }))
    expect(meApi.revokeWriteToken).toHaveBeenCalledTimes(1)
    expect(
      await screen.findByText("令牌已吊销，外部应用里的旧令牌立即失效。")
    ).toBeInTheDocument()
    expect(await screen.findByText("已吊销")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "重新生成" })).toBeInTheDocument()
  })

  it("吊销时 404 视为已不存在：刷新状态并提示，不报错", async () => {
    vi.mocked(meApi.writeToken)
      .mockResolvedValueOnce({ ...ACTIVE })
      .mockResolvedValueOnce({ ...REVOKED })
    vi.mocked(meApi.revokeWriteToken).mockRejectedValue(
      new ApiError(404, "Write token not found")
    )
    const user = userEvent.setup()
    render(<WriteTokenCard />)

    await user.click(await screen.findByRole("button", { name: "吊销" }))
    await user.click(screen.getByRole("button", { name: "吊销令牌" }))

    expect(
      await screen.findByText("令牌已不存在，已刷新状态。")
    ).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(meApi.writeToken).toHaveBeenCalledTimes(2)
  })

  it("状态读取失败时给出错误与重试，且不渲染操作按钮", async () => {
    vi.mocked(meApi.writeToken)
      .mockRejectedValueOnce(
        new ApiError(429, "Too many requests", "RATE_LIMITED")
      )
      .mockResolvedValueOnce({ ...EMPTY })
    const user = userEvent.setup()
    render(<WriteTokenCard />)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "尝试次数过多，请稍后再试。"
    )
    expect(screen.queryByRole("button", { name: "生成令牌" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "重试" }))
    expect(
      await screen.findByRole("button", { name: "生成令牌" })
    ).toBeInTheDocument()
    expect(meApi.writeToken).toHaveBeenCalledTimes(2)
  })

  it("只动读写接口令牌：生成 / 吊销都不碰只读与导入令牌接口", async () => {
    const createRead = vi.spyOn(meApi, "createReadToken")
    const revokeRead = vi.spyOn(meApi, "revokeReadToken")
    const createImport = vi.spyOn(meApi, "createImportToken")
    const user = userEvent.setup()
    render(<WriteTokenCard />)

    await user.click(await screen.findByRole("button", { name: "生成令牌" }))
    await screen.findByText(TOKEN)
    await user.click(screen.getByRole("button", { name: "吊销" }))
    await user.click(screen.getByRole("button", { name: "吊销令牌" }))

    expect(createRead).not.toHaveBeenCalled()
    expect(revokeRead).not.toHaveBeenCalled()
    expect(createImport).not.toHaveBeenCalled()
    createRead.mockRestore()
    revokeRead.mockRestore()
    createImport.mockRestore()
  })

  it("重置保留已收窄的空间范围，不闪回「全部空间」", async () => {
    useSpacesStore.setState({
      spaces: [
        {
          id: 1,
          slug: "space-1",
          name: "默认空间",
          description: "",
          myRole: "admin",
          isDefault: true,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z"
        },
        {
          id: 2,
          slug: "space-2",
          name: "研发空间",
          description: "",
          myRole: "editor",
          isDefault: false,
          createdAt: "2026-11-02T00:00:00.000Z",
          updatedAt: "2026-11-02T00:00:00.000Z"
        }
      ],
      status: "ready",
      currentId: 1
    })
    vi.mocked(meApi.writeToken).mockResolvedValue({
      ...ACTIVE,
      spaceIds: [1, 2]
    })
    const user = userEvent.setup()
    render(<WriteTokenCard />)

    expect(
      await screen.findByRole("radio", { name: "指定空间" })
    ).toHaveAttribute("aria-checked", "true")

    await user.click(screen.getByRole("button", { name: "重置" }))
    await user.click(screen.getByRole("button", { name: "重置令牌" }))
    await screen.findByText(TOKEN)

    expect(screen.getByRole("radio", { name: "指定空间" })).toHaveAttribute(
      "aria-checked",
      "true"
    )
  })
})

describe("读写接口令牌卡 · 英文界面", () => {
  it("标题与空态用读写接口令牌的英文名词", async () => {
    await i18n.changeLanguage("en")
    render(<WriteTokenCard />)

    expect(await screen.findByText("Read-write API token")).toBeInTheDocument()
    expect(screen.getByText("No read-write API token yet")).toBeInTheDocument()
  })
})
