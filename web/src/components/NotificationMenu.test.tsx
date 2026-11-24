import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationMenu } from "@/components/NotificationMenu"
import { i18n } from "@/i18n"
import {
  ApiError,
  type CommentList,
  type NotificationDto,
  type PageDetail
} from "@/lib/api"
import { useNotificationStore } from "@/stores/notifications"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    notificationsApi: {
      list: vi.fn(),
      unreadCount: vi.fn(),
      markRead: vi.fn(),
      markAllRead: vi.fn()
    },
    pagesApi: {
      ...actual.pagesApi,
      get: vi.fn()
    },
    commentsApi: {
      ...actual.commentsApi,
      list: vi.fn()
    }
  }
})

const { notificationsApi, pagesApi, commentsApi } = await import("@/lib/api")

const mockNotifications: NotificationDto[] = [
  {
    id: 101,
    actorId: 2,
    actorName: "Alice",
    actorAvatarUrl: null,
    type: "comment",
    pageId: 1,
    commentId: 11,
    pageTitle: "测试页面一",
    excerpt: "这是 Alice 的评论摘要",
    read: false,
    readAt: null,
    createdAt: "2026-11-24T02:00:00.000Z"
  },
  {
    id: 102,
    actorId: 3,
    actorName: "Bob",
    actorAvatarUrl: null,
    type: "reply",
    pageId: 1,
    commentId: 12,
    pageTitle: "测试页面一",
    excerpt: "这是 Bob 的回复摘要",
    read: true,
    readAt: "2026-11-24T02:30:00.000Z",
    createdAt: "2026-11-24T02:10:00.000Z"
  }
]

function renderWithRouter(initialEntries = ["/"]) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <NotificationMenu />
      },
      {
        path: "/notifications",
        element: <div>通知历史页</div>
      },
      {
        path: "/p/:pageId",
        element: <div>文档页面</div>
      }
    ],
    { initialEntries }
  )
  return {
    router,
    ...render(<RouterProvider router={router} />)
  }
}

