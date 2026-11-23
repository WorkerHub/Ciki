import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AgentSpacesDialog } from "@/components/AgentSpacesDialog"
import { ApiError, type AgentAccount, meApi } from "@/lib/api"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    meApi: {
      ...actual.meApi,
      agents: {
        spaces: vi.fn(),
        setSpaces: vi.fn(),
        removeSpace: vi.fn()
      }
    }
  }
})

const MOCK_AGENT: AgentAccount = {
  id: 101,
  username: "test-agent",
  avatarUrl: null,
  isActive: true,
  createdAt: "2026-11-20T10:00:00.000Z"
}

describe("AgentSpacesDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("关闭状态或无 agent 时不渲染内容", () => {
    const { container } = render(
      <AgentSpacesDialog
        agent={MOCK_AGENT}
        open={false}
        onOpenChange={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()

    const { container: container2 } = render(
      <AgentSpacesDialog agent={null} open={true} onOpenChange={vi.fn()} />
    )
    expect(container2.firstChild).toBeNull()
  })

  it("空间列表为空时的空态展示", async () => {
    vi.mocked(meApi.agents.spaces).mockResolvedValue([])

    render(
      <AgentSpacesDialog
        agent={MOCK_AGENT}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    expect(
      await screen.findByText("你当前没有可管理的空间。")
    ).toBeInTheDocument()
  })

  it("空间列表加载失败与重试", async () => {
    vi.mocked(meApi.agents.spaces).mockRejectedValueOnce(
      new Error("Network Error")
    )

    render(
      <AgentSpacesDialog
        agent={MOCK_AGENT}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    expect(await screen.findByText("网络异常，请稍后重试")).toBeInTheDocument()
    const retryBtn = screen.getByRole("button", { name: "重试" })

    vi.mocked(meApi.agents.spaces).mockResolvedValueOnce([
      { spaceId: 1, slug: "space-1", name: "空间1", role: "admin" }
    ])
    const user = userEvent.setup()
    await user.click(retryBtn)

    expect(await screen.findByText("空间1")).toBeInTheDocument()
  })

  it("全选与反选功能", async () => {
    vi.mocked(meApi.agents.spaces).mockResolvedValue([
      { spaceId: 1, slug: "s-1", name: "空间1", role: "editor" },
      { spaceId: 2, slug: "s-2", name: "空间2", role: null }
    ])

    const user = userEvent.setup()
    render(
      <AgentSpacesDialog
        agent={MOCK_AGENT}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    expect(await screen.findByText("空间1")).toBeInTheDocument()
    const selectAllCheckbox = screen.getByLabelText("全选所有空间")
    expect(selectAllCheckbox).not.toBeChecked()

    await user.click(selectAllCheckbox)
    expect(screen.getByText("已选 2 个空间")).toBeInTheDocument()
    expect(selectAllCheckbox).toBeChecked()

    await user.click(selectAllCheckbox)
    expect(screen.getByText("已选 0 个空间")).toBeInTheDocument()
    expect(selectAllCheckbox).not.toBeChecked()
  })

  it("批量设置角色时展示全部错误码映射", async () => {
    vi.mocked(meApi.agents.spaces).mockResolvedValue([
      { spaceId: 1, slug: "s-1", name: "空间1", role: null },
      { spaceId: 2, slug: "s-2", name: "空间2", role: null },
      { spaceId: 3, slug: "s-3", name: "空间3", role: null },
      { spaceId: 4, slug: "s-4", name: "空间4", role: null }
    ])

    vi.mocked(meApi.agents.setSpaces).mockResolvedValue({
      results: [
        {
          spaceId: 1,
          ok: false,
          error: "forbidden",
          code: "SPACE_FORBIDDEN"
        },
        {
          spaceId: 2,
          ok: false,
          error: "not found",
          code: "SPACE_NOT_FOUND"
        },
        {
          spaceId: 3,
          ok: false,
          error: "not eligible",
          code: "USER_NOT_ELIGIBLE"
        },
        {
          spaceId: 4,
          ok: false,
          error: "last admin",
          code: "LAST_SPACE_ADMIN"
        }
      ]
    })

    const user = userEvent.setup()
    render(
      <AgentSpacesDialog
        agent={MOCK_AGENT}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    await screen.findByText("空间1")
    await user.click(screen.getByLabelText("全选所有空间"))

    await user.click(screen.getByRole("button", { name: "批量设置角色" }))

    expect(await screen.findByText("部分空间操作失败：")).toBeInTheDocument()
    expect(screen.getByText("空间1：无权操作该空间")).toBeInTheDocument()
    expect(screen.getByText("空间2：空间不存在")).toBeInTheDocument()
    expect(
      screen.getByText("空间3：Agent 账号处于禁用或未审批状态")
    ).toBeInTheDocument()
    expect(
      screen.getByText("空间4：空间必须保留至少一名管理员")
    ).toBeInTheDocument()
  })

  it("单个移出空间遇到 LAST_SPACE_ADMIN 错误时友好提示", async () => {
    vi.mocked(meApi.agents.spaces).mockResolvedValue([
      { spaceId: 1, slug: "s-1", name: "空间1", role: "admin" }
    ])
    vi.mocked(meApi.agents.removeSpace).mockRejectedValueOnce(
      new ApiError(400, "Cannot remove last admin", "LAST_SPACE_ADMIN")
    )

    const user = userEvent.setup()
    render(
      <AgentSpacesDialog
        agent={MOCK_AGENT}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    await screen.findByText("空间1")
    await user.click(screen.getByRole("button", { name: "移出" }))

    expect(
      await screen.findByText("空间必须保留至少一名管理员")
    ).toBeInTheDocument()
  })
})
