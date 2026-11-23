import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AgentAccountsCard } from "@/components/AgentAccountsCard"
import type { AgentAccount, ApiTokenSummary, Space } from "@/lib/api"
import { useAuthStore } from "@/stores/auth"
import { useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    meApi: {
      ...actual.meApi,
      agents: {
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        uploadAvatar: vi.fn(),
        deleteAvatar: vi.fn(),
        tokens: vi.fn(),
        issueToken: vi.fn(),
        revokeToken: vi.fn(),
        spaces: vi.fn(),
        setSpaces: vi.fn(),
        removeSpace: vi.fn()
      }
    }
  }
})

const { meApi } = await import("@/lib/api")

const AGENT_1: AgentAccount = {
  id: 101,
  username: "ci-agent",
  avatarUrl: null,
  isActive: true,
  createdAt: "2026-11-20T10:00:00.000Z"
}

const AGENT_2: AgentAccount = {
  id: 102,
  username: "bot-disabled",
  avatarUrl: null,
  isActive: false,
  createdAt: "2026-11-21T11:00:00.000Z"
}

const TOKEN_1: ApiTokenSummary = {
  id: 201,
  name: "Agent 只读 Token",
  kind: "read",
  spaceIds: null,
  createdAt: "2026-11-22T01:00:00.000Z",
  lastUsedAt: null
}

const TOKEN_2: ApiTokenSummary = {
  id: 202,
  name: "Agent 写入 Token",
  kind: "write",
  spaceIds: [1],
  createdAt: "2026-11-22T02:00:00.000Z",
  lastUsedAt: "2026-11-22T03:00:00.000Z"
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
  }
]

beforeEach(() => {
  useAuthStore.setState({
    user: {
      id: 1,
      username: "{{PERSON_8q0r1s2t}}",
      email: "{{EMAIL_8q0r1s2t}}@example.com",
      role: "admin",
      approvalStatus: "approved",
      twofa: {
        totpEnabled: false,
        passkeyEnabled: false,
        passkeyCount: 0,
        emailOtpEnabled: false
      },
      avatarUrl: null,
      createdAt: "2026-11-01T00:00:00.000Z"
    }
  })
  useSpacesStore.setState({ spaces: SPACES, status: "ready", currentId: 1 })
  vi.mocked(meApi.agents.list).mockResolvedValue([AGENT_1, AGENT_2])
  vi.mocked(meApi.agents.create).mockResolvedValue({
    id: 103,
    username: "new-bot",
    avatarUrl: null,
    isActive: true,
    createdAt: "2026-11-22T12:00:00.000Z"
  })
  vi.mocked(meApi.agents.update).mockResolvedValue({
    ...AGENT_1,
    isActive: false
  })
  vi.mocked(meApi.agents.delete).mockResolvedValue({ success: true })
  vi.mocked(meApi.agents.uploadAvatar).mockResolvedValue({
    ...AGENT_1,
    avatarUrl: "/api/files/avatars/new-avatar.png"
  })
  vi.mocked(meApi.agents.deleteAvatar).mockResolvedValue({
    ...AGENT_1,
    avatarUrl: null
  })
  vi.mocked(meApi.agents.tokens).mockResolvedValue({
    tokens: [TOKEN_1, TOKEN_2]
  })
  vi.mocked(meApi.agents.issueToken).mockResolvedValue({
    id: 203,
    name: "新令牌",
    kind: "read",
    spaceIds: null,
    token: "ciki_agent_token_plaintext"
  })
  vi.mocked(meApi.agents.revokeToken).mockResolvedValue({ success: true })
  vi.mocked(meApi.agents.spaces).mockResolvedValue([
    { spaceId: 1, slug: "space-1", name: "默认空间", role: "admin" },
    { spaceId: 2, slug: "space-2", name: "研发空间", role: null }
  ])
  vi.mocked(meApi.agents.setSpaces).mockResolvedValue({
    results: [
      { spaceId: 1, ok: true, role: "editor" },
      {
        spaceId: 2,
        ok: false,
        error: "A space must keep at least one admin",
        code: "LAST_SPACE_ADMIN"
      }
    ]
  })
  vi.mocked(meApi.agents.removeSpace).mockResolvedValue({ success: true })
})

