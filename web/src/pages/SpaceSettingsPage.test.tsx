import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  ApiError,
  type Me,
  type PageNode,
  type Space,
  type SpaceCandidate,
  type SpaceMember
} from "@/lib/api"
import { SpaceSettingsPage } from "@/pages/SpaceSettingsPage"
import { useAuthStore } from "@/stores/auth"
import { useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    spacesApi: {
      ...actual.spacesApi,
      get: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      members: vi.fn(),
      addMember: vi.fn(),
      updateMember: vi.fn(),
      removeMember: vi.fn(),
      candidates: vi.fn()
    },
    pagesApi: {
      ...actual.pagesApi,
      tree: vi.fn(),
      trash: vi.fn()
    }
  }
})

const { pagesApi, spacesApi } = await import("@/lib/api")

const memberUser: Me = {
  id: 1,
  username: "小明",
  avatarUrl: null,
  email: "u1@example.com",
  role: "user",
  approvalStatus: "approved",
  createdAt: "2026-11-08T00:00:00.000Z",
  twofa: {
    totpEnabled: false,
    passkeyEnabled: false,
    passkeyCount: 0,
    emailOtpEnabled: false
  }
}

const space: Space = {
  id: 1,
  slug: "pay-team",
  name: "支付团队",
  description: "支付相关文档",
  myRole: "admin",
  isDefault: false,
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z"
}

const members: SpaceMember[] = [
  {
    userId: 1,
    username: "小明",
    email: "u1@example.com",
    role: "admin",
    createdAt: "2026-11-08T00:00:00.000Z"
  },
  {
    userId: 2,
    username: "小红",
    email: "u2@example.com",
    role: "editor",
    createdAt: "2026-11-08T00:00:00.000Z"
  }
]

function page(id: number, children: PageNode[] = []): PageNode {
  return {
    id,
    parentId: null,
    title: `页面 ${id}`,
    sortOrder: 0,
    updatedAt: "2026-11-08T00:00:00.000Z",
    children
  }
}

function renderSettings() {
  const router = createMemoryRouter(
    [
      { path: "/s/:slug/settings", element: <SpaceSettingsPage /> },
      { path: "/", element: <div>首页占位</div> }
    ],
    { initialEntries: ["/s/pay-team/settings"] }
  )
  return render(<RouterProvider router={router} />)
}

