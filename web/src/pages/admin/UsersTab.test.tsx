import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AdminUser } from "@/lib/api"
import { UsersTab } from "@/pages/admin/UsersTab"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      users: vi.fn(),
      userSpaces: vi.fn(),
      setUserSpaces: vi.fn(),
      removeUserSpace: vi.fn()
    }
  }
})

const { adminApi } = await import("@/lib/api")

const humanUser: AdminUser = {
  id: 10,
  email: "bob@example.com",
  role: "user",
  isActive: true,
  approvalStatus: "approved",
  createdAt: "2026-11-20T10:00:00.000Z",
  isAgent: false,
  kind: "human"
}

const agentUser: AdminUser = {
  id: 20,
  email: "ci-agent@internal",
  role: "user",
  isActive: true,
  approvalStatus: "approved",
  createdAt: "2026-11-20T10:00:00.000Z",
  isAgent: true,
  kind: "agent",
  ownerName: "bob"
}

describe("UsersTab · 用户批量空间授权入口", () => {
  beforeEach(() => {
    vi.mocked(adminApi.users).mockReset()
    vi.mocked(adminApi.userSpaces).mockReset()
    vi.mocked(adminApi.setUserSpaces).mockReset()
    vi.mocked(adminApi.removeUserSpace).mockReset()
  })

  it("真人用户行提供「空间授权」入口，Agent 行不开此入口", async () => {
    vi.mocked(adminApi.users).mockResolvedValue([humanUser, agentUser])
    const user = userEvent.setup()

    render(
      <MemoryRouter>
        <UsersTab />
      </MemoryRouter>
    )

    expect(await screen.findByText("bob@example.com")).toBeInTheDocument()
    expect(
      screen.getByText("ci-agent@internal（bob 的 Agent）")
    ).toBeInTheDocument()

    // 1. 打开真人用户的操作菜单
    const humanActionsBtn = screen.getByRole("button", {
      name: "bob@example.com 的操作"
    })
    await user.click(humanActionsBtn)

    // 真人用户菜单中应有「空间授权」
    const spaceAuthItem = await screen.findByRole("menuitem", {
      name: "空间授权"
    })
    expect(spaceAuthItem).toBeInTheDocument()

    // 关闭菜单
    await user.keyboard("{Escape}")

    // 2. 打开 Agent 用户的操作菜单
    const agentActionsBtn = screen.getByRole("button", {
      name: "ci-agent@internal 的操作"
    })
    await user.click(agentActionsBtn)

    // Agent 菜单中不应有「空间授权」
    expect(screen.queryByRole("menuitem", { name: "空间授权" })).toBeNull()
  })

  it("点击真人用户的「空间授权」唤起授权面板并加载空间列表", async () => {
    vi.mocked(adminApi.users).mockResolvedValue([humanUser])
    vi.mocked(adminApi.userSpaces).mockResolvedValue([
      { spaceId: 1, slug: "default", name: "默认空间", role: "admin" },
      { spaceId: 2, slug: "team", name: "团队空间", role: null }
    ])

    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <UsersTab />
      </MemoryRouter>
    )

    await screen.findByText("bob@example.com")
    await user.click(
      screen.getByRole("button", { name: "bob@example.com 的操作" })
    )

    const spaceAuthItem = await screen.findByRole("menuitem", {
      name: "空间授权"
    })
    await user.click(spaceAuthItem)

    // 弹窗出现并调用 adminApi.userSpaces
    expect(adminApi.userSpaces).toHaveBeenCalledWith(10)
    expect(
      await screen.findByText("管理用户「bob@example.com」的空间权限")
    ).toBeInTheDocument()
    expect(screen.getByText("默认空间")).toBeInTheDocument()
    expect(screen.getByText("团队空间")).toBeInTheDocument()
  })
})
