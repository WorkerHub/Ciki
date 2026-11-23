import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UserSpacesDialog } from "@/components/UserSpacesDialog"
import { ApiError, type AdminUser, adminApi } from "@/lib/api"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      userSpaces: vi.fn(),
      setUserSpaces: vi.fn(),
      removeUserSpace: vi.fn()
    }
  }
})

const MOCK_USER: AdminUser = {
  id: 42,
  email: "alice@example.com",
  role: "user",
  isActive: true,
  approvalStatus: "approved",
  createdAt: "2026-11-20T10:00:00.000Z",
  isAgent: false
}

describe("UserSpacesDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("关闭状态或无 user 时不渲染内容", () => {
    const { container } = render(
      <UserSpacesDialog user={MOCK_USER} open={false} onOpenChange={vi.fn()} />
    )
    expect(container.firstChild).toBeNull()

    const { container: container2 } = render(
      <UserSpacesDialog user={null} open={true} onOpenChange={vi.fn()} />
    )
    expect(container2.firstChild).toBeNull()
  })

  it("空间列表为空时的空态展示", async () => {
    vi.mocked(adminApi.userSpaces).mockResolvedValue([])

    render(
      <UserSpacesDialog user={MOCK_USER} open={true} onOpenChange={vi.fn()} />
    )

    expect(await screen.findByText("当前没有可用空间。")).toBeInTheDocument()
    expect(
      screen.getByText("管理用户「alice@example.com」的空间权限")
    ).toBeInTheDocument()
  })

  it("空间列表加载失败与重试", async () => {
    vi.mocked(adminApi.userSpaces).mockRejectedValueOnce(
      new Error("Network Error")
    )

    render(
      <UserSpacesDialog user={MOCK_USER} open={true} onOpenChange={vi.fn()} />
    )

    expect(await screen.findByText("网络异常，请稍后重试")).toBeInTheDocument()
    const retryBtn = screen.getByRole("button", { name: "重试" })

    vi.mocked(adminApi.userSpaces).mockResolvedValueOnce([
      { spaceId: 1, slug: "space-1", name: "空间1", role: "admin" }
    ])
    const user = userEvent.setup()
    await user.click(retryBtn)

    expect(await screen.findByText("空间1")).toBeInTheDocument()
  })

  it("全选与反选功能", async () => {
    vi.mocked(adminApi.userSpaces).mockResolvedValue([
      { spaceId: 1, slug: "s-1", name: "空间1", role: "editor" },
      { spaceId: 2, slug: "s-2", name: "空间2", role: null }
    ])

    const user = userEvent.setup()
    render(
      <UserSpacesDialog user={MOCK_USER} open={true} onOpenChange={vi.fn()} />
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

  it("批量设置角色时展示全部错误码映射与逐项点名", async () => {
    vi.mocked(adminApi.userSpaces).mockResolvedValue([
      { spaceId: 1, slug: "s-1", name: "空间1", role: null },
      { spaceId: 2, slug: "s-2", name: "空间2", role: null },
      { spaceId: 3, slug: "s-3", name: "空间3", role: null },
      { spaceId: 4, slug: "s-4", name: "空间4", role: null }
    ])

    vi.mocked(adminApi.setUserSpaces).mockResolvedValue({
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
      <UserSpacesDialog user={MOCK_USER} open={true} onOpenChange={vi.fn()} />
    )

    await screen.findByText("空间1")
    await user.click(screen.getByLabelText("全选所有空间"))

    await user.click(screen.getByRole("button", { name: "批量设置角色" }))

    expect(adminApi.setUserSpaces).toHaveBeenCalledWith(42, {
      spaceIds: [1, 2, 3, 4],
      role: "editor"
    })

    expect(await screen.findByText("部分空间操作失败：")).toBeInTheDocument()
    expect(screen.getByText("空间1：无权操作该空间")).toBeInTheDocument()
    expect(screen.getByText("空间2：空间不存在")).toBeInTheDocument()
    expect(
      screen.getByText("空间3：用户账号处于禁用或未审批状态")
    ).toBeInTheDocument()
    expect(
      screen.getByText("空间4：空间必须保留至少一名管理员")
    ).toBeInTheDocument()
  })

  it("单个移出空间成功与遇到 LAST_SPACE_ADMIN 错误时友好提示", async () => {
    vi.mocked(adminApi.userSpaces).mockResolvedValue([
      { spaceId: 1, slug: "s-1", name: "空间1", role: "admin" },
      { spaceId: 2, slug: "s-2", name: "空间2", role: "editor" }
    ])
    vi.mocked(adminApi.removeUserSpace).mockRejectedValueOnce(
      new ApiError(400, "Cannot remove last admin", "LAST_SPACE_ADMIN")
    )

    const user = userEvent.setup()
    render(
      <UserSpacesDialog user={MOCK_USER} open={true} onOpenChange={vi.fn()} />
    )

    await screen.findByText("空间1")
    const removeButtons = screen.getAllByRole("button", { name: "移出" })
    await user.click(removeButtons[0])

    expect(adminApi.removeUserSpace).toHaveBeenCalledWith(42, 1)
    expect(
      await screen.findByText("空间必须保留至少一名管理员")
    ).toBeInTheDocument()

    // 第二次成功移出
    vi.mocked(adminApi.removeUserSpace).mockResolvedValueOnce({ success: true })
    await user.click(removeButtons[1])
    expect(adminApi.removeUserSpace).toHaveBeenCalledWith(42, 2)
    expect(
      await screen.findByText("已将用户移出空间「空间2」。")
    ).toBeInTheDocument()
  })

  it("父组件无关重渲染不再重触发 effect、不清空已勾选", async () => {
    vi.mocked(adminApi.userSpaces).mockResolvedValue([
      { spaceId: 1, slug: "s-1", name: "空间1", role: "editor" },
      { spaceId: 2, slug: "s-2", name: "空间2", role: null }
    ])

    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const { rerender } = render(
      <UserSpacesDialog
        user={MOCK_USER}
        open={true}
        onOpenChange={onOpenChange}
      />
    )

    expect(await screen.findByText("空间1")).toBeInTheDocument()
    expect(adminApi.userSpaces).toHaveBeenCalledTimes(1)

    const checkbox1 = screen.getByLabelText("选择空间 空间1")
    await user.click(checkbox1)
    expect(checkbox1).toBeChecked()
    expect(screen.getByText("已选 1 个空间")).toBeInTheDocument()

    rerender(
      <UserSpacesDialog
        user={{ ...MOCK_USER }}
        open={true}
        onOpenChange={vi.fn()}
      />
    )

    expect(adminApi.userSpaces).toHaveBeenCalledTimes(1)
    expect(checkbox1).toBeChecked()
    expect(screen.getByText("已选 1 个空间")).toBeInTheDocument()
  })
})
