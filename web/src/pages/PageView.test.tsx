import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router"
import { toast } from "sonner"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest"
import { ApiError, type Me, type PageDetail, type Space } from "@/lib/api"
import { readScrollAnchor, rememberScrollAnchor } from "@/lib/scroll-anchor"
import { PageView } from "@/pages/PageView"
import { useAuthStore } from "@/stores/auth"
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
      get: vi.fn(),
      tree: vi.fn(),
      download: vi.fn()
    },
    commentsApi: { ...actual.commentsApi, list: vi.fn() }
  }
})

const { pagesApi, commentsApi } = await import("@/lib/api")

// 评论区的列表请求在阅读页里真实存在：默认给空列表，免得每个用例都去打网络
beforeEach(() => {
  vi.mocked(commentsApi.list).mockResolvedValue({ total: 0, threads: [] })
})

const memberUser: Me = {
  id: "u1",
  publicId: "AB23CD45",
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

const page: PageDetail = {
  id: "a",
  parentId: null,
  spaceId: "s1",
  title: "支付服务部署手册",
  sortOrder: 0,
  contentJson: "{}",
  contentHtml: "<p>正文</p>",
  contentText: "正文",
  contentMd: "正文",
  createdBy: "u2",
  updatedBy: "u2",
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z"
}

function space(overrides: Partial<Space>): Space {
  return {
    id: "s1",
    name: "支付团队",
    description: "",
    myRole: "editor",
    isDefault: false,
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
    ...overrides
  }
}

function renderView(initialEntry = "/p/a") {
  const router = createMemoryRouter(
    [
      { path: "/p/:pageId", element: <PageView /> },
      { path: "/", element: <div>首页占位</div> }
    ],
    { initialEntries: [initialEntry] }
  )
  return render(<RouterProvider router={router} />)
}

/** 把阅读页放进主区那种滚动容器里：位置保持要靠它找滚动父级。 */
function renderViewInScroller(initialEntry = "/p/a") {
  const router = createMemoryRouter(
    [
      {
        path: "/p/:pageId",
        element: (
          <ScrollHost>
            <PageView />
          </ScrollHost>
        )
      },
      { path: "/p/:pageId/edit", element: <div>编辑页占位</div> },
      { path: "/", element: <div>首页占位</div> }
    ],
    { initialEntries: [initialEntry] }
  )
  return render(<RouterProvider router={router} />)
}

/** 四个整块的正文：块高 100，判定线 24，滚到 250 时落在第 3 块（序号 2）上。 */
function longPage(): PageDetail {
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

/** 索引轨只在 xl（1280px）以上渲染：这里按需翻转断点匹配。 */
function setViewportWide(wide: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: wide,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

const tocContentJson = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "部署" }]
    },
    {
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "配置" }]
    },
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "回滚" }]
    }
  ]
})

function pageWithToc(): PageDetail {
  return {
    ...page,
    contentJson: tocContentJson,
    contentHtml: "<h2>部署</h2><h3>配置</h3><h2>回滚</h2>",
    contentText: "部署\n配置\n回滚"
  }
}