describe("空间设置与成员管理", () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: memberUser,
      status: "ready",
      restricted: false
    })
    useSpacesStore.setState({
      spaces: [space],
      status: "ready",
      error: null,
      currentId: 1
    })
    vi.mocked(spacesApi.get).mockResolvedValue(space)
    vi.mocked(spacesApi.members).mockResolvedValue(members)
    vi.mocked(spacesApi.update).mockReset()
    vi.mocked(spacesApi.remove).mockReset()
    vi.mocked(spacesApi.updateMember).mockReset()
    vi.mocked(spacesApi.removeMember).mockReset()
    vi.mocked(spacesApi.addMember).mockReset()
    vi.mocked(spacesApi.candidates).mockReset()
    vi.mocked(pagesApi.tree).mockResolvedValue([])
    vi.mocked(pagesApi.trash).mockResolvedValue([])
  })

  it("保存名称与描述后同步到空间列表", async () => {
    const user = userEvent.setup()
    vi.mocked(spacesApi.update).mockResolvedValue({
      ...space,
      name: "支付中台",
      description: "新的描述"
    })
    renderSettings()

    const nameInput = await screen.findByLabelText("名称")
    expect(nameInput).toHaveValue("支付团队")
    await user.clear(nameInput)
    await user.type(nameInput, "支付中台")
    await user.clear(screen.getByLabelText("描述"))
    await user.type(screen.getByLabelText("描述"), "新的描述")
    await user.click(screen.getByRole("button", { name: "保存" }))

    expect(spacesApi.update).toHaveBeenCalledWith(1, {
      name: "支付中台",
      description: "新的描述"
    })
    expect(await screen.findByRole("status")).toHaveTextContent(
      "切换器里的名称同步更新"
    )
    expect(useSpacesStore.getState().spaces[0].name).toBe("支付中台")
  })

  it("成员列表显示角色与最后一名管理员保护", async () => {
    renderSettings()

    expect(await screen.findByText("小红")).toBeInTheDocument()
    // 小明是唯一管理员：角色不可改、不可移除
    const adminRow = screen.getByText("小明").closest("tr") as HTMLElement
    expect(within(adminRow).getByText("最后一名管理员")).toBeInTheDocument()
    expect(
      within(adminRow).getByRole("button", { name: "移除" })
    ).toBeDisabled()
  })

  it("改成员角色调用 members 接口并刷新列表", async () => {
    const user = userEvent.setup()
    vi.mocked(spacesApi.updateMember).mockResolvedValue({
      ...members[1],
      role: "admin"
    })
    renderSettings()

    const row = (await screen.findByText("小红")).closest("tr") as HTMLElement
    await user.click(within(row).getByRole("combobox"))
    await user.click(await screen.findByRole("option", { name: "管理员" }))

    expect(spacesApi.updateMember).toHaveBeenCalledWith(1, 2, "admin")
  })

  it("移除成员要过一次确认", async () => {
    const user = userEvent.setup()
    vi.mocked(spacesApi.removeMember).mockResolvedValue({ success: true })
    renderSettings()

    const row = (await screen.findByText("小红")).closest("tr") as HTMLElement
    await user.click(within(row).getByRole("button", { name: "移除" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "移除成员" }))

    expect(spacesApi.removeMember).toHaveBeenCalledWith(1, 2)
  })

  it("搜索候选用户并按所选角色加入空间", async () => {
    const user = userEvent.setup()
    const candidate: SpaceCandidate = {
      userId: 3,
      username: "小刚",
      email: "u3@example.com"
    }
    vi.mocked(spacesApi.candidates).mockResolvedValue([candidate])
    vi.mocked(spacesApi.addMember).mockResolvedValue({
      ...members[1],
      userId: 3,
      username: "小刚",
      email: "u3@example.com",
      role: "editor"
    })
    renderSettings()

    await user.type(await screen.findByLabelText("添加成员"), "小刚")
    await user.click(screen.getByRole("button", { name: "搜索" }))

    expect(spacesApi.candidates).toHaveBeenCalledWith(1, "小刚")
    await user.click(await screen.findByRole("button", { name: "添加" }))

    expect(spacesApi.addMember).toHaveBeenCalledWith(1, {
      userId: 3,
      role: "editor"
    })
  })

  it("默认空间不能删除", async () => {
    vi.mocked(spacesApi.get).mockResolvedValue({ ...space, isDefault: true })
    renderSettings()

    expect(await screen.findByText("默认空间不能删除。")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "删除空间" })).toBeDisabled()
  })

  it("空间里还有页面（含回收站）时禁用删除并引导迁移", async () => {
    vi.mocked(pagesApi.tree).mockResolvedValue([page(1, [page(2)])])
    vi.mocked(pagesApi.trash).mockResolvedValue([
      {
        id: 9,
        parentId: null,
        title: "回收站页面",
        deletedAt: "2026-11-08T00:00:00.000Z",
        updatedAt: "2026-11-08T00:00:00.000Z"
      }
    ])
    renderSettings()

    expect(
      await screen.findByText(/空间里还有 2 个页面，回收站里另有 1 个/)
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "删除空间" })).toBeDisabled()
  })

  it("空空间可以删除，成功后回首页", async () => {
    const user = userEvent.setup()
    vi.mocked(spacesApi.remove).mockResolvedValue({ success: true })
    renderSettings()

    const dangerButton = await screen.findByRole("button", { name: "删除空间" })
    await waitFor(() => expect(dangerButton).toBeEnabled())
    await user.click(dangerButton)

    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "删除空间" }))

    expect(spacesApi.remove).toHaveBeenCalledWith(1)
    expect(await screen.findByText("首页占位")).toBeInTheDocument()
  })

  it("页面统计失败时收紧删除入口，不提示可以删除", async () => {
    vi.mocked(pagesApi.tree).mockRejectedValue(new ApiError(500, "boom"))
    renderSettings()

    expect(
      await screen.findByText("页面统计失败，暂时无法删除空间；请刷新重试。")
    ).toBeInTheDocument()
    expect(screen.queryByText("空间里没有页面，可以删除。")).toBeNull()
    expect(screen.getByRole("button", { name: "删除空间" })).toBeDisabled()
  })

  it("移除成员失败时在确认弹窗里显示错误", async () => {
    const user = userEvent.setup()
    vi.mocked(spacesApi.removeMember).mockRejectedValue(
      new ApiError(409, "Last space admin", "LAST_SPACE_ADMIN")
    )
    renderSettings()

    const row = (await screen.findByText("小红")).closest("tr") as HTMLElement
    await user.click(within(row).getByRole("button", { name: "移除" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "移除成员" }))

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "空间至少需要保留一名管理员。"
    )
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()
  })

  it("editor 打开直链只看到无权空状态", async () => {
    vi.mocked(spacesApi.get).mockResolvedValue({ ...space, myRole: "editor" })
    renderSettings()

    expect(
      await screen.findByText("仅空间管理员可以打开空间设置")
    ).toBeInTheDocument()
  })
})
