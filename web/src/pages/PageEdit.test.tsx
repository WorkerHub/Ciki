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
      canvasPreview: vi.fn(),
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
  updatedAt: "2026-11-07T00:00:00.000Z",
  createdByName: "张三",
  createdByAvatarUrl: null,
  updatedByName: "张三",
  updatedByAvatarUrl: null
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

  it("保存按钮保存成功后自动返回阅读模式，且离开守卫不弹窗", async () => {
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(page)
    vi.mocked(pagesApi.update).mockResolvedValue({
      ...page,
      title: `${page.title}！`,
      updatedAt: "2026-11-21T12:00:00.000Z"
    })
    const user = userEvent.setup()
    renderEdit()

    const title = await screen.findByLabelText("页面标题")
    await user.type(title, "！")
    await user.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() => expect(pagesApi.update).toHaveBeenCalled())
    // 保存成功后自动回阅读页，离开守卫不拦截
    expect(await screen.findByText("阅读页占位")).toBeInTheDocument()
    expect(screen.queryByText("还有未保存的修改")).toBeNull()
  })

  it("保存按钮保存失败时留在编辑模式展示报错，不跳回阅读页", async () => {
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(page)
    vi.mocked(pagesApi.update).mockRejectedValue(
      new ApiError(500, "网络保存异常")
    )
    const user = userEvent.setup()
    renderEdit()

    const title = await screen.findByLabelText("页面标题")
    await user.type(title, "！")
    await user.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() => expect(pagesApi.update).toHaveBeenCalled())
    // 留在编辑页，展示报错，不导航
    expect(await screen.findByText("网络保存异常")).toBeInTheDocument()
    expect(screen.queryByText("阅读页占位")).toBeNull()
    expect(screen.getByLabelText("页面标题")).toHaveValue(`${page.title}！`)
  })

  it("Ctrl/⌘+S 保存成功后停留在编辑模式当作存档点，不跳回阅读页", async () => {
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(page)
    vi.mocked(pagesApi.update).mockResolvedValue({
      ...page,
      title: `${page.title}！`,
      updatedAt: "2026-11-21T12:00:00.000Z"
    })
    const user = userEvent.setup()
    renderEdit()

    const title = await screen.findByLabelText("页面标题")
    await user.type(title, "！")

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true })
    )

    await waitFor(() => expect(pagesApi.update).toHaveBeenCalled())
    // 不跳回阅读页
    expect(screen.queryByText("阅读页占位")).toBeNull()
    // 工具条中保存状态从「有未保存的更改」变为「已保存」
    const toolbar = screen.getByRole("toolbar")
    await waitFor(() =>
      expect(within(toolbar).queryByText("有未保存的更改")).toBeNull()
    )
    expect(within(toolbar).getByText(/^已保存 /)).toBeInTheDocument()
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

