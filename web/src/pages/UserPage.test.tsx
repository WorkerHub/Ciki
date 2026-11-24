import { render, screen } from "@testing-library/react"
import { fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Link, MemoryRouter, Route, Routes } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import {
  ApiError,
  usersApi,
  type UserActivityResponse,
  type UserProfile
} from "@/lib/api"
import { UserPage } from "./UserPage"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    usersApi: {
      getProfile: vi.fn(),
      getActivity: vi.fn(),
      getPages: vi.fn()
    }
  }
})

const mockUser: UserProfile = {
  id: 1,
  username: "alice",
  avatarUrl: "/avatars/alice.png",
  bio: "专注系统架构与前端体验",
  docCount: 5,
  commentCount: 3,
  isAgent: false,
  ownerName: null,
  ownerId: null,
  createdAt: "2026-11-20T08:00:00.000Z"
}

const mockActivity: UserActivityResponse = {
  events: [
    {
      id: "revision-102",
      type: "page_edited",
      pageId: 102,
      pageTitle: "技术方案",
      spaceName: "研发团队",
      createdAt: "2026-11-23T11:00:00.000Z"
    },
    {
      id: "comment-201",
      type: "comment",
      pageId: 101,
      pageTitle: "产品路线图",
      spaceName: "产品设计",
      commentId: 201,
      excerpt: "这个里程碑排期很合理，赞同按此推进。",
      createdAt: "2026-11-22T09:00:00.000Z"
    },
    {
      id: "page-101",
      type: "page_created",
      pageId: 101,
      pageTitle: "产品路线图",
      spaceName: "产品设计",
      createdAt: "2026-11-21T08:00:00.000Z"
    }
  ],
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
  beforeEach(async () => {
    vi.clearAllMocks()
    await i18n.changeLanguage("zh")
  })

  it("正确渲染个人卡（头像、用户名、简介、加入时间、文档与评论数）与动态流三类事件", async () => {
    vi.mocked(usersApi.getProfile).mockResolvedValue(mockUser)
    vi.mocked(usersApi.getActivity).mockResolvedValue(mockActivity)

    renderPage("1")

    expect(usersApi.getActivity).toHaveBeenCalledWith(1, {
      page: 1,
      limit: 10
    })

    expect(
      await screen.findByRole("heading", { name: "alice" })
    ).toBeInTheDocument()
    expect(screen.getByText("专注系统架构与前端体验")).toBeInTheDocument()
    expect(screen.getByText("加入于 2026-11-20")).toBeInTheDocument()
    expect(screen.getByText("5")).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
    expect(screen.getByText("文档")).toBeInTheDocument()
    expect(screen.getByText("评论")).toBeInTheDocument()

    // 动态流标题
    expect(screen.getByText("动态")).toBeInTheDocument()

    // 三类事件
    expect(screen.getByText("编辑了文档")).toBeInTheDocument()
    expect(screen.getByText("技术方案")).toBeInTheDocument()
    expect(screen.getByText("研发团队")).toBeInTheDocument()

    expect(screen.getByText("发表了评论")).toBeInTheDocument()
    expect(
      screen.getByText("这个里程碑排期很合理，赞同按此推进。")
    ).toBeInTheDocument()

    expect(screen.getByText("新建了文档")).toBeInTheDocument()

    // 链接与评论定位
    const editLink = screen.getByRole("link", { name: /编辑了文档.*技术方案/ })
    expect(editLink).toHaveAttribute("href", "/p/102")

    const commentLink = screen.getByRole("link", {
      name: /发表了评论.*产品路线图/
    })
    expect(commentLink).toHaveAttribute("href", "/p/101#comment-201")

    const createLink = screen.getByRole("link", {
      name: /新建了文档.*产品路线图/
    })
    expect(createLink).toHaveAttribute("href", "/p/101")
  })

  it("Agent 用户展示纯用户名、Agent 徽标与归属人浮层链接", async () => {
    const user = userEvent.setup()
    vi.mocked(usersApi.getProfile).mockResolvedValue({
      ...mockUser,
      id: 2,
      username: "helper-bot",
      bio: "",
      isAgent: true,
      ownerName: "alice",
      ownerId: 10
    })
    vi.mocked(usersApi.getActivity).mockResolvedValue({
      events: [],
      hasMore: false
    })

    renderPage("2")

    expect(
      await screen.findByRole("heading", { name: "helper-bot" })
    ).toBeInTheDocument()
    expect(screen.getByText("Agent")).toBeInTheDocument()

    // 点击唤出浮层（移动端点按或点击），展示归属人链接与「 的 Agent」
    const trigger = screen.getByRole("button", { name: /helper-bot.*Agent/ })
    await user.click(trigger)

    const ownerLink = await screen.findByRole("link", { name: "alice" })
    expect(ownerLink).toBeInTheDocument()
    expect(ownerLink).toHaveAttribute("href", "/users/10")
    expect(screen.getByText(/的 Agent/)).toBeInTheDocument()
  })

  it("Agent 用户支持移动端 touchEnd 点按唤出浮层", async () => {
    vi.mocked(usersApi.getProfile).mockResolvedValue({
      ...mockUser,
      id: 2,
      username: "helper-bot",
      bio: "",
      isAgent: true,
      ownerName: "alice",
      ownerId: 10
    })
    vi.mocked(usersApi.getActivity).mockResolvedValue({
      events: [],
      hasMore: false
    })

    renderPage("2")

    const trigger = await screen.findByRole("button", {
      name: /helper-bot.*Agent/
    })
    fireEvent.touchEnd(trigger)

    const ownerLink = await screen.findByRole("link", { name: "alice" })
    expect(ownerLink).toBeInTheDocument()
    expect(ownerLink).toHaveAttribute("href", "/users/10")
  })

  it("Agent 用户无归属人或 ownerId 缺失时回落纯文本「已注销用户的 Agent」", async () => {
    const user = userEvent.setup()
    vi.mocked(usersApi.getProfile).mockResolvedValue({
      ...mockUser,
      id: 3,
      username: "orphan-bot",
      bio: "",
      isAgent: true,
      ownerName: null,
      ownerId: null
    })
    vi.mocked(usersApi.getActivity).mockResolvedValue({
      events: [],
      hasMore: false
    })

    renderPage("3")

    expect(
      await screen.findByRole("heading", { name: "orphan-bot" })
    ).toBeInTheDocument()
    expect(screen.getByText("Agent")).toBeInTheDocument()

    const trigger = screen.getByRole("button", { name: /orphan-bot.*Agent/ })
    await user.click(trigger)

    expect(await screen.findByText("已注销用户的 Agent")).toBeInTheDocument()
    expect(
      screen.queryByRole("link", { name: /已注销用户的 Agent/ })
    ).toBeNull()
  })

  it("人类用户不显示 Agent 徽标与浮层触发器", async () => {
    vi.mocked(usersApi.getProfile).mockResolvedValue({
      ...mockUser,
      isAgent: false
    })
    vi.mocked(usersApi.getActivity).mockResolvedValue({
      events: [],
      hasMore: false
    })

    renderPage("1")

    expect(
      await screen.findByRole("heading", { name: "alice" })
    ).toBeInTheDocument()
    expect(screen.queryByText("Agent")).toBeNull()
    expect(screen.queryByRole("button", { name: /alice.*Agent/ })).toBeNull()
  })

  it("动态流为空时展示空态", async () => {
    vi.mocked(usersApi.getProfile).mockResolvedValue(mockUser)
    vi.mocked(usersApi.getActivity).mockResolvedValue({
      events: [],
      hasMore: false
    })

    renderPage("1")

    expect(await screen.findByText("暂无动态")).toBeInTheDocument()
    expect(
      screen.getByText("该作者尚未产生你有权查看的任何动态。")
    ).toBeInTheDocument()
  })

  it("用户不存在（404）时展示用户不存在空态及回首页按钮", async () => {
    vi.mocked(usersApi.getProfile).mockRejectedValue(
      new ApiError(404, "User not found")
    )
    vi.mocked(usersApi.getActivity).mockResolvedValue({
      events: [],
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

  it("支持点击「显示更多」按钮分页拉取下一页动态", async () => {
    const user = userEvent.setup()
    vi.mocked(usersApi.getProfile).mockResolvedValue(mockUser)
    vi.mocked(usersApi.getActivity)
      .mockResolvedValueOnce({
        events: [
          {
            id: "page-101",
            type: "page_created",
            pageId: 101,
            pageTitle: "第一页文档",
            spaceName: "空间A",
            createdAt: "2026-11-20T00:00:00.000Z"
          }
        ],
        hasMore: true
      })
      .mockResolvedValueOnce({
        events: [
          {
            id: "page-102",
            type: "page_created",
            pageId: 102,
            pageTitle: "第二页文档",
            spaceName: "空间B",
            createdAt: "2026-11-19T00:00:00.000Z"
          }
        ],
        hasMore: false
      })

    renderPage("1")

    expect(await screen.findByText("第一页文档")).toBeInTheDocument()
    const loadMoreButton = screen.getByRole("button", { name: "显示更多" })
    expect(loadMoreButton).toBeInTheDocument()

    expect(usersApi.getActivity).toHaveBeenNthCalledWith(1, 1, {
      page: 1,
      limit: 10
    })

    await user.click(loadMoreButton)

    expect(usersApi.getActivity).toHaveBeenNthCalledWith(2, 1, {
      page: 2,
      limit: 10
    })
    expect(await screen.findByText("第二页文档")).toBeInTheDocument()
    expect(screen.getByText("第一页文档")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "显示更多" })).toBeNull()
  })

  it("显示更多失败时保留已有列表与按钮，展示错误提示而不清空页面", async () => {
    const user = userEvent.setup()
    vi.mocked(usersApi.getProfile).mockResolvedValue(mockUser)
    vi.mocked(usersApi.getActivity)
      .mockResolvedValueOnce({
        events: [
          {
            id: "page-101",
            type: "page_created",
            pageId: 101,
            pageTitle: "第一页文档",
            spaceName: "空间A",
            createdAt: "2026-11-20T00:00:00.000Z"
          }
        ],
        hasMore: true
      })
      .mockRejectedValueOnce(new ApiError(500, "分页加载超时"))
      .mockResolvedValueOnce({
        events: [
          {
            id: "page-102",
            type: "page_created",
            pageId: 102,
            pageTitle: "第二页文档",
            spaceName: "空间B",
            createdAt: "2026-11-19T00:00:00.000Z"
          }
        ],
        hasMore: false
      })

    renderPage("1")

    expect(await screen.findByText("第一页文档")).toBeInTheDocument()
    const loadMoreButton = screen.getByRole("button", { name: "显示更多" })
    expect(loadMoreButton).toBeInTheDocument()

    await user.click(loadMoreButton)

    expect(screen.getByText("第一页文档")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "alice" })).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(await screen.findByText("分页加载超时")).toBeInTheDocument()
    expect(loadMoreButton).toBeInTheDocument()

    await user.click(loadMoreButton)
    expect(await screen.findByText("第二页文档")).toBeInTheDocument()
    expect(screen.queryByText("分页加载超时")).toBeNull()
    expect(screen.queryByRole("button", { name: "显示更多" })).toBeNull()
  })

  it("网络或服务器异常时展示错误信息与重试按钮", async () => {
    const user = userEvent.setup()
    vi.mocked(usersApi.getProfile)
      .mockRejectedValueOnce(new Error("网络故障"))
      .mockResolvedValueOnce(mockUser)
    vi.mocked(usersApi.getActivity).mockResolvedValue(mockActivity)

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
    vi.mocked(usersApi.getActivity).mockResolvedValue({
      events: [],
      hasMore: false
    })

    renderPage("1")

    expect(
      await screen.findByRole("heading", { name: "alice" })
    ).toBeInTheDocument()
    expect(screen.getByText("Joined 11/20/2026")).toBeInTheDocument()
    expect(screen.getByText("Activity")).toBeInTheDocument()
    expect(screen.getByText("Pages")).toBeInTheDocument()
    expect(screen.getByText("Comments")).toBeInTheDocument()
    expect(screen.getByText("No activity yet")).toBeInTheDocument()
  })

  it("英文环境下展示 Agent 归属人浮层与已注销状态文本", async () => {
    await i18n.changeLanguage("en")
    const user = userEvent.setup()
    vi.mocked(usersApi.getProfile).mockResolvedValue({
      ...mockUser,
      id: 2,
      username: "helper-bot",
      bio: "",
      isAgent: true,
      ownerName: "alice",
      ownerId: 10
    })
    vi.mocked(usersApi.getActivity).mockResolvedValue({
      events: [],
      hasMore: false
    })

    const { unmount } = renderPage("2")

    expect(
      await screen.findByRole("heading", { name: "helper-bot" })
    ).toBeInTheDocument()
    const trigger = screen.getByRole("button", { name: /helper-bot.*Agent/ })
    await user.click(trigger)

    const ownerLink = await screen.findByRole("link", { name: "alice" })
    expect(ownerLink).toBeInTheDocument()
    expect(screen.getByText(/'s Agent/)).toBeInTheDocument()
    unmount()

    vi.mocked(usersApi.getProfile).mockResolvedValue({
      ...mockUser,
      id: 3,
      username: "orphan-bot",
      bio: "",
      isAgent: true,
      ownerName: null,
      ownerId: null
    })
    renderPage("3")
    const trigger2 = await screen.findByRole("button", {
      name: /orphan-bot.*Agent/
    })
    await user.click(trigger2)
    expect(await screen.findByText("Deleted User's Agent")).toBeInTheDocument()
  })

  it("右栏只展示个人卡，不渲染文档目录 ArticleToc", async () => {
    vi.mocked(usersApi.getProfile).mockResolvedValue(mockUser)
    vi.mocked(usersApi.getActivity).mockResolvedValue(mockActivity)

    renderPage("1")

    expect(
      await screen.findByRole("heading", { name: "alice" })
    ).toBeInTheDocument()
    // 验证页面内不包含 ArticleToc（无论是 data-toc 属性还是目录导航标签）
    expect(screen.queryByLabelText("目录")).toBeNull()
    expect(screen.queryByLabelText("Table of contents")).toBeNull()
    expect(document.querySelector("[data-article-toc]")).toBeNull()
  })

  it("从带目录文档页点击作者链接进入作者主页，右栏只展示个人卡，不残留或渲染 ArticleToc", async () => {
    const user = userEvent.setup()
    vi.mocked(usersApi.getProfile).mockResolvedValue(mockUser)
    vi.mocked(usersApi.getActivity).mockResolvedValue(mockActivity)

    render(
      <MemoryRouter initialEntries={["/p/101"]}>
        <Routes>
          <Route
            path="/p/:id"
            element={
              <div>
                <nav aria-label="Table of contents" data-article-toc>
                  <span>文档目录内容</span>
                </nav>
                <Link to="/users/1">alice</Link>
              </div>
            }
          />
          <Route path="/users/:id" element={<UserPage />} />
        </Routes>
      </MemoryRouter>
    )

    expect(screen.getByLabelText("Table of contents")).toBeInTheDocument()
    const authorLink = screen.getByRole("link", { name: "alice" })
    await user.click(authorLink)

    expect(
      await screen.findByRole("heading", { name: "alice" })
    ).toBeInTheDocument()
    expect(screen.queryByLabelText("Table of contents")).toBeNull()
    expect(document.querySelector("[data-article-toc]")).toBeNull()
    expect(screen.getByText("5")).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
  })
})
