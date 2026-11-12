import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiTokensCard } from "@/components/ApiTokensCard"
import type { ApiTokenSummary, Space } from "@/lib/api"
import { useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    meApi: {
      ...actual.meApi,
      tokens: vi.fn(),
      createToken: vi.fn(),
      renameToken: vi.fn(),
      setTokenSpaces: vi.fn(),
      revokeToken: vi.fn()
    }
  }
})

const { meApi } = await import("@/lib/api")

// 假明文：断言只关心它原样回显一次，不写 storage、不进日志
const TOKEN = "ciki_read_token_plaintext"
const CREATED_AT = "2026-11-12T02:00:00.000Z"
const LAST_USED_AT = "2026-11-12T03:30:00.000Z"

const READ_TOKEN: ApiTokenSummary = {
  id: 7,
  name: "只读 Token",
  kind: "read",
  spaceIds: null,
  createdAt: CREATED_AT,
  lastUsedAt: LAST_USED_AT
}

const WRITE_TOKEN: ApiTokenSummary = {
  id: 8,
  name: "Muse",
  kind: "write",
  spaceIds: [1, 2],
  createdAt: CREATED_AT,
  lastUsedAt: null
}

const SPACES: Space[] = [
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
]

beforeEach(() => {
  useSpacesStore.setState({ spaces: SPACES, status: "ready", currentId: 1 })
  vi.mocked(meApi.tokens).mockResolvedValue({
    tokens: [READ_TOKEN, WRITE_TOKEN]
  })
  vi.mocked(meApi.createToken).mockResolvedValue({
    id: 9,
    name: "只读 Token",
    kind: "read",
    spaceIds: null,
    token: TOKEN
  })
  vi.mocked(meApi.renameToken).mockResolvedValue({})
  vi.mocked(meApi.setTokenSpaces).mockResolvedValue({ spaceIds: [1] })
  vi.mocked(meApi.revokeToken).mockResolvedValue({ success: true })
})