describe("NotificationMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    void i18n.changeLanguage("zh")
    useNotificationStore.setState({ unreadCount: 0, loading: false })

    vi.mocked(notificationsApi.unreadCount).mockResolvedValue({ count: 0 })
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: mockNotifications
    })
    vi.mocked(notificationsApi.markRead).mockResolvedValue({ success: true })
    vi.mocked(notificationsApi.markAllRead).mockResolvedValue({ success: true })
    vi.mocked(pagesApi.get).mockResolvedValue({
      id: 1,
      title: "测试页面一"
    } as PageDetail)
    vi.mocked(commentsApi.list).mockResolvedValue({
      total: 2,
      threads: [
        {
          id: 11,
          parentId: null,
          authorId: 2,
          authorName: "Alice",
          authorAvatarUrl: null,
          bodyMd: "内容",
          html: "<p>内容</p>",
          createdAt: "2026-11-24T02:00:00.000Z",
          editedAt: null,
          deletedAt: null,
          canEdit: true,
          canDelete: true,
          replies: [
            {
              id: 12,
              parentId: 11,
              authorId: 3,
              authorName: "Bob",
              authorAvatarUrl: null,
              bodyMd: "回复",
              html: "<p>回复</p>",
              createdAt: "2026-11-24T02:10:00.000Z",
              editedAt: null,
              deletedAt: null,
              canEdit: true,
              canDelete: true
            }
          ]
        }
      ]
    } as CommentList)
  })

  it("未读数为 0 时不显示角标", async () => {
    vi.mocked(notificationsApi.unreadCount).mockResolvedValue({ count: 0 })
    renderWithRouter()

    const bell = screen.getByRole("button", { name: "通知" })
    expect(bell).toBeInTheDocument()
    expect(screen.queryByTestId("unread-badge")).not.toBeInTheDocument()
  })

  it("未读数大于 0 时正常显示对应数字", async () => {
    vi.mocked(notificationsApi.unreadCount).mockResolvedValue({ count: 5 })
    renderWithRouter()

    await waitFor(() => {
      expect(screen.getByTestId("unread-badge")).toHaveTextContent("5")
    })
  })

  it("未读数大于 99 时角标显示 99+", async () => {
    vi.mocked(notificationsApi.unreadCount).mockResolvedValue({ count: 120 })
    renderWithRouter()

    await waitFor(() => {
      expect(screen.getByTestId("unread-badge")).toHaveTextContent("99+")
    })
  })

  it("点击铃铛展开面板并拉取最近通知列表", async () => {
    const user = userEvent.setup()
    vi.mocked(notificationsApi.unreadCount).mockResolvedValue({ count: 2 })
    renderWithRouter()

    const bell = screen.getByRole("button", { name: "通知" })
    await user.click(bell)

    await waitFor(() => {
      expect(notificationsApi.list).toHaveBeenCalledWith({
        limit: 10,
        offset: 0
      })
      expect(screen.getByText("Alice")).toBeInTheDocument()
      expect(screen.getByText("Bob")).toBeInTheDocument()
      expect(screen.getByText("这是 Alice 的评论摘要")).toBeInTheDocument()
    })
  })

  it("点击未读条目时调用 markRead 并跳转定位到对应评论", async () => {
    const user = userEvent.setup()
    vi.mocked(notificationsApi.unreadCount).mockResolvedValue({ count: 1 })
    const { router } = renderWithRouter()

    const bell = screen.getByRole("button", { name: "通知" })
    await user.click(bell)

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument()
    })

    const aliceItem = screen.getByText("Alice").closest("button")
    expect(aliceItem).toBeInTheDocument()
    await user.click(aliceItem!)

    await waitFor(() => {
      expect(notificationsApi.markRead).toHaveBeenCalledWith(101)
      expect(router.state.location.pathname).toBe("/p/1")
      expect(router.state.location.hash).toBe("#comment-11")
    })
  })

  it("目标文档已删除时只标已读不跳转并提示", async () => {
    const user = userEvent.setup()
    vi.mocked(notificationsApi.unreadCount).mockResolvedValue({ count: 1 })
    vi.mocked(pagesApi.get).mockRejectedValueOnce(
      new ApiError(404, "Page not found")
    )
    const { router } = renderWithRouter()

    const bell = screen.getByRole("button", { name: "通知" })
    await user.click(bell)

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument()
    })

    const aliceItem = screen.getByText("Alice").closest("button")
    await user.click(aliceItem!)

    await waitFor(() => {
      expect(notificationsApi.markRead).toHaveBeenCalledWith(101)
      // 未发生跳转，仍停在当前页
      expect(router.state.location.pathname).toBe("/")
    })
  })

  it("目标评论已删除时只标已读不跳转并提示", async () => {
    const user = userEvent.setup()
    vi.mocked(notificationsApi.unreadCount).mockResolvedValue({ count: 1 })
    // 模拟评论已被软删或不存在
    vi.mocked(commentsApi.list).mockResolvedValueOnce({
      total: 0,
      threads: []
    } as CommentList)
    const { router } = renderWithRouter()

    const bell = screen.getByRole("button", { name: "通知" })
    await user.click(bell)

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument()
    })

    const aliceItem = screen.getByText("Alice").closest("button")
    await user.click(aliceItem!)

    await waitFor(() => {
      expect(notificationsApi.markRead).toHaveBeenCalledWith(101)
      // 未发生跳转
      expect(router.state.location.pathname).toBe("/")
    })
  })

  it("点击全部标为已读调用 markAllRead", async () => {
    const user = userEvent.setup()
    vi.mocked(notificationsApi.unreadCount).mockResolvedValue({ count: 3 })
    renderWithRouter()

    const bell = screen.getByRole("button", { name: "通知" })
    await user.click(bell)

    const markAllBtn = await screen.findByRole("button", {
      name: /全部标为已读/
    })
    await waitFor(() => {
      expect(markAllBtn).toBeEnabled()
    })
    await user.click(markAllBtn)

    await waitFor(() => {
      expect(notificationsApi.markAllRead).toHaveBeenCalled()
      expect(useNotificationStore.getState().unreadCount).toBe(0)
    })
  })

  it("点击查看全部跳转到 /notifications 历史页", async () => {
    const user = userEvent.setup()
    const { router } = renderWithRouter()

    const bell = screen.getByRole("button", { name: "通知" })
    await user.click(bell)

    const viewAllBtn = screen.getByRole("button", { name: "查看全部" })
    await user.click(viewAllBtn)

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/notifications")
    })
  })
})
