import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import {
  ApiError,
  type CommentList,
  type NotificationDto,
  type PageDetail
} from "@/lib/api"
import { NotificationsPage } from "@/pages/NotificationsPage"
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
    id: 201,
    actorId: 2,
    actorName: "Alice",
    actorAvatarUrl: null,
    type: "comment",
    pageId: 1,
    commentId: 11,
    pageTitle: "产品设计定版",
    excerpt: "我认为这个交互很棒",
    read: false,
    readAt: null,
    createdAt: "2026-11-24T03:00:00.000Z"
  },
  {
    id: 202,
    actorId: 3,
    actorName: "Bob",
    actorAvatarUrl: null,
    type: "reply",
    pageId: 1,
    commentId: 12,
    pageTitle: "产品设计定版",
    excerpt: "同意上面的看法",
    read: true,
    readAt: "2026-11-24T03:10:00.000Z",
    createdAt: "2026-11-24T03:05:00.000Z"
  }
]

function renderWithRouter(initialEntries = ["/notifications"]) {
  const router = createMemoryRouter(
    [
      {
        path: "/notifications",
        element: <NotificationsPage />
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

describe("NotificationsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    void i18n.changeLanguage("zh")
    useNotificationStore.setState({ unreadCount: 1, loading: false })

    vi.mocked(notificationsApi.unreadCount).mockResolvedValue({ count: 1 })
    vi.mocked(notificationsApi.list).mockResolvedValue({
      items: mockNotifications
    })
    vi.mocked(notificationsApi.markRead).mockResolvedValue({ success: true })
    vi.mocked(notificationsApi.markAllRead).mockResolvedValue({ success: true })
    vi.mocked(pagesApi.get).mockResolvedValue({
      id: 1,
      title: "产品设计定版"
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
          createdAt: "2026-11-24T03:00:00.000Z",
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
              createdAt: "2026-11-24T03:05:00.000Z",
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

  it("渲染标题、未读数与通知列表项", async () => {
    renderWithRouter()

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "通知" })).toBeInTheDocument()
      expect(screen.getByText("1 条未读")).toBeInTheDocument()
      expect(screen.getByText("Alice")).toBeInTheDocument()
      expect(screen.getByText("Bob")).toBeInTheDocument()
      expect(screen.getByText("我认为这个交互很棒")).toBeInTheDocument()
    })
  })

  it("列表为空时渲染暂无通知空状态", async () => {
    vi.mocked(notificationsApi.list).mockResolvedValueOnce({ items: [] })
    renderWithRouter()

    await waitFor(() => {
      expect(screen.getByText("暂无通知")).toBeInTheDocument()
    })
  })

  it("接口报错时渲染错误提示与重试按钮", async () => {
    vi.mocked(notificationsApi.list).mockRejectedValueOnce(
      new Error("Network error")
    )
    renderWithRouter()

    await waitFor(() => {
      expect(screen.getByText("通知加载失败")).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument()
    })
  })

  it("点击通知项标记已读并跳转对应评论", async () => {
    const user = userEvent.setup()
    const { router } = renderWithRouter()

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument()
    })

    const aliceBtn = screen.getByText("Alice").closest("button")
    await user.click(aliceBtn!)

    await waitFor(() => {
      expect(notificationsApi.markRead).toHaveBeenCalledWith(201)
      expect(router.state.location.pathname).toBe("/p/1")
      expect(router.state.location.hash).toBe("#comment-11")
    })
  })

  it("目标文档已被删除时只标记已读不跳转", async () => {
    const user = userEvent.setup()
    vi.mocked(pagesApi.get).mockRejectedValueOnce(
      new ApiError(404, "Page not found")
    )
    const { router } = renderWithRouter()

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument()
    })

    const aliceBtn = screen.getByText("Alice").closest("button")
    await user.click(aliceBtn!)

    await waitFor(() => {
      expect(notificationsApi.markRead).toHaveBeenCalledWith(201)
      expect(router.state.location.pathname).toBe("/notifications")
    })
  })

  it("点击全部标为已读成功清零未读数", async () => {
    const user = userEvent.setup()
    useNotificationStore.setState({ unreadCount: 3 })
    renderWithRouter()

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /全部标为已读/ })
      ).toBeInTheDocument()
    })

    const markAllBtn = screen.getByRole("button", { name: /全部标为已读/ })
    await user.click(markAllBtn)

    await waitFor(() => {
      expect(notificationsApi.markAllRead).toHaveBeenCalled()
      expect(useNotificationStore.getState().unreadCount).toBe(0)
    })
  })

  it("分页按钮按页码正常触发拉取", async () => {
    const user = userEvent.setup()
    // 构造满页 20 条数据，让下一页按钮可用
    const twentyItems = Array.from({ length: 20 }, (_, idx) => ({
      ...mockNotifications[0],
      id: 300 + idx
    }))
    vi.mocked(notificationsApi.list).mockResolvedValueOnce({
      items: twentyItems
    })

    renderWithRouter()

    await waitFor(() => {
      expect(notificationsApi.list).toHaveBeenCalledWith({
        limit: 20,
        offset: 0
      })
    })

    const nextBtn = screen.getByRole("button", { name: /下一页/ })
    expect(nextBtn).toBeEnabled()
    await user.click(nextBtn)

    await waitFor(() => {
      expect(notificationsApi.list).toHaveBeenCalledWith({
        limit: 20,
        offset: 20
      })
      expect(screen.getByText("第 2 页")).toBeInTheDocument()
    })
  })
})
