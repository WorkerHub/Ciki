import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, type PageDetail } from "@/lib/api"
import { PageEdit } from "@/pages/PageEdit"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"
import { usePagesStore } from "@/stores/pages"
import { useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    pagesApi: {
      ...actual.pagesApi,
      get: vi.fn(),
      update: vi.fn(),
      tree: vi.fn()
    }
  }
})

const { pagesApi } = await import("@/lib/api")

const page: PageDetail = {
  id: "a",
  parentId: null,
  spaceId: "space-default",
  title: "支付服务部署手册",
  sortOrder: 0,
  contentJson: JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "正文" }] }]
  }),
  contentHtml: "<p>正文</p>",
  contentText: "正文",
  createdBy: "u1",
  updatedBy: "u1",
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z"
}

const space = {
  id: "space-default",
  name: "默认空间",
  description: "",
  myRole: "editor" as const,
  isDefault: true,
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z"
}

const routes = [
  { path: "/p/:pageId/edit", element: <PageEdit /> },
  { path: "/p/:pageId", element: <p>阅读页占位</p> },
  { path: "/", element: <p>首页占位</p> }
]

const renderEdit = () =>
  render(
    <RouterProvider
      router={createMemoryRouter(routes, { initialEntries: ["/p/a/edit"] })}
    />
  )

describe("编辑页的保存保护", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  beforeEach(() => {
    usePagesStore.setState({
      tree: [],
      spaceId: "space-default",
      loading: false,
      error: null,
      expanded: []
    })
    useSpacesStore.setState({
      spaces: [space],
      status: "ready",
      error: null,
      currentId: "space-default"
    })
    vi.mocked(pagesApi.tree).mockResolvedValue([])
    vi.mocked(pagesApi.update).mockReset()
  })

  it("页面还没加载完成时按 Ctrl/⌘+S 不会写回空内容", async () => {
    // 永不 resolve：模拟慢请求/卡住的加载
    vi.mocked(pagesApi.get).mockImplementation(
      () => new Promise<PageDetail>(() => {})
    )
    renderEdit()

    expect(await screen.findByLabelText("页面加载中")).toBeInTheDocument()
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true })
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(pagesApi.update).not.toHaveBeenCalled()
  })

  it("加载失败时只显示重试入口，不给出空编辑器", async () => {
    vi.mocked(pagesApi.get).mockRejectedValue(new ApiError(500, "boom"))
    renderEdit()

    expect(await screen.findByText("boom")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument()
    expect(screen.queryByLabelText("页面标题")).toBeNull()
  })

  it("空间列表还在加载时先显示骨架屏，不闪只读提示", async () => {
    useSpacesStore.setState({
      spaces: [],
      status: "loading",
      error: null,
      currentId: "space-default"
    })
    vi.mocked(pagesApi.get).mockResolvedValue(page)
    renderEdit()

    expect(await screen.findByLabelText("页面加载中")).toBeInTheDocument()
    expect(
      screen.queryByText("你是这个空间的只读成员，不能编辑页面。")
    ).toBeNull()
  })

  it("只读空间直链进编辑页时只给说明，不渲染编辑器", async () => {
    const user = userEvent.setup()
    useSpacesStore.setState({ spaces: [{ ...space, myRole: "viewer" }] })
    vi.mocked(pagesApi.get).mockResolvedValue(page)
    renderEdit()

    expect(
      await screen.findByText("你是这个空间的只读成员，不能编辑页面。")
    ).toBeInTheDocument()
    expect(screen.queryByLabelText("页面标题")).toBeNull()

    await user.click(screen.getByRole("button", { name: "返回阅读" }))
    expect(await screen.findByText("阅读页占位")).toBeInTheDocument()
  })

  it("「保存并离开」保存失败时留在当前页，不丢内容", async () => {
    vi.mocked(pagesApi.get).mockResolvedValue(page)
    vi.mocked(pagesApi.update).mockRejectedValue(
      new ApiError(413, "Payload too large", "PAYLOAD_TOO_LARGE")
    )
    const user = userEvent.setup()
    renderEdit()

    const title = await screen.findByLabelText("页面标题")
    await user.type(title, "！")

    await user.click(screen.getByRole("button", { name: "返回阅读" }))
    expect(await screen.findByText("还有未保存的修改")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "保存并离开" }))

    await waitFor(() => expect(pagesApi.update).toHaveBeenCalled())
    // 保存失败 → 仍停在编辑页的确认框里，没有导航走
    expect(screen.getByText("还有未保存的修改")).toBeInTheDocument()
    expect(screen.queryByText("阅读页占位")).toBeNull()
    // 错误同时出现在编辑区与确认框里（两处都要能看到）
    expect(
      (await screen.findAllByText(/超过了单次保存上限/)).length
    ).toBeGreaterThan(0)
  })
})
