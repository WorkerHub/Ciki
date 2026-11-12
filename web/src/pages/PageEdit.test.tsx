import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest"
import { ApiError, type PageContentDetail } from "@/lib/api"
import { i18n } from "@/i18n"
import { rememberScrollAnchor } from "@/lib/scroll-anchor"
import { PageEdit } from "@/pages/PageEdit"
import { usePagesStore } from "@/stores/pages"
import { useSpacesStore } from "@/stores/spaces"
import { installScrollLayout, ScrollHost } from "@/test/scroll-layout"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    pagesApi: {
      ...actual.pagesApi,
      getForEditor: vi.fn(),
      update: vi.fn(),
      tree: vi.fn()
    }
  }
})

const { pagesApi } = await import("@/lib/api")

const page: PageContentDetail = {
  id: 1,
  parentId: null,
  spaceId: 1,
  title: "支付服务部署手册",
  sortOrder: 0,
  contentJson: JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "正文" }] }]
  }),
  contentHtml: "<p>正文</p>",
  contentText: "正文",
  contentMd: "正文",
  createdBy: 1,
  updatedBy: 1,
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z"
}

const space = {
  id: 1,
  slug: "default",
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
      router={createMemoryRouter(routes, { initialEntries: ["/p/1/edit"] })}
    />
  )

