import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import {
  ApiError,
  usersApi,
  type UserPagesResponse,
  type UserProfile
} from "@/lib/api"
import { UserPage } from "./UserPage"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    usersApi: {
      getProfile: vi.fn(),
      getPages: vi.fn()
    }
  }
})

const mockUser: UserProfile = {
  id: 1,
  username: "alice",
  avatarUrl: "/avatars/alice.png",
  isAgent: false,
  ownerName: null,
  createdAt: "2026-11-20T08:00:00.000Z"
}

const mockPages: UserPagesResponse = {
  pages: [
    {
      id: 101,
      title: "产品路线图",
      spaceName: "产品设计",
      createdAt: "2026-11-21T08:00:00.000Z",
      updatedAt: "2026-11-22T10:00:00.000Z"
    },
    {
      id: 102,
      title: "技术方案",
      spaceName: "研发团队",
      createdAt: "2026-11-21T09:00:00.000Z",
      updatedAt: "2026-11-23T11:00:00.000Z"
    }
  ],
  total: 2,
  page: 1,
  limit: 20,
  hasMore: false
}

function renderPage(userId = "1") {
  return render(
    <MemoryRouter initialEntries={[`/users/${userId}`]}>
      <Routes>
        <Route path="/users/:id" element={<UserPage />} />
      </Routes>
    </MemoryRouter>
  )
}

describe("UserPage 作者主页", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("正确渲染用户公开信息与页面列表", async () => {
    vi.mocked(usersApi.getProfile).mockResolvedValue(mockUser)
    vi.mocked(usersApi.getPages).mockResolvedValue(mockPages)

    renderPage("1")

    expect(
      await screen.findByRole("heading", { name: "alice" })
    ).toBeInTheDocument()
    expect(screen.getByText("加入于 2026-11-20")).toBeInTheDocument()

    expect(screen.getByText("产品路线图")).toBeInTheDocument()
    expect(screen.getByText("产品设计")).toBeInTheDocument()
    expect(screen.getByText("技术方案")).toBeInTheDocument()
    expect(screen.getByText("研发团队")).toBeInTheDocument()

    const link = screen.getByRole("link", { name: /产品路线图/ })
    expect(link).toHaveAttribute("href", "/p/101")
  })

  it("Agent 用户带归属人时正确展示归属人格式", async () => {
    vi.mocked(usersApi.getProfile).mockResolvedValue({
      ...mockUser,
      id: 2,
      username: "helper-bot",
      isAgent: true,
      ownerName: "alice"
    })
    vi.mocked(usersApi.getPages).mockResolvedValue({
      pages: [],
      total: 0,
      page: 1,
      limit: 20,
      hasMore: false
    })

    renderPage("2")

    expect(
      await screen.findByRole("heading", {
        name: "helper-bot（alice 的 Agent）"
      })
    ).toBeInTheDocument()
  })

  it("Agent 用户无归属人时展示 Agent 徽标", async () => {
    vi.mocked(usersApi.getProfile).mockResolvedValue({
      ...mockUser,
      id: 3,
      username: "orphan-bot",
      isAgent: true,
      ownerName: null
    })
    vi.mocked(usersApi.getPages).mockResolvedValue({
      pages: [],
      total: 0,
      page: 1,
      limit: 20,
      hasMore: false
    })

    renderPage("3")

    expect(
      await screen.findByRole("heading", { name: "orphan-bot" })
    ).toBeInTheDocument()
    expect(screen.getByText("Agent")).toBeInTheDocument()
  })

  it("页面列表为空时展示空态", async () => {
    vi.mocked(usersApi.getProfile).mockResolvedValue(mockUser)
    vi.mocked(usersApi.getPages).mockResolvedValue({
      pages: [],
      total: 0,
      page: 1,
      limit: 20,
      hasMore: false
    })

    renderPage("1")

    expect(await screen.findByText("暂无公开文档")).toBeInTheDocument()
    expect(
      screen.getByText("该作者尚未创建任何你有权查看的文档。")
    ).toBeInTheDocument()
  })

  it("用户不存在（404）时展示用户不存在空态及回首页按钮", async () => {
    vi.mocked(usersApi.getProfile).mockRejectedValue(
      new ApiError(404, "User not found")
    )
    vi.mocked(usersApi.getPages).mockResolvedValue({
      pages: [],
      total: 0,
      page: 1,
      limit: 20,
      hasMore: false
    })

    renderPage("999")

    expect(await screen.findByText("用户不存在")).toBeInTheDocument()
    expect(
      screen.getByText("该用户可能已被删除，或链接地址有误。")
    ).toBeInTheDocument()
    const homeLink = screen.getByRole("link", { name: "回到首页" })
    expect(homeLink).toHaveAttribute("href", "/")
  })

  it("非法用户 id 路径直接展示 404 空态", async () => {
    renderPage("not-a-number")

    expect(await screen.findByText("用户不存在")).toBeInTheDocument()
    expect(usersApi.getProfile).not.toHaveBeenCalled()
  })

  it("支持点击「加载更多」按钮分页拉取下一页文档", async () => {
    const user = userEvent.setup()
    vi.mocked(usersApi.getProfile).mockResolvedValue(mockUser)
    vi.mocked(usersApi.getPages)
      .mockResolvedValueOnce({
        pages: [
          {
            id: 101,
            title: "第一页文档",
            spaceName: "空间A",
            createdAt: "2026-11-20T00:00:00.000Z",
            updatedAt: "2026-11-21T00:00:00.000Z"
          }
        ],
        total: 2,
        page: 1,
        limit: 20,
        hasMore: true
      })
      .mockResolvedValueOnce({
        pages: [
          {
            id: 102,
            title: "第二页文档",
            spaceName: "空间B",
            createdAt: "2026-11-19T00:00:00.000Z",
            updatedAt: "2026-11-20T00:00:00.000Z"
          }
        ],
        total: 2,
        page: 2,
        limit: 20,
        hasMore: false
      })

    renderPage("1")

    expect(await screen.findByText("第一页文档")).toBeInTheDocument()
    const loadMoreButton = screen.getByRole("button", { name: "加载更多" })
    expect(loadMoreButton).toBeInTheDocument()

    await user.click(loadMoreButton)

    expect(await screen.findByText("第二页文档")).toBeInTheDocument()
    expect(screen.getByText("第一页文档")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull()
  })

  it("网络或服务器异常时展示错误信息与重试按钮", async () => {
    const user = userEvent.setup()
    vi.mocked(usersApi.getProfile)
      .mockRejectedValueOnce(new Error("网络故障"))
      .mockResolvedValueOnce(mockUser)
    vi.mocked(usersApi.getPages).mockResolvedValue(mockPages)

    renderPage("1")

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    const retryBtn = screen.getByRole("button", { name: "重试" })
    await user.click(retryBtn)

    expect(
      await screen.findByRole("heading", { name: "alice" })
    ).toBeInTheDocument()
  })

  it("英文环境下展示正确的双语翻译", async () => {
    await i18n.changeLanguage("en")
    vi.mocked(usersApi.getProfile).mockResolvedValue(mockUser)
    vi.mocked(usersApi.getPages).mockResolvedValue({
      pages: [],
      total: 0,
      page: 1,
      limit: 20,
      hasMore: false
    })

    renderPage("1")

    expect(
      await screen.findByRole("heading", { name: "alice" })
    ).toBeInTheDocument()
    expect(screen.getByText("Joined 11/20/2026")).toBeInTheDocument()
    expect(screen.getByText("Pages")).toBeInTheDocument()
    expect(screen.getByText("No pages yet")).toBeInTheDocument()
  })
})