describe("阅读页按空间角色收口写入口", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  beforeEach(() => {
    useAuthStore.setState({
      user: memberUser,
      status: "ready",
      restricted: false
    })
    usePagesStore.setState({
      tree: [],
      spaceId: "s1",
      loading: false,
      error: null,
      expanded: []
    })
    useSpacesStore.setState({
      spaces: [space({ myRole: "editor" })],
      status: "ready",
      error: null,
      currentId: "s1"
    })
    vi.mocked(pagesApi.get).mockResolvedValue(page)
    vi.mocked(pagesApi.tree).mockResolvedValue([])
    vi.mocked(pagesApi.download).mockReset()
  })

  it("viewer 看不到编辑、子页面、删除与移动入口，但能看历史", async () => {
    useSpacesStore.setState({ spaces: [space({ myRole: "viewer" })] })
    renderView()

    expect(await screen.findByText("支付服务部署手册")).toBeInTheDocument()
    expect(screen.getByText("只读成员")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "编辑" })).toBeNull()
    expect(screen.queryByRole("button", { name: "子页面" })).toBeNull()
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull()
    expect(screen.queryByRole("button", { name: "移动到空间" })).toBeNull()
    expect(screen.getByRole("button", { name: "历史" })).toBeInTheDocument()
  })

  it("正文下方是评论区：标题与顶层发表框，0 条时不显数字", async () => {
    const user = userEvent.setup()
    renderView()

    const heading = await screen.findByRole("heading", { name: "评论" })
    const composer = await screen.findByRole("textbox", { name: "发表评论" })
    // 评论区在正文之后，而不是插在页头或侧栏
    const body = document.querySelector(".wiki-content")
    expect(body).not.toBeNull()
    expect(
      body &&
        body.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    // 0 条只显标题：不出现「0」这类赘文案
    expect(heading).toHaveTextContent(/^评论$/)

    expect(composer).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "发表" })).toBeDisabled()
    await user.type(composer, "问一下")
    expect(screen.getByRole("button", { name: "发表" })).toBeEnabled()
  })

  it("viewer 也能下载 .md：走服务端端点，文件名取 Content-Disposition", async () => {
    useSpacesStore.setState({ spaces: [space({ myRole: "viewer" })] })
    const user = userEvent.setup()
    const blobs: Blob[] = []
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (blob: Blob) => {
        blobs.push(blob)
        return "blob:ciki-md"
      }
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    })
    const clicked: HTMLAnchorElement[] = []
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this)
      })
    vi.mocked(pagesApi.download).mockResolvedValue({
      blob: new Blob(["# 支付服务部署手册\n\n正文\n"], {
        type: "text/markdown;charset=utf-8"
      }),
      contentDisposition: `attachment; filename="ciki-page.md"; filename*=UTF-8''${encodeURIComponent("支付服务部署手册.md")}`
    })

    try {
      renderView()
      await screen.findByText("支付服务部署手册")
      // 下载是读动作：只读成员同样看得到入口
      const download = screen.getByRole("button", { name: "下载 .md" })
      expect(download).toBeInTheDocument()

      await user.click(download)

      await waitFor(() => expect(clicked).toHaveLength(1))
      expect(pagesApi.download).toHaveBeenCalledWith("a")
      expect(clicked[0].download).toBe("支付服务部署手册.md")
      expect(await blobs[0].text()).toBe("# 支付服务部署手册\n\n正文\n")
    } finally {
      clickSpy.mockRestore()
      delete (URL as unknown as Record<string, unknown>).createObjectURL
      delete (URL as unknown as Record<string, unknown>).revokeObjectURL
    }
  })

  it("下载失败按既有错误口径提示，不生成文件", async () => {
    useSpacesStore.setState({ spaces: [space({ myRole: "viewer" })] })
    const user = userEvent.setup()
    vi.mocked(pagesApi.download).mockRejectedValue(
      new ApiError(
        404,
        "Not found",
        undefined,
        undefined,
        undefined,
        "/pages/a/download"
      )
    )
    const errorSpy = vi.spyOn(toast, "error")
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click")

    try {
      renderView()
      await screen.findByText("支付服务部署手册")

      await user.click(screen.getByRole("button", { name: "下载 .md" }))

      await waitFor(() => expect(errorSpy).toHaveBeenCalled())
      expect(errorSpy.mock.calls[0][0]).toBe("对象不存在，或已被删除。")
      expect(clickSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
      clickSpy.mockRestore()
    }
  })

  it("挂载时不自己拉页面树，树的加载交给壳层", async () => {
    vi.mocked(pagesApi.tree).mockClear()
    renderView()

    expect(await screen.findByText("支付服务部署手册")).toBeInTheDocument()
    expect(pagesApi.tree).not.toHaveBeenCalled()
  })

  it("editor 有编辑、子页面、删除，并在有别的可编辑空间时显示移动入口", async () => {
    useSpacesStore.setState({
      spaces: [space({ myRole: "editor" }), space({ id: "s2", name: "另一个" })]
    })
    renderView()

    expect(
      await screen.findByRole("link", { name: "编辑" })
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "子页面" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "移动到空间" })
    ).toBeInTheDocument()
  })

  it("只有一个空间时不显示移动到空间", async () => {
    renderView()

    expect(
      await screen.findByRole("link", { name: "编辑" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "移动到空间" })).toBeNull()
  })

  it("站点管理员即使不是空间成员也有全部写入口", async () => {
    useAuthStore.setState({
      user: { ...memberUser, role: "admin" },
      status: "ready",
      restricted: false
    })
    useSpacesStore.setState({ spaces: [space({ myRole: "viewer" })] })
    renderView()

    expect(
      await screen.findByRole("link", { name: "编辑" })
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument()
  })

  it("深链进别的空间的页面时把当前空间切过去", async () => {
    useSpacesStore.setState({
      spaces: [
        space({ myRole: "editor" }),
        space({ id: "s2", name: "另一个" })
      ],
      currentId: "s2"
    })
    renderView()

    await waitFor(() => expect(useSpacesStore.getState().currentId).toBe("s1"))
  })

  it("≥1280px 时正文右侧出现索引轨，条目是原生锚点", async () => {
    setViewportWide(true)
    vi.mocked(pagesApi.get).mockResolvedValue(pageWithToc())
    renderView()

    const nav = await screen.findByRole("navigation", { name: "本页索引" })
    expect(nav).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "部署" })).toHaveAttribute(
      "href",
      "#heading-1"
    )
    expect(screen.getByRole("link", { name: "回滚" })).toHaveAttribute(
      "href",
      "#heading-3"
    )
  })

  it("标题不足 2 条时不渲染索引轨", async () => {
    setViewportWide(true)
    vi.mocked(pagesApi.get).mockResolvedValue({
      ...page,
      contentJson: JSON.stringify({
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "唯一标题" }]
          }
        ]
      }),
      contentHtml: "<h2>唯一标题</h2>"
    })
    renderView()

    await screen.findByRole("heading", { level: 2, name: "唯一标题" })
    expect(screen.queryByRole("navigation", { name: "本页索引" })).toBeNull()
  })

  it("1280px 以下不渲染索引轨", async () => {
    setViewportWide(false)
    vi.mocked(pagesApi.get).mockResolvedValue(pageWithToc())
    renderView()

    await screen.findAllByRole("heading", { level: 2 })
    expect(screen.queryByRole("navigation", { name: "本页索引" })).toBeNull()
  })

  it("带 hash 打开时内容就绪后滚到对应标题一次", async () => {
    setViewportWide(true)
    vi.mocked(pagesApi.get).mockResolvedValue(pageWithToc())
    const spy = vi.spyOn(HTMLElement.prototype, "scrollIntoView")
    renderView("/p/a#heading-2")

    await waitFor(() => expect(spy).toHaveBeenCalled())
    const hits = spy.mock.instances.filter(
      (instance) => (instance as HTMLElement).id === "heading-2"
    )
    expect(hits).toHaveLength(1)
    spy.mockRestore()
  })

  it("从 A 页切到带 hash 的 B 页时仍滚到 B 的对应标题", async () => {
    setViewportWide(true)
    const pageA: PageDetail = {
      ...page,
      id: "a",
      title: "A 页",
      contentJson: tocContentJson,
      contentHtml: "<h2>部署</h2><h3>配置</h3><h2>回滚</h2>"
    }
    const pageB: PageDetail = { ...pageA, id: "b", title: "B 页" }
    vi.mocked(pagesApi.get).mockImplementation((id) =>
      Promise.resolve(id === "b" ? pageB : pageA)
    )
    const router = createMemoryRouter(
      [
        { path: "/p/:pageId", element: <PageView /> },
        { path: "/", element: <div>首页占位</div> }
      ],
      { initialEntries: ["/p/a"] }
    )
    const spy = vi.spyOn(HTMLElement.prototype, "scrollIntoView")
    render(<RouterProvider router={router} />)
    await screen.findByText("A 页")

    // 切页瞬间 contentRoot 还是 A 页的：不能提前记帐，否则新页就绪后不再恢复
    await router.navigate("/p/b#heading-2")
    await screen.findByText("B 页")
    await waitFor(() =>
      expect(
        spy.mock.instances.some(
          (instance) => (instance as HTMLElement).id === "heading-2"
        )
      ).toBe(true)
    )
    spy.mockRestore()
  })

  describe("阅读⇄编辑的位置保持", () => {
    let layout: { restore: () => void } | null = null

    afterEach(() => {
      layout?.restore()
      layout = null
    })

    /** 按「块高 100、视口 600」装布局桩：块顶 = 序号×100 − 容器 scrollTop。 */
    function renderWithLayout(initialEntry = "/p/a") {
      layout = installScrollLayout()
      return renderViewInScroller(initialEntry)
    }

    it("点「编辑」时记下判定线上最近的块", async () => {
      vi.mocked(pagesApi.get).mockResolvedValue(longPage())
      renderWithLayout()
      await screen.findByText("甲")
      const scroller = screen.getByTestId("scroller")
      scroller.scrollTop = 250

      await userEvent.click(screen.getByRole("link", { name: "编辑" }))

      // 块顶：-250 / -150 / -50 / 50；判定线 24 落在第 3 块内（(24+50)/100）
      const anchor = readScrollAnchor("a")
      expect(anchor?.blockIndex).toBe(2)
      expect(anchor?.ratio).toBeCloseTo(0.74)
    })

    it("短文（没滚动）点「编辑」不记位置", async () => {
      vi.mocked(pagesApi.get).mockResolvedValue(longPage())
      renderWithLayout()
      await screen.findByText("甲")

      await userEvent.click(screen.getByRole("link", { name: "编辑" }))

      expect(readScrollAnchor("a")).toBeNull()
    })

    it("从编辑页返回时把同一块送回判定线", async () => {
      vi.mocked(pagesApi.get).mockResolvedValue(longPage())
      rememberScrollAnchor("a", { blockIndex: 2, ratio: 0.5 })
      renderWithLayout()
      await screen.findByText("甲")

      const scroller = screen.getByTestId("scroller")
      // 第 3 块顶 200 + 0.5 × 100 = 250，判定线 24 → 滚到 226，而不是回到顶部
      await waitFor(() => expect(scroller.scrollTop).toBeCloseTo(226))
      // 用完即删：之后的普通访问不会再跳到这个位置
      expect(readScrollAnchor("a")).toBeNull()
    })

    it("URL 带 hash 时让位给 hash 恢复，记忆锚点作废", async () => {
      vi.mocked(pagesApi.get).mockResolvedValue(pageWithToc())
      rememberScrollAnchor("a", { blockIndex: 2, ratio: 0.5 })
      renderWithLayout("/p/a#heading-2")
      await screen.findAllByRole("heading", { level: 2 })

      expect(readScrollAnchor("a")).toBeNull()
      expect(screen.getByTestId("scroller").scrollTop).toBe(0)
    })
  })
})

