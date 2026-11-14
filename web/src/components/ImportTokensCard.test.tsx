import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ImportTokensCard } from "@/components/ImportTokensCard"
import type { ImportTokenSummary } from "@/lib/api"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    meApi: {
      ...actual.meApi,
      importTokens: vi.fn(),
      createImportToken: vi.fn(),
      revokeImportToken: vi.fn()
    }
  }
})

const { meApi } = await import("@/lib/api")

// 假明文：断言只关心它原样回显一次，不写 storage、不进日志
const TOKEN = "ciki_import_token_plaintext"
const CREATED_AT = "2026-11-12T02:00:00.000Z"
const LAST_USED_AT = "2026-11-12T03:30:00.000Z"

const EXTENSION: ImportTokenSummary = {
  id: 3,
  name: "旧插件",
  createdAt: CREATED_AT,
  lastUsedAt: LAST_USED_AT
}

const WORK_LAPTOP: ImportTokenSummary = {
  id: 4,
  name: "工作机",
  createdAt: CREATED_AT,
  lastUsedAt: null
}

beforeEach(() => {
  vi.mocked(meApi.importTokens).mockResolvedValue({
    tokens: [EXTENSION, WORK_LAPTOP]
  })
  vi.mocked(meApi.createImportToken).mockResolvedValue({
    id: 5,
    name: "浏览器插件",
    token: TOKEN
  })
  vi.mocked(meApi.revokeImportToken).mockResolvedValue({ success: true })
})

describe("浏览器插件凭证卡", () => {
  it("列出每条的名称、创建时间与最近使用", async () => {
    render(<ImportTokensCard />)

    expect(await screen.findByText("浏览器插件")).toBeInTheDocument()
    expect(screen.getByText("工作机")).toBeInTheDocument()
    // formatDateTime 统一按 Asia/Shanghai（UTC+8）展示
    expect(screen.getAllByText(/^创建于 /)[0]).toHaveTextContent(
      "创建于 2026-11-12 10:00"
    )
    const lastUsed = screen.getAllByText(/^最近使用 /)
    expect(lastUsed[0]).toHaveTextContent("最近使用 2026-11-12 11:30")
    expect(lastUsed[1]).toHaveTextContent("最近使用 尚未使用")
    expect(screen.getAllByRole("button", { name: "吊销" })).toHaveLength(2)
  })

  it("一条都没有时给空态，新建入口仍在", async () => {
    vi.mocked(meApi.importTokens).mockResolvedValue({ tokens: [] })
    render(<ImportTokensCard />)

    expect(await screen.findByText("还没有插件凭证")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "新建凭证" })).toBeEnabled()
  })

  it("新建留空名称时不带参数，明文一次并给出粘贴去向", async () => {
    vi.mocked(meApi.importTokens)
      .mockResolvedValueOnce({ tokens: [] })
      .mockResolvedValue({ tokens: [EXTENSION] })
    const user = userEvent.setup()
    render(<ImportTokensCard />)

    await screen.findByText("还没有插件凭证")
    await user.click(screen.getByRole("button", { name: "新建凭证" }))
    expect(screen.getByText("留空将自动命名：浏览器插件")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "创建" }))

    expect(meApi.createImportToken).toHaveBeenCalledWith(undefined)
    expect(await screen.findByText(TOKEN)).toBeInTheDocument()
    expect(
      screen.getByText("把凭证粘贴到浏览器插件的设置里，插件只需要这一串。")
    ).toBeInTheDocument()
    expect(window.localStorage.length).toBe(0)
    // 创建成功后重拉列表（id 与最终名称以服务端为准）
    expect(meApi.importTokens).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole("button", { name: "我已保存" }))
    expect(screen.queryByText(TOKEN)).toBeNull()
  })

  it("填了名称就带上，提交后重拉列表", async () => {
    vi.mocked(meApi.importTokens)
      .mockResolvedValueOnce({ tokens: [] })
      .mockResolvedValue({ tokens: [WORK_LAPTOP] })
    const user = userEvent.setup()
    render(<ImportTokensCard />)

    await screen.findByText("还没有插件凭证")
    await user.click(screen.getByRole("button", { name: "新建凭证" }))
    await user.type(screen.getByLabelText("名称"), "工作机")
    await user.click(screen.getByRole("button", { name: "创建" }))

    expect(meApi.createImportToken).toHaveBeenCalledWith("工作机")
  })

  it("吊销要二次确认，确认后按 id 吊销并重拉列表", async () => {
    vi.mocked(meApi.importTokens)
      .mockResolvedValueOnce({ tokens: [EXTENSION, WORK_LAPTOP] })
      .mockResolvedValue({ tokens: [WORK_LAPTOP] })
    const user = userEvent.setup()
    render(<ImportTokensCard />)

    await screen.findByText("浏览器插件")
    await user.click(screen.getAllByRole("button", { name: "吊销" })[0])
    expect(await screen.findByText("吊销这个凭证？")).toBeInTheDocument()
    expect(meApi.revokeImportToken).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "吊销凭证" }))

    expect(meApi.revokeImportToken).toHaveBeenCalledWith(3)
    expect(meApi.importTokens).toHaveBeenCalledTimes(2)
    expect(
      await screen.findByText("凭证已吊销，插件里的旧凭证立即失效。")
    ).toBeInTheDocument()
  })

  it("读取失败时给错误与重试", async () => {
    vi.mocked(meApi.importTokens)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ tokens: [EXTENSION] })
    const user = userEvent.setup()
    render(<ImportTokensCard />)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "网络异常，请稍后重试"
    )
    await user.click(screen.getByRole("button", { name: "重试" }))
    expect(await screen.findByText("浏览器插件")).toBeInTheDocument()
  })
})