describe("API Token 卡", () => {
  it("列出每条的名称、类型、范围摘要与最近使用", async () => {
    render(<ApiTokensCard />)

    expect(await screen.findByText("只读 Token")).toBeInTheDocument()
    expect(screen.getByText("Muse")).toBeInTheDocument()
    expect(screen.getByText("只读")).toBeInTheDocument()
    expect(screen.getByText("读写")).toBeInTheDocument()
    expect(screen.getByText("全部空间")).toBeInTheDocument()
    expect(screen.getByText("指定空间（2 个）")).toBeInTheDocument()
    // formatDateTime 统一按 Asia/Shanghai（UTC+8）展示
    const lastUsed = screen.getAllByText(/^最近使用 /)
    expect(lastUsed[0]).toHaveTextContent("最近使用 2026-11-12 11:30")
    expect(lastUsed[1]).toHaveTextContent("最近使用 尚未使用")
  })

  it("一条都没有时给空态，新建入口仍在", async () => {
    vi.mocked(meApi.tokens).mockResolvedValue({ tokens: [] })
    render(<ApiTokensCard />)

    expect(await screen.findByText("还没有 API Token")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "新建 Token" })).toBeEnabled()
    expect(screen.queryByRole("button", { name: "吊销" })).toBeNull()
  })

  it("新建留空名称时不带 name，明文只展示一次", async () => {
    vi.mocked(meApi.tokens)
      .mockResolvedValueOnce({ tokens: [] })
      .mockResolvedValue({ tokens: [READ_TOKEN] })
    const user = userEvent.setup()
    render(<ApiTokensCard />)

    await screen.findByText("还没有 API Token")
    await user.click(screen.getByRole("button", { name: "新建 Token" }))
    expect(screen.getByText("留空将自动命名：只读 Token")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "创建" }))

    expect(meApi.createToken).toHaveBeenCalledWith({
      kind: "read",
      spaceIds: null
    })
    expect(await screen.findByText(TOKEN)).toBeInTheDocument()
    // 创建成功后重拉列表（id 与最终名称以服务端为准）
    expect(meApi.tokens).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole("button", { name: "我已保存" }))
    expect(screen.queryByText(TOKEN)).toBeNull()
    expect(meApi.createToken).toHaveBeenCalledTimes(1)
  })

  it("新建可切读写、填名称并指定空间，提交时三个字段都带上", async () => {
    vi.mocked(meApi.tokens)
      .mockResolvedValueOnce({ tokens: [] })
      .mockResolvedValue({ tokens: [WRITE_TOKEN] })
    const user = userEvent.setup()
    render(<ApiTokensCard />)

    await screen.findByText("还没有 API Token")
    await user.click(screen.getByRole("button", { name: "新建 Token" }))

    await user.click(screen.getByRole("radio", { name: "读写" }))
    expect(screen.getByText("留空将自动命名：读写 Token")).toBeInTheDocument()

    await user.type(screen.getByLabelText("名称"), "Muse")
    await user.click(screen.getByRole("radio", { name: "指定空间" }))
    await user.click(screen.getByRole("checkbox", { name: "研发空间" }))
    await user.click(screen.getByRole("button", { name: "创建" }))

    expect(meApi.createToken).toHaveBeenCalledWith({
      kind: "write",
      name: "Muse",
      spaceIds: [2]
    })
  })

  it("指定空间一个没勾时不能创建（契约里空数组整个 400）", async () => {
    vi.mocked(meApi.tokens).mockResolvedValue({ tokens: [] })
    const user = userEvent.setup()
    render(<ApiTokensCard />)

    await screen.findByText("还没有 API Token")
    await user.click(screen.getByRole("button", { name: "新建 Token" }))
    await user.click(screen.getByRole("radio", { name: "指定空间" }))

    expect(screen.getByRole("button", { name: "创建" })).toBeDisabled()
    await user.click(screen.getByRole("checkbox", { name: "默认空间" }))
    expect(screen.getByRole("button", { name: "创建" })).toBeEnabled()
  })

  it("改名走 PUT 并按新名字重拉列表", async () => {
    const user = userEvent.setup()
    render(<ApiTokensCard />)

    await screen.findByText("只读 Token")
    await user.click(screen.getAllByRole("button", { name: "改名" })[0])

    expect(await screen.findByText("修改 Token 名称")).toBeInTheDocument()
    const input = screen.getByLabelText("名称")
    await user.clear(input)
    await user.type(input, "外部只读")
    await user.click(screen.getByRole("button", { name: "保存" }))

    expect(meApi.renameToken).toHaveBeenCalledWith(7, "外部只读")
    expect(meApi.tokens).toHaveBeenCalledTimes(2)
  })

  it("改范围走 PUT spaces：只动范围、不换令牌", async () => {
    const user = userEvent.setup()
    render(<ApiTokensCard />)

    await screen.findByText("只读 Token")
    await user.click(screen.getAllByRole("button", { name: "改范围" })[0])
    await user.click(screen.getByRole("radio", { name: "指定空间" }))
    await user.click(screen.getByRole("checkbox", { name: "默认空间" }))
    await user.click(screen.getByRole("button", { name: "保存范围" }))

    expect(meApi.setTokenSpaces).toHaveBeenCalledWith(7, [1])
    expect(meApi.createToken).not.toHaveBeenCalled()
    expect(meApi.tokens).toHaveBeenCalledTimes(2)
  })

  it("吊销要二次确认，确认后重拉列表并提示", async () => {
    vi.mocked(meApi.tokens)
      .mockResolvedValueOnce({ tokens: [READ_TOKEN, WRITE_TOKEN] })
      .mockResolvedValue({ tokens: [WRITE_TOKEN] })
    const user = userEvent.setup()
    render(<ApiTokensCard />)

    await screen.findByText("只读 Token")
    await user.click(screen.getAllByRole("button", { name: "吊销" })[0])
    expect(await screen.findByText("吊销这个 Token？")).toBeInTheDocument()
    expect(meApi.revokeToken).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "吊销 Token" }))

    expect(meApi.revokeToken).toHaveBeenCalledWith(7)
    expect(meApi.tokens).toHaveBeenCalledTimes(2)
    expect(
      await screen.findByText("Token 已吊销，使用它的应用立即失效。")
    ).toBeInTheDocument()
  })

  it("吊销别的令牌不会清掉刚生成、还没保存的明文", async () => {
    vi.mocked(meApi.tokens)
      .mockResolvedValueOnce({ tokens: [READ_TOKEN] })
      .mockResolvedValue({ tokens: [READ_TOKEN] })
    const user = userEvent.setup()
    render(<ApiTokensCard />)

    await screen.findByText("只读 Token")
    await user.click(screen.getByRole("button", { name: "新建 Token" }))
    await user.click(screen.getByRole("button", { name: "创建" }))
    expect(await screen.findByText(TOKEN)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "吊销" }))
    await user.click(await screen.findByRole("button", { name: "吊销 Token" }))

    expect(meApi.revokeToken).toHaveBeenCalledWith(7)
    // 明文只出现一次：吊销另一条不能把它一起清掉
    expect(await screen.findByText(TOKEN)).toBeInTheDocument()
  })

  it("列表读取失败时给错误与重试，重试成功后正常渲染", async () => {
    vi.mocked(meApi.tokens)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ tokens: [READ_TOKEN] })
    const user = userEvent.setup()
    render(<ApiTokensCard />)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "网络异常，请稍后重试"
    )
    await user.click(screen.getByRole("button", { name: "重试" }))

    expect(await screen.findByText("只读 Token")).toBeInTheDocument()
  })
})