describe("文章页原地刷新", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  beforeEach(() => {
    useAuthStore.setState({
      user: memberUser,
      status: "ready",
      restricted: false
    })
    usePagesStore.setState({
      tree: [],
      spaceId: "s1",
      loading: false,
      error: null,
      expanded: []
    })
    useSpacesStore.setState({
      spaces: [space({ myRole: "editor" })],
      status: "ready",
      error: null,
      currentId: "s1"
    })
    vi.mocked(pagesApi.get).mockReset()
    vi.mocked(pagesApi.tree).mockReset()
    vi.mocked(pagesApi.get).mockResolvedValue(page)
    vi.mocked(pagesApi.tree).mockResolvedValue([])
  })

  it("点刷新就地重拉详情与页面树，正文更新且编辑器不重建", async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByText("支付服务部署手册")
    const rootBefore = document.querySelector(".wiki-content")
    expect(rootBefore).not.toBeNull()

    vi.mocked(pagesApi.get).mockResolvedValue({
      ...page,
      title: "支付服务部署手册（新版）",
      contentHtml: "<p>新的正文</p>",
      contentText: "新的正文",
      updatedAt: "2020-01-01T00:00:00.000Z"
    })

    await user.click(screen.getByRole("button", { name: "刷新" }))

    expect(
      await screen.findByText("支付服务部署手册（新版）")
    ).toBeInTheDocument()
    expect(await screen.findByText("新的正文")).toBeInTheDocument()
    expect(screen.getByText(/2020-01-01/)).toBeInTheDocument()
    expect(pagesApi.get).toHaveBeenCalledTimes(2)
    expect(pagesApi.tree).toHaveBeenCalledTimes(1)
    // 编辑器实例没被重建：正文根节点还是同一个（不闪、滚动位置不丢）
    expect(document.querySelector(".wiki-content")).toBe(rootBefore)
  })

  it("刷新进行中按钮禁用，重复点击不再发请求", async () => {
    const user = userEvent.setup()
    let release: (detail: PageDetail) => void = () => {}
    vi.mocked(pagesApi.get)
      .mockResolvedValueOnce(page)
      .mockImplementationOnce(
        () =>
          new Promise<PageDetail>((resolve) => {
            release = resolve
          })
      )
    renderView()
    await screen.findByText("支付服务部署手册")

    const button = screen.getByRole("button", { name: "刷新" })
    await user.click(button)
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute("aria-busy", "true")

    await user.click(button)

    release({ ...page, title: "刷新后的标题" })
    await screen.findByText("刷新后的标题")
    expect(button).toBeEnabled()
    expect(pagesApi.get).toHaveBeenCalledTimes(2)
  })

  it("刷新失败时正文保留旧数据，并沿用现有错误提示样式", async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByText("支付服务部署手册")
    vi.mocked(pagesApi.get).mockRejectedValueOnce(new ApiError(500, "boom"))

    await user.click(screen.getByRole("button", { name: "刷新" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("boom")
    expect(screen.getByText("支付服务部署手册")).toBeInTheDocument()
    expect(await screen.findByText("正文")).toBeInTheDocument()
  })

  it("刷新时页面已被别处删除，走现有「页面不存在」处理", async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByText("支付服务部署手册")
    vi.mocked(pagesApi.get).mockRejectedValueOnce(
      new ApiError(404, "Not found")
    )

    await user.click(screen.getByRole("button", { name: "刷新" }))

    expect(await screen.findByText("页面不存在或已删除")).toBeInTheDocument()
  })

  it("切回标签页自动刷新，节流窗口内反复切回不重复拉取", async () => {
    renderView()
    await screen.findByText("支付服务部署手册")
    expect(pagesApi.get).toHaveBeenCalledTimes(1)
    expect(pagesApi.tree).not.toHaveBeenCalled()

    const started = Date.now()
    const now = vi.spyOn(Date, "now").mockReturnValue(started + 11_000)
    document.dispatchEvent(new Event("visibilitychange"))
    await waitFor(() => expect(pagesApi.get).toHaveBeenCalledTimes(2))
    expect(pagesApi.tree).toHaveBeenCalledTimes(1)

    // 同一时间窗口里再切回（两个事件都派发）：不再拉
    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event("focus"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pagesApi.get).toHaveBeenCalledTimes(2)

    // 越过节流窗口后会重新刷新
    now.mockReturnValue(started + 22_000)
    document.dispatchEvent(new Event("visibilitychange"))
    await waitFor(() => expect(pagesApi.get).toHaveBeenCalledTimes(3))
    now.mockRestore()
  })

  it("刷新途中切到别的页面时，旧页的结果不会盖到新页上", async () => {
    const user = userEvent.setup()
    const pageB: PageDetail = { ...page, id: "b", title: "B 页" }
    vi.mocked(pagesApi.get).mockImplementation((id) =>
      Promise.resolve(id === "b" ? pageB : page)
    )
    const router = createMemoryRouter(
      [
        { path: "/p/:pageId", element: <PageView /> },
        { path: "/", element: <div>首页占位</div> }
      ],
      { initialEntries: ["/p/a"] }
    )
    render(<RouterProvider router={router} />)
    await screen.findByText("支付服务部署手册")

    // 刷新请求挂起时切页：结果回来必须被丢弃
    let releaseRefresh: (detail: PageDetail) => void = () => {}
    vi.mocked(pagesApi.get).mockImplementationOnce(
      () =>
        new Promise<PageDetail>((resolve) => {
          releaseRefresh = resolve
        })
    )
    await user.click(screen.getByRole("button", { name: "刷新" }))

    await router.navigate("/p/b")
    await screen.findByText("B 页")

    releaseRefresh({ ...page, title: "A 页的旧结果" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText("A 页的旧结果")).toBeNull()
    expect(screen.getByText("B 页")).toBeInTheDocument()
  })

  it("切页时清掉上一页的刷新报错，并重置自动刷新的节流基准", async () => {
    const user = userEvent.setup()
    const pageB: PageDetail = { ...page, id: "b", title: "B 页" }
    vi.mocked(pagesApi.get).mockImplementation((id) =>
      Promise.resolve(id === "b" ? pageB : page)
    )
    const router = createMemoryRouter(
      [
        { path: "/p/:pageId", element: <PageView /> },
        { path: "/", element: <div>首页占位</div> }
      ],
      { initialEntries: ["/p/a"] }
    )
    render(<RouterProvider router={router} />)
    await screen.findByText("支付服务部署手册")

    // A 页刷新失败：页面上留下这次刷新的报错
    vi.mocked(pagesApi.get).mockRejectedValueOnce(new ApiError(500, "boom"))
    await user.click(screen.getByRole("button", { name: "刷新" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("boom")

    // 切到 B 页：残留报错不能跟过来
    await router.navigate("/p/b")
    await screen.findByText("B 页")
    expect(screen.queryByRole("alert")).toBeNull()

    // 节流基准随换页重置：刚加载好的 B 页，立刻切回标签页不应再拉一次
    const calls = vi.mocked(pagesApi.get).mock.calls.length
    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event("focus"))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(vi.mocked(pagesApi.get).mock.calls.length).toBe(calls)
  })

  it("切页后评论区按新页面重拉，草稿不跟过去", async () => {
    const user = userEvent.setup()
    const pageB: PageDetail = { ...page, id: "b", title: "B 页" }
    vi.mocked(pagesApi.get).mockImplementation((id) =>
      Promise.resolve(id === "b" ? pageB : page)
    )
    const router = createMemoryRouter(
      [
        { path: "/p/:pageId", element: <PageView /> },
        { path: "/", element: <div>首页占位</div> }
      ],
      { initialEntries: ["/p/a"] }
    )
    render(<RouterProvider router={router} />)
    await screen.findByText("支付服务部署手册")
    expect(vi.mocked(commentsApi.list)).toHaveBeenLastCalledWith("a")

    // A 页留半截草稿：评论是跟着页面走的，换页不能把它带过去
    await user.type(
      await screen.findByRole("textbox", { name: "发表评论" }),
      "半截草稿"
    )

    await router.navigate("/p/b")
    await screen.findByText("B 页")
    await waitFor(() =>
      expect(vi.mocked(commentsApi.list)).toHaveBeenLastCalledWith("b")
    )
    expect(screen.getByRole("textbox", { name: "发表评论" })).toHaveValue("")
  })

  it("首屏加载失败后，切回标签页刷新成功即可恢复正文", async () => {
    vi.mocked(pagesApi.get).mockRejectedValueOnce(new ApiError(500, "boom"))
    renderView()
    expect(await screen.findByText("boom")).toBeInTheDocument()
    expect(screen.queryByText("支付服务部署手册")).toBeNull()

    // 越过节流窗口后切回标签页：自动刷新成功，错误段要让位给正文
    const started = Date.now()
    const now = vi.spyOn(Date, "now").mockReturnValue(started + 11_000)
    vi.mocked(pagesApi.get).mockResolvedValue(page)
    document.dispatchEvent(new Event("visibilitychange"))

    expect(await screen.findByText("支付服务部署手册")).toBeInTheDocument()
    expect(screen.queryByText("boom")).toBeNull()
    now.mockRestore()
  })
})
