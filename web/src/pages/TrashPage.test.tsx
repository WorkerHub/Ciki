import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import type { Me, Space, TrashNode } from "@/lib/api"
import { TrashPage } from "@/pages/TrashPage"
import { useAuthStore } from "@/stores/auth"
import { useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    pagesApi: { ...actual.pagesApi, trash: vi.fn() }
  }
})

const { pagesApi } = await import("@/lib/api")

const user: Me = {
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

const defaultSpace: Space = {
  id: 1,
  slug: "default",
  name: "默认空间",
  description: "",
  myRole: "editor",
  isDefault: true,
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z"
}

const teamSpace: Space = {
  ...defaultSpace,
  id: 2,
  slug: "pay-team",
  name: "支付团队",
  myRole: "editor",
  isDefault: false
}

function trashNode(id: number, title: string): TrashNode {
  return {
    id,
    parentId: null,
    title,
    deletedAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z"
  }
}

function renderTrash() {
  const router = createMemoryRouter(
    [
      { path: "/s/:slug/trash", element: <TrashPage /> },
      { path: "/", element: <div>首页占位</div> }
    ],
    { initialEntries: ["/s/default/trash"] }
  )
  render(<RouterProvider router={router} />)
  return router
}

describe("回收站页头的空间切换", () => {
  beforeEach(() => {
    useAuthStore.setState({ user, status: "ready", restricted: false })
    useSpacesStore.setState({
      spaces: [defaultSpace, teamSpace],
      status: "ready",
      error: null,
      currentId: 1
    })
    vi.mocked(pagesApi.trash).mockImplementation(async (spaceId) =>
      spaceId === teamSpace.id
        ? [trashNode(2, "支付接口规范")]
        : [trashNode(1, "旧版首页")]
    )
  })

  it("页头显示空间切换入口，并列出当前空间的回收项", async () => {
    renderTrash()

    expect(screen.getByRole("button", { name: "切换空间" })).toHaveTextContent(
      "默认空间"
    )
    expect(await screen.findByText("旧版首页")).toBeInTheDocument()
    expect(pagesApi.trash).toHaveBeenCalledWith(1)
  })

  it("切换空间后留在回收站，列表按新空间重拉", async () => {
    const click = userEvent.setup()
    const router = renderTrash()
    expect(await screen.findByText("旧版首页")).toBeInTheDocument()

    await click.click(screen.getByRole("button", { name: "切换空间" }))
    await click.click(await screen.findByRole("menuitem", { name: /支付团队/ }))

    expect(useSpacesStore.getState().currentId).toBe(2)
    // 不绕首页：还停在回收站
    expect(router.state.location.pathname).toBe("/s/pay-team/trash")
    expect(await screen.findByText("支付接口规范")).toBeInTheDocument()
    expect(screen.queryByText("旧版首页")).toBeNull()
    expect(pagesApi.trash).toHaveBeenLastCalledWith(2)
  })
})

/** 页头三段分句拆成独立元素拼出来，英文靠外边距留白：这里钉住三句各自成句。 */
describe("回收站英文界面", () => {
  beforeEach(async () => {
    useAuthStore.setState({ user, status: "ready", restricted: false })
    vi.mocked(pagesApi.trash).mockResolvedValue([trashNode(1, "Old home page")])
    await i18n.changeLanguage("en")
  })

  it("页头、删除时间行与只读提示按英文渲染", async () => {
    useSpacesStore.setState({
      spaces: [{ ...defaultSpace, name: "Default space", myRole: "viewer" }],
      status: "ready",
      error: null,
      currentId: 1
    })
    renderTrash()

    expect(await screen.findByText("Old home page")).toBeInTheDocument()
    expect(
      screen.getByText("Current space: Default space.")
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        /^Soft-deleted pages stay here together with their subpages/
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText("You are a read-only member and can only look.")
    ).toBeInTheDocument()
    expect(screen.getByText(/^Deleted .+ \(.+\)$/)).toBeInTheDocument()
    // 只读成员没有恢复与彻底删除入口
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull()
    expect(screen.queryByText(/[\u4e00-\u9fff]/)).toBeNull()
  })

  it("彻底删除确认框按英文渲染", async () => {
    useSpacesStore.setState({
      spaces: [{ ...defaultSpace, name: "Default space" }],
      status: "ready",
      error: null,
      currentId: 1
    })
    const click = userEvent.setup()
    renderTrash()

    await click.click(
      await screen.findByRole("button", { name: "Delete permanently" })
    )

    expect(
      await screen.findByText("Permanently delete “Old home page”?")
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "The page and its entire version history will be deleted for good. This cannot be undone."
      )
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    // 弹窗打开后 Radix 把页面其余部分标了 aria-hidden，只剩确认框里这一个
    expect(
      screen.getAllByRole("button", { name: "Delete permanently" })
    ).toHaveLength(1)
  })
})