describe("编辑页的保存保护", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  beforeEach(() => {
    usePagesStore.setState({
      tree: [],
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })
    useSpacesStore.setState({
      spaces: [space],
      status: "ready",
      error: null,
      currentId: 1
    })
    vi.mocked(pagesApi.tree).mockResolvedValue([])
    vi.mocked(pagesApi.update).mockReset()
  })

  it("页面还没加载完成时按 Ctrl/⌘+S 不会写回空内容", async () => {
    // 永不 resolve：模拟慢请求/卡住的加载
    vi.mocked(pagesApi.getForEditor).mockImplementation(
      () => new Promise<PageContentDetail>(() => {})
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
    vi.mocked(pagesApi.getForEditor).mockRejectedValue(
      new ApiError(500, "boom")
    )
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
      currentId: 1
    })
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(page)
    renderEdit()

    expect(await screen.findByLabelText("页面加载中")).toBeInTheDocument()
    expect(
      screen.queryByText("你是这个空间的只读成员，不能编辑页面。")
    ).toBeNull()
  })

  it("只读空间直链进编辑页时只给说明，不渲染编辑器", async () => {
    const user = userEvent.setup()
    useSpacesStore.setState({ spaces: [{ ...space, myRole: "viewer" }] })
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(page)
    renderEdit()

    expect(
      await screen.findByText("你是这个空间的只读成员，不能编辑页面。")
    ).toBeInTheDocument()
    expect(screen.queryByLabelText("页面标题")).toBeNull()

    await user.click(screen.getByRole("button", { name: "返回阅读" }))
    expect(await screen.findByText("阅读页占位")).toBeInTheDocument()
  })

  it("编辑页没有刷新入口，也不会被切回标签页刷新冲掉", async () => {
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(page)
    const calls = vi.mocked(pagesApi.getForEditor).mock.calls.length
    renderEdit()

    await screen.findByLabelText("页面标题")
    expect(screen.queryByRole("button", { name: "刷新" })).toBeNull()

    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event("focus"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(vi.mocked(pagesApi.getForEditor).mock.calls.length).toBe(calls + 1)
    expect(screen.getByLabelText("页面标题")).toHaveValue(page.title)
  })

  it("保存入口只有一处：落在吸顶的工具条行尾", async () => {
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(page)
    renderEdit()

    const toolbar = await screen.findByRole("toolbar")
    const saveButtons = screen.getAllByRole("button", { name: "保存" })
    expect(saveButtons).toHaveLength(1)
    expect(toolbar).toContainElement(saveButtons[0])

    // 工具条整行吸顶，偏移 0 就是应用顶栏下沿
    const stickyBar = toolbar.closest("[data-editor-sticky-bar]")
    expect(stickyBar).not.toBeNull()
    expect(stickyBar?.className).toContain("sticky")
    expect(stickyBar?.className).toContain("top-0")
  })

  it("保存状态与保存按钮同处一处：改标题后在工具条里变成「有未保存的更改」", async () => {
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(page)
    const user = userEvent.setup()
    renderEdit()

    const title = await screen.findByLabelText("页面标题")
    const toolbar = screen.getByRole("toolbar")
    expect(within(toolbar).queryByText("有未保存的更改")).toBeNull()
    expect(within(toolbar).getByText(/^已保存 /)).toBeInTheDocument()

    await user.type(title, "！")
    expect(within(toolbar).getByText("有未保存的更改")).toBeInTheDocument()
  })

  it("「保存并离开」保存失败时留在当前页，不丢内容", async () => {
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(page)
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

  it("空正文的占位文案只说「直接粘贴内容」，不再提 Confluence", async () => {
    vi.mocked(pagesApi.getForEditor).mockResolvedValue({
      ...page,
      contentJson: JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph" }]
      }),
      contentHtml: "<p></p>",
      contentText: ""
    })
    renderEdit()

    await screen.findByLabelText("页面标题")
    await waitFor(() =>
      expect(document.querySelector(".wiki-content .is-empty")).toHaveAttribute(
        "data-placeholder",
        "开始输入，或直接粘贴内容…"
      )
    )
  })

  it("「取消」与「保存」同处吸顶工具条，全页只有这一处取消", async () => {
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(page)
    renderEdit()

    const toolbar = await screen.findByRole("toolbar")
    const cancelButtons = screen.getAllByRole("button", { name: "取消" })
    expect(cancelButtons).toHaveLength(1)
    expect(toolbar).toContainElement(cancelButtons[0])
    // 保存入口仍然只有一处，取消不给第二个入口
    expect(screen.getAllByRole("button", { name: "保存" })).toHaveLength(1)
  })

  it("没有改动时点「取消」直接回阅读页，不弹确认也不发保存请求", async () => {
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(page)
    const user = userEvent.setup()
    renderEdit()

    await screen.findByLabelText("页面标题")
    await user.click(screen.getByRole("button", { name: "取消" }))

    expect(await screen.findByText("阅读页占位")).toBeInTheDocument()
    expect(screen.queryByText("放弃未保存的修改？")).toBeNull()
    expect(pagesApi.update).not.toHaveBeenCalled()
  })

  it("有未保存改动时点「取消」先确认；选「继续编辑」留在原地且内容不丢", async () => {
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(page)
    const user = userEvent.setup()
    renderEdit()

    const title = await screen.findByLabelText("页面标题")
    await user.type(title, "！")

    await user.click(screen.getByRole("button", { name: "取消" }))
    expect(await screen.findByText("放弃未保存的修改？")).toBeInTheDocument()
    // 「放弃修改」是危险色：直接用 Button 的 destructive 变体表达
    expect(screen.getByRole("button", { name: "放弃修改" })).toHaveAttribute(
      "data-variant",
      "destructive"
    )
    // 也就是弹一句确认：还没有导航走，也没有偷偷保存
    expect(screen.queryByText("阅读页占位")).toBeNull()
    expect(pagesApi.update).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "继续编辑" }))
    await waitFor(() =>
      expect(screen.queryByText("放弃未保存的修改？")).toBeNull()
    )
    expect(screen.getByLabelText("页面标题")).toHaveValue(`${page.title}！`)
    expect(screen.queryByText("阅读页占位")).toBeNull()
    expect(pagesApi.update).not.toHaveBeenCalled()
  })

  it("保存进行中「取消」禁用，不会把在途保存当成丢弃", async () => {
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(page)
    vi.mocked(pagesApi.update).mockImplementation(
      () => new Promise<PageContentDetail>(() => {})
    )
    const user = userEvent.setup()
    renderEdit()

    const title = await screen.findByLabelText("页面标题")
    await user.type(title, "！")
    await user.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "取消" })).toBeDisabled()
    )
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled()
  })

  it("「放弃修改」不发保存请求，也不被旧的离开确认再拦一次", async () => {
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(page)
    const user = userEvent.setup()
    renderEdit()

    const title = await screen.findByLabelText("页面标题")
    await user.type(title, "！")

    await user.click(screen.getByRole("button", { name: "取消" }))
    await screen.findByText("放弃未保存的修改？")
    await user.click(screen.getByRole("button", { name: "放弃修改" }))

    expect(await screen.findByText("阅读页占位")).toBeInTheDocument()
    // 放弃这条路径必须绕过 blocker：「还有未保存的修改」不能再弹一次
    expect(screen.queryByText("还有未保存的修改")).toBeNull()
    expect(pagesApi.update).not.toHaveBeenCalled()
  })
})