describe("文档编辑页预览功能", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  beforeEach(async () => {
    await i18n.changeLanguage("zh")
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
    vi.mocked(pagesApi.canvasPreview).mockReset()
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(page)
  })

  it("编辑态顶栏在取消与保存之外增加「预览」按钮", async () => {
    renderEdit()
    const toolbar = await screen.findByRole("toolbar")
    const previewBtn = within(toolbar).getByRole("button", { name: "预览" })
    expect(previewBtn).toBeInTheDocument()
    expect(
      within(toolbar).getByRole("button", { name: "取消" })
    ).toBeInTheDocument()
    expect(
      within(toolbar).getByRole("button", { name: "保存" })
    ).toBeInTheDocument()
  })

  it("点击「预览」进入预览态，渲染当前编辑中的内容，且不调用保存接口", async () => {
    const user = userEvent.setup()
    renderEdit()
    const titleInput = await screen.findByLabelText("页面标题")
    await user.type(titleInput, "（未保存修订）")

    const toolbar = screen.getByRole("toolbar")
    await user.click(within(toolbar).getByRole("button", { name: "预览" }))

    // 预览模式容器出现
    const previewContainer = document.querySelector("[data-page-preview]")
    expect(previewContainer).toBeInTheDocument()

    // 标题反映当前最新编辑中的内容
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "支付服务部署手册（未保存修订）"
    )

    // 预览态顶栏提供「返回编辑」与「保存」
    const previewToolbar = screen.getByRole("toolbar", { name: "预览工具条" })
    expect(
      within(previewToolbar).getByRole("button", { name: "返回编辑" })
    ).toBeInTheDocument()
    expect(
      within(previewToolbar).getByRole("button", { name: "保存" })
    ).toBeInTheDocument()

    // 状态口径原样保留
    expect(
      within(previewToolbar).getByText("有未保存的更改")
    ).toBeInTheDocument()

    // 绝无保存接口调用
    expect(pagesApi.update).not.toHaveBeenCalled()
  })

  it("在预览态点「返回编辑」回到编辑态且内容、未保存状态原样保留，不调保存接口", async () => {
    const user = userEvent.setup()
    renderEdit()
    const titleInput = await screen.findByLabelText("页面标题")
    await user.type(titleInput, "修改版")

    const toolbar = screen.getByRole("toolbar")
    await user.click(within(toolbar).getByRole("button", { name: "预览" }))

    const previewToolbar = await screen.findByRole("toolbar", {
      name: "预览工具条"
    })
    await user.click(
      within(previewToolbar).getByRole("button", { name: "返回编辑" })
    )

    // 回到编辑态
    expect(document.querySelector("[data-page-preview]")).toBeNull()
    const restoredTitle = screen.getByLabelText("页面标题")
    expect(restoredTitle).toBeInTheDocument()
    expect(restoredTitle).toHaveValue("支付服务部署手册修改版")

    // 未保存状态仍保留
    const editToolbar = screen.getByRole("toolbar")
    expect(within(editToolbar).getByText("有未保存的更改")).toBeInTheDocument()
    expect(pagesApi.update).not.toHaveBeenCalled()
  })

  it("在预览态点「保存」走同一保存路径，保存成功后返回阅读页", async () => {
    const user = userEvent.setup()
    renderEdit()
    const titleInput = await screen.findByLabelText("页面标题")
    await user.type(titleInput, "最终稿")

    const toolbar = screen.getByRole("toolbar")
    await user.click(within(toolbar).getByRole("button", { name: "预览" }))

    const previewToolbar = await screen.findByRole("toolbar", {
      name: "预览工具条"
    })
    vi.mocked(pagesApi.update).mockResolvedValueOnce({
      ...page,
      title: "支付服务部署手册最终稿",
      updatedAt: "2026-11-23T12:00:00.000Z"
    })

    await user.click(
      within(previewToolbar).getByRole("button", { name: "保存" })
    )

    await waitFor(() => expect(pagesApi.update).toHaveBeenCalledTimes(1))
    expect(pagesApi.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        title: "支付服务部署手册最终稿"
      })
    )
    // 成功保存后回阅读页
    expect(await screen.findByText("阅读页占位")).toBeInTheDocument()
  })

  it("在预览态点「保存」若失败，留在预览态并显示报错，不跳回阅读页", async () => {
    const user = userEvent.setup()
    renderEdit()
    const titleInput = await screen.findByLabelText("页面标题")
    await user.type(titleInput, "测试失败")

    const toolbar = screen.getByRole("toolbar")
    await user.click(within(toolbar).getByRole("button", { name: "预览" }))

    const previewToolbar = await screen.findByRole("toolbar", {
      name: "预览工具条"
    })
    vi.mocked(pagesApi.update).mockRejectedValueOnce(
      new ApiError(500, "数据库写入超时")
    )

    await user.click(
      within(previewToolbar).getByRole("button", { name: "保存" })
    )

    await waitFor(() => expect(pagesApi.update).toHaveBeenCalledTimes(1))
    // 报错信息渲染在预览态
    expect(await screen.findByRole("alert")).toHaveTextContent("数据库写入超时")
    // 依然在预览态，未跳回阅读页
    expect(screen.queryByText("阅读页占位")).toBeNull()
    expect(
      screen.getByRole("toolbar", { name: "预览工具条" })
    ).toBeInTheDocument()
  })

  it("在预览态按 Ctrl/⌘+S 保存成功后停留在当前页当作存档点，保存状态更新为已保存", async () => {
    const user = userEvent.setup()
    renderEdit()
    const titleInput = await screen.findByLabelText("页面标题")
    await user.type(titleInput, "阶段存档")

    const toolbar = screen.getByRole("toolbar")
    await user.click(within(toolbar).getByRole("button", { name: "预览" }))

    const previewToolbar = await screen.findByRole("toolbar", {
      name: "预览工具条"
    })
    expect(
      within(previewToolbar).getByText("有未保存的更改")
    ).toBeInTheDocument()

    vi.mocked(pagesApi.update).mockResolvedValueOnce({
      ...page,
      title: "支付服务部署手册阶段存档",
      updatedAt: "2026-11-23T12:00:00.000Z"
    })

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true })
    )

    await waitFor(() => expect(pagesApi.update).toHaveBeenCalledTimes(1))
    // 不跳回阅读页
    expect(screen.queryByText("阅读页占位")).toBeNull()
    // 状态更新为已保存
    await waitFor(() =>
      expect(within(previewToolbar).queryByText("有未保存的更改")).toBeNull()
    )
    expect(within(previewToolbar).getByText(/^已保存 /)).toBeInTheDocument()
  })

  it("预览态下复用阅读管线渲染块级内容（图片、Excalidraw、Embed），不触发回填保存", async () => {
    const blockPage: PageContentDetail = {
      ...page,
      contentJson: JSON.stringify({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "测试段落" }]
          },
          {
            type: "image",
            attrs: {
              src: "/api/files/test-img-key",
              width: 300
            }
          },
          {
            type: "excalidraw",
            attrs: {
              sceneKey: "scene-key-123",
              previewKey: "preview-key-123",
              extractedText: "架构流程图",
              width: 400
            }
          },
          {
            type: "htmlEmbed",
            attrs: {
              key: "embed-key-123",
              name: "嵌入式组件.html",
              height: 480
            }
          }
        ]
      }),
      contentHtml:
        '<p>测试段落</p><img src="/api/files/test-img-key" width="300" /><img data-type="excalidraw" data-scene-key="scene-key-123" data-preview-key="preview-key-123" alt="架构流程图" width="400" /><div data-type="html-embed" data-key="embed-key-123" data-name="嵌入式组件.html" data-height="480"></div>',
      contentText: "测试段落\n架构流程图\n[HTML Embed: 嵌入式组件.html]"
    }
    vi.mocked(pagesApi.getForEditor).mockResolvedValue(blockPage)
    const user = userEvent.setup()
    renderEdit()

    const toolbar = await screen.findByRole("toolbar")
    await user.click(within(toolbar).getByRole("button", { name: "预览" }))

    // 预览态正确使用阅读管线渲染
    const previewContainer = document.querySelector("[data-page-preview]")
    expect(previewContainer).toBeInTheDocument()
    expect(previewContainer).toHaveTextContent("测试段落")

    // 验证进出预览没有触发任何 save 相关的调用
    expect(pagesApi.update).not.toHaveBeenCalled()
    expect(pagesApi.canvasPreview).not.toHaveBeenCalled()
  })

  it("英文环境下预览相关文案（按钮、工具条、状态）全部按英文展示", async () => {
    await i18n.changeLanguage("en")
    const user = userEvent.setup()
    renderEdit()

    const toolbar = await screen.findByRole("toolbar")
    const previewBtn = within(toolbar).getByRole("button", { name: "Preview" })
    expect(previewBtn).toBeInTheDocument()

    await user.click(previewBtn)

    const previewToolbar = screen.getByRole("toolbar", {
      name: "Preview toolbar"
    })
    expect(
      within(previewToolbar).getByRole("button", { name: "Back to edit" })
    ).toBeInTheDocument()
    expect(
      within(previewToolbar).getByRole("button", { name: "Save" })
    ).toBeInTheDocument()
  })
})