describe("AgentAccountsCard", () => {
  it("渲染 Agent 账号列表与状态", async () => {
    render(<AgentAccountsCard />)

    expect(await screen.findByText("ci-agent")).toBeInTheDocument()
    expect(screen.getByText("bot-disabled")).toBeInTheDocument()
    expect(screen.getAllByRole("switch")).toHaveLength(2)
    expect(screen.getAllByRole("switch")[0]).toBeChecked()
    expect(screen.getAllByRole("switch")[1]).not.toBeChecked()
  })

  it("无 Agent 账号时展示空态提示", async () => {
    vi.mocked(meApi.agents.list).mockResolvedValue([])
    render(<AgentAccountsCard />)

    expect(await screen.findByText("还没有 Agent 账号")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "新建 Agent" })).toBeEnabled()
  })

  it("创建新 Agent 账号流程", async () => {
    const user = userEvent.setup()
    render(<AgentAccountsCard />)

    await screen.findByText("ci-agent")
    await user.click(screen.getByRole("button", { name: "新建 Agent" }))

    const input = screen.getByLabelText("用户名")
    await user.type(input, "new-bot")
    await user.click(screen.getByRole("button", { name: "创建" }))

    expect(meApi.agents.create).toHaveBeenCalledWith({ username: "new-bot" })
    await waitFor(() => {
      expect(screen.getByText(/Agent 账号已创建/)).toBeInTheDocument()
    })
  })

  it("启停 Agent 账号切换 Switch", async () => {
    const user = userEvent.setup()
    render(<AgentAccountsCard />)

    await screen.findByText("ci-agent")
    const switches = screen.getAllByRole("switch")
    await user.click(switches[0])

    expect(meApi.agents.update).toHaveBeenCalledWith(101, { isActive: false })
  })

  it("删除 Agent 账号流程", async () => {
    const user = userEvent.setup()
    render(<AgentAccountsCard />)

    await screen.findByText("ci-agent")
    const deleteButtons = screen.getAllByRole("button", { name: "删除" })
    await user.click(deleteButtons[0])

    expect(await screen.findByText("删除 Agent 账号？")).toBeInTheDocument()
    await user.click(await screen.findByRole("button", { name: "删除账号" }))

    expect(meApi.agents.delete).toHaveBeenCalledWith(101)
    await waitFor(() => {
      expect(screen.getByText(/Agent 账号已删除/)).toBeInTheDocument()
    })
  })

  it("展开代管令牌列表并签发新令牌，明文仅展示一次", async () => {
    const user = userEvent.setup()
    render(<AgentAccountsCard />)

    await screen.findByText("ci-agent")
    const manageButtons = screen.getAllByRole("button", { name: "管理 Token" })
    await user.click(manageButtons[0])

    expect(meApi.agents.tokens).toHaveBeenCalledWith(101)
    expect(await screen.findByText("Agent 只读 Token")).toBeInTheDocument()
    expect(screen.getByText("Agent 写入 Token")).toBeInTheDocument()

    // 点击代管签发令牌
    await user.click(screen.getByRole("button", { name: "签发 Token" }))
    const tokenNameInput = screen.getByLabelText("名称")
    await user.type(tokenNameInput, "新令牌")
    await user.click(screen.getByRole("button", { name: "签发" }))

    expect(meApi.agents.issueToken).toHaveBeenCalledWith(101, {
      kind: "read",
      name: "新令牌",
      spaceIds: null
    })

    expect(
      await screen.findByText("ciki_agent_token_plaintext")
    ).toBeInTheDocument()

    // 关闭明文
    await user.click(screen.getByRole("button", { name: "我已保存" }))
    expect(screen.queryByText("ciki_agent_token_plaintext")).toBeNull()
  })

  it("吊销代管令牌流程", async () => {
    const user = userEvent.setup()
    render(<AgentAccountsCard />)

    await screen.findByText("ci-agent")
    const manageButtons = screen.getAllByRole("button", { name: "管理 Token" })
    await user.click(manageButtons[0])

    expect(await screen.findByText("Agent 只读 Token")).toBeInTheDocument()

    const revokeButtons = screen.getAllByRole("button", { name: "吊销" })
    await user.click(revokeButtons[0])

    expect(await screen.findByText("吊销这个 Token？")).toBeInTheDocument()
    await user.click(await screen.findByRole("button", { name: "吊销 Token" }))

    expect(meApi.agents.revokeToken).toHaveBeenCalledWith(101, 201)
    await waitFor(() => {
      expect(screen.getByText(/Token 已吊销/)).toBeInTheDocument()
    })
  })

  it("指定空间一个没勾时不能签发令牌（契约里空数组整个 400）", async () => {
    const user = userEvent.setup()
    render(<AgentAccountsCard />)

    await screen.findByText("ci-agent")
    const manageButtons = screen.getAllByRole("button", { name: "管理 Token" })
    await user.click(manageButtons[0])

    await user.click(screen.getByRole("button", { name: "签发 Token" }))
    await user.click(screen.getByRole("radio", { name: "指定空间" }))

    expect(screen.getByRole("button", { name: "签发" })).toBeDisabled()
    await user.click(screen.getByRole("checkbox", { name: "默认空间" }))
    expect(screen.getByRole("button", { name: "签发" })).toBeEnabled()
  })

  it("Agent 头像上传与删除流程", async () => {
    const user = userEvent.setup()
    render(<AgentAccountsCard />)

    await screen.findByText("ci-agent")

    // 1. 上传头像
    const fileInput = screen.getByLabelText("为 ci-agent 选择头像")
    const file = new File(["fake-image"], "avatar.png", { type: "image/png" })
    await user.upload(fileInput, file)

    expect(meApi.agents.uploadAvatar).toHaveBeenCalledWith(101, file)
    await waitFor(() => {
      expect(screen.getByText(/Agent 头像已更新/)).toBeInTheDocument()
    })

    // 2. 更换与删除按钮可见
    const deleteAvatarBtn = await screen.findByRole("button", {
      name: "删除头像"
    })
    await user.click(deleteAvatarBtn)

    expect(meApi.agents.deleteAvatar).toHaveBeenCalledWith(101)
    await waitFor(() => {
      expect(screen.getByText(/Agent 头像已删除/)).toBeInTheDocument()
    })
  })

  it("空间权限管理弹窗：多选批量授权并明确点名部分失败", async () => {
    const user = userEvent.setup()
    render(<AgentAccountsCard />)

    await screen.findByText("ci-agent")
    const manageSpacesBtns = screen.getAllByRole("button", {
      name: "管理空间"
    })
    await user.click(manageSpacesBtns[0])

    expect(meApi.agents.spaces).toHaveBeenCalledWith(101)
    expect(
      await screen.findByText("管理 Agent「ci-agent」的空间权限")
    ).toBeInTheDocument()
    expect(screen.getByText("默认空间")).toBeInTheDocument()
    expect(screen.getByText("研发空间")).toBeInTheDocument()
    expect(screen.getByText("未加入")).toBeInTheDocument()

    // 勾选研发空间进行批量设置
    await user.click(screen.getByLabelText("Select 研发空间"))
    expect(screen.getByText("已选 1 个空间")).toBeInTheDocument()

    const applyBtn = screen.getByRole("button", { name: "批量设置角色" })
    await user.click(applyBtn)

    expect(meApi.agents.setSpaces).toHaveBeenCalledWith(101, {
      spaceIds: [2],
      role: "editor"
    })

    // 部分失败明确点名
    expect(await screen.findByText("部分空间操作失败：")).toBeInTheDocument()
    expect(
      screen.getByText(/研发空间：空间必须保留至少一名管理员/)
    ).toBeInTheDocument()
  })

  it("空间权限管理弹窗：单个移出空间", async () => {
    const user = userEvent.setup()
    render(<AgentAccountsCard />)

    await screen.findByText("ci-agent")
    const manageSpacesBtns = screen.getAllByRole("button", {
      name: "管理空间"
    })
    await user.click(manageSpacesBtns[0])

    await screen.findByText("管理 Agent「ci-agent」的空间权限")
    const removeBtn = screen.getByRole("button", { name: "移出" })
    await user.click(removeBtn)

    expect(meApi.agents.removeSpace).toHaveBeenCalledWith(101, 1)
    await waitFor(() => {
      expect(
        screen.getByText("已将 Agent 移出空间「默认空间」。")
      ).toBeInTheDocument()
    })
  })

  it("签发代管 Token 后复制接入提示词包含 Agent 与 Owner 身份声明且不泄露明文", async () => {
    const user = userEvent.setup()
    const writeSpy = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined)
    render(<AgentAccountsCard />)

    await screen.findByText("ci-agent")
    const manageButtons = screen.getAllByRole("button", { name: "管理 Token" })
    await user.click(manageButtons[0])

    // 1. 点击签发 Token
    await user.click(screen.getByRole("button", { name: "签发 Token" }))
    await user.click(screen.getByRole("button", { name: "签发" }))

    expect(
      await screen.findByText("ciki_agent_token_plaintext")
    ).toBeInTheDocument()

    const copyPromptBtns = screen.getAllByRole("button", {
      name: "复制接入提示词"
    })
    await user.click(copyPromptBtns[0])

    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("{{CIKI_API_TOKEN}}")
    )
    const promptText = writeSpy.mock.calls[0][0] as string
    expect(promptText).toContain(
      "- 身份声明：以 Agent「ci-agent」的身份工作，所属 Owner 为「{{PERSON_8q0r1s2t}}」。"
    )
    expect(promptText).not.toContain("ciki_agent_token_plaintext")

    // 测试已存在 Token 列表中单行的复制提示词按钮
    await user.click(copyPromptBtns[1])
    expect(writeSpy).toHaveBeenCalledTimes(2)
  })
})