describe("编辑页按记忆锚点定位", () => {
  const longPage = (): PageContentDetail => {
    const blocks = ["甲", "乙", "丙", "丁"]
    return {
      ...page,
      contentJson: JSON.stringify({
        type: "doc",
        content: blocks.map((text) => ({
          type: "paragraph",
          content: [{ type: "text", text }]
        }))
      }),
      contentHtml: blocks.map((text) => `<p>${text}</p>`).join(""),
      contentText: blocks.join("\n")
    }
  }

  const routes = [
    {
      path: "/p/:pageId/edit",
      element: (
        <ScrollHost>
          <PageEdit />
        </ScrollHost>
      )
    },
    { path: "/p/:pageId", element: <p>阅读页占位</p> },
    { path: "/", element: <p>首页占位</p> }
  ]

  const renderEditInScroller = () =>
    render(
      <RouterProvider
        router={createMemoryRouter(routes, { initialEntries: ["/p/1/edit"] })}
      />
    )

  let layout: { restore: () => void } | null = null

  beforeAll(() => {
    installTiptapJsdomShims()
  })

  beforeEach(() => {
    usePagesStore.setState({
      tree: [],
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })
    useSpacesStore.setState({
      spaces: [space],
      status: "ready",
      error: null,
      currentId: 1
    })
    vi.mocked(pagesApi.tree).mockResolvedValue([])
    vi.mocked(pagesApi.update).mockReset()
    layout = installScrollLayout()
  })

  afterEach(() => {
    layout?.restore()
    layout = null
  })

  it("从阅读页进来时把同一块送回判定线下方", async () => {
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(longPage())
    rememberScrollAnchor(1, { blockIndex: 2, ratio: 0.5 })
    renderEditInScroller()

    await screen.findByLabelText("页面标题")
    const scroller = screen.getByTestId("scroller")
    // 第 3 块顶 200 + 0.5 × 100 = 250，判定线 24（jsdom 里吸顶条高 0）→ 226
    await waitFor(() => expect(scroller.scrollTop).toBeCloseTo(226))
  })

  it("没有记忆锚点时停在顶部，不自行滚动", async () => {
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(longPage())
    renderEditInScroller()

    await screen.findByLabelText("页面标题")
    expect(screen.getByTestId("scroller").scrollTop).toBe(0)
  })
})

/** 英文界面：标题区、保存状态、工具条动作与两个确认框全走 locale。 */
describe("编辑页：英文界面", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  beforeEach(() => {
    usePagesStore.setState({
      tree: [],
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })
    useSpacesStore.setState({
      spaces: [space],
      status: "ready",
      error: null,
      currentId: 1
    })
    vi.mocked(pagesApi.tree).mockResolvedValue([])
    vi.mocked(pagesApi.update).mockReset()
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(page)
  })

  it("标题占位、说明与工具条动作都是英文", async () => {
    await i18n.changeLanguage("en")
    const user = userEvent.setup()
    renderEdit()

    expect(await screen.findByLabelText("Page title")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Back to reading" })
    ).toBeInTheDocument()
    expect(screen.getByText(/every save creates a version/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument()

    await user.type(screen.getByLabelText("Page title"), "!")
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument()
    expect(screen.queryByText("有未保存的更改")).toBeNull()
  })

  it("未保存离开的确认框是英文", async () => {
    await i18n.changeLanguage("en")
    const user = userEvent.setup()
    renderEdit()

    await user.type(await screen.findByLabelText("Page title"), "!")
    await user.click(screen.getByRole("button", { name: "Cancel" }))

    expect(
      await screen.findByText("Discard unsaved changes?")
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Keep editing" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Discard changes" })
    ).toBeInTheDocument()
  })
})
