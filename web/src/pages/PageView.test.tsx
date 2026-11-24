import { fireEvent, render, screen, waitFor } from "@testing-library/react"
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
import { i18n } from "@/i18n"
import * as scrollAnchor from "@/lib/scroll-anchor"
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
    // 评论区在阅读页里会真的调接口：五个方法一并替掉，免得用例误触真实请求
    commentsApi: {
      ...actual.commentsApi,
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      preview: vi.fn()
    }
  }
})

const { pagesApi, commentsApi } = await import("@/lib/api")

// 评论区的列表请求在阅读页里真实存在：默认给空列表，免得每个用例都去打网络
beforeEach(() => {
  vi.mocked(commentsApi.list).mockResolvedValue({ total: 0, threads: [] })
})

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

const page: PageDetail = {
  id: 1,
  parentId: null,
  spaceId: 1,
  title: "支付服务部署手册",
  sortOrder: 0,
  contentHtml: "<p>正文</p>",
  contentText: "正文",
  contentMd: "正文",
  createdBy: 2,
  updatedBy: 2,
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z",
  createdByName: "张三",
  createdByAvatarUrl: "/avatars/zhangsan.png",
  updatedByName: "张三",
  updatedByAvatarUrl: "/avatars/zhangsan.png"
}

function space(overrides: Partial<Space>): Space {
  return {
    id: 1,
    slug: "pay-team",
    name: "支付团队",
    description: "",
    myRole: "editor",
    isDefault: false,
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
    ...overrides
  }
}

function renderView(initialEntry = "/p/1") {
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
function renderViewInScroller(initialEntry = "/p/1") {
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

function pageWithToc(): PageDetail {
  return {
    ...page,
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
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })
    useSpacesStore.setState({
      spaces: [space({ myRole: "editor" })],
      status: "ready",
      error: null,
      currentId: 1
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
    expect(screen.queryByRole("button", { name: "移动" })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "更多" }))
    expect(
      await screen.findByRole("menuitem", { name: "历史" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("menuitem", { name: "下载 .md" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "移动" })).toBeNull()
    expect(screen.queryByRole("menuitem", { name: "删除" })).toBeNull()
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
      await user.click(screen.getByRole("button", { name: "更多" }))
      const download = await screen.findByRole("menuitem", { name: "下载 .md" })
      expect(download).toBeInTheDocument()

      await user.click(download)

      await waitFor(() => expect(clicked).toHaveLength(1))
      expect(pagesApi.download).toHaveBeenCalledWith(1)
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

      await user.click(screen.getByRole("button", { name: "更多" }))
      await user.click(
        await screen.findByRole("menuitem", { name: "下载 .md" })
      )

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

  it("editor 有编辑、子页面、删除与移动入口", async () => {
    const user = userEvent.setup()
    useSpacesStore.setState({
      spaces: [
        space({ myRole: "editor" }),
        space({ id: 2, slug: "other", name: "另一个" })
      ]
    })
    renderView()

    expect(
      await screen.findByRole("link", { name: "编辑" })
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "子页面" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "更多" }))
    expect(
      await screen.findByRole("menuitem", { name: "移动" })
    ).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "删除" })).toBeInTheDocument()
  })

  it("只有一个空间时也给移动入口（同空间改父页面）", async () => {
    const user = userEvent.setup()
    renderView()

    expect(
      await screen.findByRole("link", { name: "编辑" })
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "更多" }))
    expect(
      await screen.findByRole("menuitem", { name: "移动" })
    ).toBeInTheDocument()
  })

  it("站点管理员即使不是空间成员也有全部写入口", async () => {
    const user = userEvent.setup()
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
    await user.click(screen.getByRole("button", { name: "更多" }))
    expect(
      await screen.findByRole("menuitem", { name: "删除" })
    ).toBeInTheDocument()
  })

  it("深链进别的空间的页面时把当前空间切过去", async () => {
    useSpacesStore.setState({
      spaces: [
        space({ myRole: "editor" }),
        space({ id: 2, slug: "other", name: "另一个" })
      ],
      currentId: 2
    })
    renderView()

    await waitFor(() => expect(useSpacesStore.getState().currentId).toBe(1))
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
    const spy = vi.spyOn(scrollAnchor, "scrollToHeading")
    const scrollIntoViewSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView")
    renderView("/p/1#heading-2")

    await waitFor(() => expect(spy).toHaveBeenCalled())
    const hits = spy.mock.calls.filter(([target]) => target.id === "heading-2")
    expect(hits).toHaveLength(1)
    expect(hits[0][1]).toEqual({ behavior: "auto" })
    expect(scrollIntoViewSpy).not.toHaveBeenCalled()
    spy.mockRestore()
    scrollIntoViewSpy.mockRestore()
  })

  it("从 A 页切到带 hash 的 B 页时仍滚到 B 的对应标题", async () => {
    setViewportWide(true)
    const pageA: PageDetail = {
      ...page,
      id: 1,
      title: "A 页",
      contentHtml: "<h2>部署</h2><h3>配置</h3><h2>回滚</h2>"
    }
    const pageB: PageDetail = { ...pageA, id: 2, title: "B 页" }
    vi.mocked(pagesApi.get).mockImplementation((id) =>
      Promise.resolve(id === 2 ? pageB : pageA)
    )
    const router = createMemoryRouter(
      [
        { path: "/p/:pageId", element: <PageView /> },
        { path: "/", element: <div>首页占位</div> }
      ],
      { initialEntries: ["/p/1"] }
    )
    const spy = vi.spyOn(scrollAnchor, "scrollToHeading")
    const scrollIntoViewSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView")
    render(<RouterProvider router={router} />)
    await screen.findByText("A 页")

    // 切页瞬间 contentRoot 还是 A 页的：不能提前记帐，否则新页就绪后不再恢复
    await router.navigate("/p/2#heading-2")
    await screen.findByText("B 页")
    await waitFor(() =>
      expect(spy.mock.calls.some(([target]) => target.id === "heading-2")).toBe(
        true
      )
    )
    expect(scrollIntoViewSpy).not.toHaveBeenCalled()
    spy.mockRestore()
    scrollIntoViewSpy.mockRestore()
  })

  describe("阅读⇄编辑的位置保持", () => {
    let layout: { restore: () => void } | null = null

    afterEach(() => {
      layout?.restore()
      layout = null
    })

    /** 按「块高 100、视口 600」装布局桩：块顶 = 序号×100 − 容器 scrollTop。 */
    function renderWithLayout(initialEntry = "/p/1") {
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
      const anchor = readScrollAnchor(1)
      expect(anchor?.blockIndex).toBe(2)
      expect(anchor?.ratio).toBeCloseTo(0.74)
    })

    it("短文（没滚动）点「编辑」不记位置", async () => {
      vi.mocked(pagesApi.get).mockResolvedValue(longPage())
      renderWithLayout()
      await screen.findByText("甲")

      await userEvent.click(screen.getByRole("link", { name: "编辑" }))

      expect(readScrollAnchor(1)).toBeNull()
    })

    it("从编辑页返回时把同一块送回判定线", async () => {
      vi.mocked(pagesApi.get).mockResolvedValue(longPage())
      rememberScrollAnchor(1, { blockIndex: 2, ratio: 0.5 })
      renderWithLayout()
      await screen.findByText("甲")

      const scroller = screen.getByTestId("scroller")
      // 第 3 块顶 200 + 0.5 × 100 = 250，判定线 24 → 滚到 226，而不是回到顶部
      await waitFor(() => expect(scroller.scrollTop).toBeCloseTo(226))
      // 用完即删：之后的普通访问不会再跳到这个位置
      expect(readScrollAnchor(1)).toBeNull()
    })

    it("URL 带 hash 时让位给 hash 恢复，记忆锚点作废", async () => {
      vi.mocked(pagesApi.get).mockResolvedValue(pageWithToc())
      rememberScrollAnchor(1, { blockIndex: 2, ratio: 0.5 })
      renderWithLayout("/p/1#heading-2")
      await screen.findAllByRole("heading", { level: 2 })

      expect(readScrollAnchor(1)).toBeNull()
      // 让位给 hash 恢复（heading-2 顶 100，判定线 24 → 滚到 76），而不是编辑记忆锚点的 226
      expect(screen.getByTestId("scroller").scrollTop).toBeCloseTo(76)
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
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })
    useSpacesStore.setState({
      spaces: [space({ myRole: "editor" })],
      status: "ready",
      error: null,
      currentId: 1
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
    const pageB: PageDetail = { ...page, id: 2, title: "B 页" }
    vi.mocked(pagesApi.get).mockImplementation((id) =>
      Promise.resolve(id === 2 ? pageB : page)
    )
    const router = createMemoryRouter(
      [
        { path: "/p/:pageId", element: <PageView /> },
        { path: "/", element: <div>首页占位</div> }
      ],
      { initialEntries: ["/p/1"] }
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

    await router.navigate("/p/2")
    await screen.findByText("B 页")

    releaseRefresh({ ...page, title: "A 页的旧结果" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText("A 页的旧结果")).toBeNull()
    expect(screen.getByText("B 页")).toBeInTheDocument()
  })

  it("切页时清掉上一页的刷新报错，并重置自动刷新的节流基准", async () => {
    const user = userEvent.setup()
    const pageB: PageDetail = { ...page, id: 2, title: "B 页" }
    vi.mocked(pagesApi.get).mockImplementation((id) =>
      Promise.resolve(id === 2 ? pageB : page)
    )
    const router = createMemoryRouter(
      [
        { path: "/p/:pageId", element: <PageView /> },
        { path: "/", element: <div>首页占位</div> }
      ],
      { initialEntries: ["/p/1"] }
    )
    render(<RouterProvider router={router} />)
    await screen.findByText("支付服务部署手册")

    // A 页刷新失败：页面上留下这次刷新的报错
    vi.mocked(pagesApi.get).mockRejectedValueOnce(new ApiError(500, "boom"))
    await user.click(screen.getByRole("button", { name: "刷新" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("boom")

    // 切到 B 页：残留报错不能跟过来
    await router.navigate("/p/2")
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
    const pageB: PageDetail = { ...page, id: 2, title: "B 页" }
    vi.mocked(pagesApi.get).mockImplementation((id) =>
      Promise.resolve(id === 2 ? pageB : page)
    )
    const router = createMemoryRouter(
      [
        { path: "/p/:pageId", element: <PageView /> },
        { path: "/", element: <div>首页占位</div> }
      ],
      { initialEntries: ["/p/1"] }
    )
    render(<RouterProvider router={router} />)
    await screen.findByText("支付服务部署手册")
    expect(vi.mocked(commentsApi.list)).toHaveBeenLastCalledWith(1)

    // A 页留半截草稿：评论是跟着页面走的，换页不能把它带过去
    await user.type(
      await screen.findByRole("textbox", { name: "发表评论" }),
      "半截草稿"
    )

    await router.navigate("/p/2")
    await screen.findByText("B 页")
    await waitFor(() =>
      expect(vi.mocked(commentsApi.list)).toHaveBeenLastCalledWith(2)
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

/** 旧 UUID 地址不再识别：数字 id 之外的任何形态都按「页面不存在」处理。 */
describe("页面地址只认数字 id", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  it("旧 UUID 地址直接说不存在，且一次接口都不打", async () => {
    vi.mocked(pagesApi.get).mockClear()
    renderView("/p/0f3c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b")

    expect(await screen.findByText("页面不存在或已删除")).toBeInTheDocument()
    expect(pagesApi.get).not.toHaveBeenCalled()
  })

  it("非正整数（0、负数、小数）同样按不存在处理", async () => {
    vi.mocked(pagesApi.get).mockClear()
    renderView("/p/0")

    expect(await screen.findByText("页面不存在或已删除")).toBeInTheDocument()
    expect(pagesApi.get).not.toHaveBeenCalled()
  })
})

/** 英文界面：头部动作、空页提示、删除确认与不存在页全走 locale。 */
describe("阅读页：英文界面", () => {
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
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })
    useSpacesStore.setState({
      spaces: [space({ myRole: "editor" })],
      status: "ready",
      error: null,
      currentId: 1
    })
    vi.mocked(pagesApi.get).mockResolvedValue(page)
    vi.mocked(pagesApi.tree).mockResolvedValue([])
    vi.mocked(pagesApi.download).mockReset()
  })

  it("头部动作、署名时间都是英文，中文一个字不留", async () => {
    await i18n.changeLanguage("en")
    renderView()

    expect(await screen.findByText("支付服务部署手册")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Edit" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Subpage" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "More" }))
    expect(
      await screen.findByRole("menuitem", { name: "Move" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("menuitem", { name: "Download .md" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("menuitem", { name: "History" })
    ).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument()
    expect(screen.getByText(/^Created /)).toBeInTheDocument()
    expect(screen.queryByText(/^创建于/)).toBeNull()
    expect(screen.queryByText(/^更新于/)).toBeNull()
  })

  it("空页提示与删除确认框也是英文", async () => {
    await i18n.changeLanguage("en")
    vi.mocked(pagesApi.get).mockResolvedValue({ ...page, contentHtml: "  " })
    renderView()

    expect(
      await screen.findByText(/This page is still empty/)
    ).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "Start editing" })
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "More" }))
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Delete" })
    )
    expect(
      await screen.findByText("Delete “支付服务部署手册”?")
    ).toBeInTheDocument()
    expect(screen.getByText(/will be moved to the trash/)).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Move to trash" })
    ).toBeInTheDocument()
  })

  it("新建子页面与移动空间两个对话框也是英文", async () => {
    await i18n.changeLanguage("en")
    useSpacesStore.setState({
      spaces: [
        space({ myRole: "editor" }),
        space({ id: 2, slug: "ops", name: "Ops" })
      ],
      status: "ready",
      error: null,
      currentId: 1
    })
    renderView()

    await userEvent.click(
      await screen.findByRole("button", { name: "Subpage" })
    )
    expect(await screen.findByText("New page")).toBeInTheDocument()
    expect(
      screen.getByText("It will be created under “支付服务部署手册”.")
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Create and edit" })
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))

    await userEvent.click(screen.getByRole("button", { name: "More" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Move" }))
    expect(
      await screen.findByText("Move “支付服务部署手册”")
    ).toBeInTheDocument()
    expect(
      screen.getByText(/moves together with its subpages/)
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Target space")).toBeInTheDocument()
    expect(screen.getByLabelText("Parent page")).toBeInTheDocument()
  })

  it("页面不存在时给英文空态", async () => {
    await i18n.changeLanguage("en")
    renderView("/p/0")

    expect(
      await screen.findByText("Page not found or deleted")
    ).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "Back to home" })
    ).toBeInTheDocument()
  })
})

describe("阅读页标题下署名行", () => {
  beforeEach(() => {
    vi.mocked(pagesApi.tree).mockResolvedValue([])
    vi.mocked(pagesApi.download).mockReset()
    useSpacesStore.setState({
      spaces: [space({ myRole: "editor" })],
      status: "ready",
      error: null,
      currentId: 1
    })
  })

  it("新建未编辑：只显示创建段，不显示编辑段，带创建者头像与日期", async () => {
    vi.mocked(pagesApi.get).mockResolvedValue({
      ...page,
      createdByName: "张三",
      createdByAvatarUrl: "/avatars/zhangsan.png",
      updatedByName: "张三",
      updatedByAvatarUrl: "/avatars/zhangsan.png",
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-08T00:00:00.000Z"
    })
    renderView()

    expect(await screen.findByText("支付服务部署手册")).toBeInTheDocument()
    expect(screen.getByText("张三")).toBeInTheDocument()
    expect(screen.getByText("创建于 2026-11-08")).toBeInTheDocument()
    expect(screen.queryByText(/最后编辑于/)).toBeNull()
    expect(screen.queryByText("·")).toBeNull()
  })

  it("编辑后：显示创建者与最后编辑者，中间带点号分隔，头像各自显示", async () => {
    vi.mocked(pagesApi.get).mockResolvedValue({
      ...page,
      createdByName: "张三",
      createdByAvatarUrl: "/avatars/zhangsan.png",
      updatedByName: "李四",
      updatedByAvatarUrl: "/avatars/lisi.png",
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-09T03:00:00.000Z"
    })
    renderView()

    expect(await screen.findByText("支付服务部署手册")).toBeInTheDocument()
    expect(screen.getByText("张三")).toBeInTheDocument()
    expect(screen.getByText("创建于 2026-11-08")).toBeInTheDocument()
    expect(screen.getByText("·")).toBeInTheDocument()
    expect(screen.getByText("李四")).toBeInTheDocument()
    expect(screen.getByText("最后编辑于 2026-11-09")).toBeInTheDocument()
  })

  it("文档署名行创建者与最后编辑者的头像与用户名均跳转到 /users/:id（含 Agent）", async () => {
    vi.mocked(pagesApi.get).mockResolvedValue({
      ...page,
      createdBy: 10,
      createdById: 10,
      createdByName: "张三",
      createdByAvatarUrl: "/avatars/zhangsan.png",
      createdByIsAgent: false,
      updatedBy: 20,
      updatedById: 20,
      updatedByName: "agent-bot",
      updatedByAvatarUrl: "/avatars/bot.png",
      updatedByIsAgent: true,
      updatedByOwnerName: "Alice",
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-09T03:00:00.000Z"
    })
    renderView()

    await screen.findByText("支付服务部署手册")

    const zhangsanLinks = screen.getAllByRole("link", { name: "张三" })
    expect(zhangsanLinks.length).toBeGreaterThanOrEqual(1)
    expect(
      zhangsanLinks.some((l) => l.getAttribute("href") === "/users/10")
    ).toBe(true)

    const botLinks = screen.getAllByRole("link", { name: "agent-bot" })
    expect(botLinks.length).toBeGreaterThanOrEqual(1)
    expect(botLinks.some((l) => l.getAttribute("href") === "/users/20")).toBe(
      true
    )
  })

  it("createdByName 为 null 时不显示创建段，若已编辑仅显示最后编辑段", async () => {
    vi.mocked(pagesApi.get).mockResolvedValue({
      ...page,
      createdByName: null,
      createdByAvatarUrl: null,
      updatedByName: "李四",
      updatedByAvatarUrl: "/avatars/lisi.png",
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-09T03:00:00.000Z"
    })
    renderView()

    expect(await screen.findByText("支付服务部署手册")).toBeInTheDocument()
    expect(screen.queryByText(/创建于/)).toBeNull()
    expect(screen.queryByText("·")).toBeNull()
    expect(screen.getByText("李四")).toBeInTheDocument()
    expect(screen.getByText("最后编辑于 2026-11-09")).toBeInTheDocument()
  })

  it("两段皆无（createdByName 为 null 且未编辑）：整行不渲染", async () => {
    vi.mocked(pagesApi.get).mockResolvedValue({
      ...page,
      createdByName: null,
      createdByAvatarUrl: null,
      updatedByName: null,
      updatedByAvatarUrl: null,
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-08T00:00:00.000Z"
    })
    renderView()

    expect(await screen.findByText("支付服务部署手册")).toBeInTheDocument()
    expect(screen.queryByText(/创建于/)).toBeNull()
    expect(screen.queryByText(/最后编辑于/)).toBeNull()
    expect(screen.queryByText("·")).toBeNull()
    expect(screen.queryByText(/更新于/)).toBeNull()
  })

  it("两段皆无但为只读成员（viewer）：不显示署名段，但仍显示只读成员徽标", async () => {
    useSpacesStore.setState({ spaces: [space({ myRole: "viewer" })] })
    vi.mocked(pagesApi.get).mockResolvedValue({
      ...page,
      createdByName: null,
      createdByAvatarUrl: null,
      updatedByName: null,
      updatedByAvatarUrl: null,
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-08T00:00:00.000Z"
    })
    renderView()

    expect(await screen.findByText("支付服务部署手册")).toBeInTheDocument()
    expect(screen.getByText("只读成员")).toBeInTheDocument()
    expect(screen.queryByText(/创建于/)).toBeNull()
    expect(screen.queryByText(/最后编辑于/)).toBeNull()
  })

  it("已注销用户作为创建者时正常回落显示", async () => {
    vi.mocked(pagesApi.get).mockResolvedValue({
      ...page,
      createdByName: "已注销用户",
      createdByAvatarUrl: null,
      updatedByName: "李四",
      updatedByAvatarUrl: null,
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-09T03:00:00.000Z"
    })
    renderView()

    expect(await screen.findByText("支付服务部署手册")).toBeInTheDocument()
    expect(screen.getByText("已注销用户")).toBeInTheDocument()
    expect(screen.getByText("创建于 2026-11-08")).toBeInTheDocument()
    expect(screen.getByText("李四")).toBeInTheDocument()
    expect(screen.getByText("最后编辑于 2026-11-09")).toBeInTheDocument()
  })

  it("当创建者或最后编辑者是 Agent 时，署名旁展示 Agent 徽标且不展示 owner 名字", async () => {
    vi.mocked(pagesApi.get).mockResolvedValue({
      ...page,
      createdByName: "deploy-bot",
      createdByAvatarUrl: null,
      createdByIsAgent: true,
      updatedByName: "sync-agent",
      updatedByAvatarUrl: null,
      updatedByIsAgent: true,
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-09T03:00:00.000Z"
    })
    renderView()

    expect(await screen.findByText("deploy-bot")).toBeInTheDocument()
    expect(screen.getByText("sync-agent")).toBeInTheDocument()
    const badges = screen.getAllByText("Agent")
    expect(badges).toHaveLength(2)
  })

  it("当创建者是带 ownerName 的 Agent 时，署名行只留名字与 Agent 小标记（去括号后缀），悬停/聚焦头像展示「{ownerName} 的 Agent」", async () => {
    vi.mocked(pagesApi.get).mockResolvedValue({
      ...page,
      createdByName: "deploy-bot",
      createdByAvatarUrl: null,
      createdByIsAgent: true,
      createdByOwnerName: "Alice",
      updatedByName: null,
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-08T00:00:00.000Z"
    })
    renderView()

    expect(await screen.findByText("deploy-bot")).toBeInTheDocument()
    expect(screen.queryByText(/（Alice 的 Agent）/)).toBeNull()
    expect(screen.queryByText(/(Alice's Agent)/)).toBeNull()
    expect(screen.getByText("Agent")).toBeInTheDocument()

    // N1: 头像触发器 button aria-label 为 username
    const trigger = screen.getByRole("button", { name: "deploy-bot" })
    // N2: 悬停（hover/pointerMove）与键盘聚焦均能触发同一提示
    fireEvent.pointerMove(trigger)
    expect(await screen.findByText("Alice 的 Agent")).toBeInTheDocument()
    fireEvent.pointerLeave(trigger)

    fireEvent.focus(trigger)
    expect(await screen.findByText("Alice 的 Agent")).toBeInTheDocument()
  })

  it("当创建者是 Agent 但 owner 已注销（ownerName 为 null）时，悬停/聚焦头像回落为「已注销用户的 Agent」", async () => {
    vi.mocked(pagesApi.get).mockResolvedValue({
      ...page,
      createdByName: "deploy-bot",
      createdByAvatarUrl: null,
      createdByIsAgent: true,
      createdByOwnerName: null,
      updatedByName: null,
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-08T00:00:00.000Z"
    })
    renderView()

    expect(await screen.findByText("deploy-bot")).toBeInTheDocument()
    expect(screen.getByText("Agent")).toBeInTheDocument()

    const trigger = screen.getByRole("button", { name: "deploy-bot" })
    fireEvent.pointerMove(trigger)
    expect(await screen.findByText("已注销用户的 Agent")).toBeInTheDocument()
  })

  it("当创建者为真人作者时，不显示 Agent 标记，头像无 Tooltip 悬停提示", async () => {
    vi.mocked(pagesApi.get).mockResolvedValue({
      ...page,
      createdByName: "张三",
      createdByAvatarUrl: null,
      createdByIsAgent: false,
      createdByOwnerName: "Alice",
      updatedByName: null,
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-08T00:00:00.000Z"
    })
    renderView()

    expect(await screen.findByText("张三")).toBeInTheDocument()
    expect(screen.queryByText("Agent")).toBeNull()
    // 真人作者直接渲染 UserAvatar，无 button 触发器
    expect(screen.queryByRole("button", { name: "张三" })).toBeNull()
  })

  it("英文环境下展示 Created 与 Last edited", async () => {
    await i18n.changeLanguage("en")
    vi.mocked(pagesApi.get).mockResolvedValue({
      ...page,
      createdByName: "Alice",
      createdByAvatarUrl: null,
      updatedByName: "Bob",
      updatedByAvatarUrl: null,
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-09T03:00:00.000Z"
    })
    renderView()

    expect(await screen.findByText("支付服务部署手册")).toBeInTheDocument()
    expect(screen.getByText("Alice")).toBeInTheDocument()
    expect(screen.getByText(/^Created /)).toBeInTheDocument()
    expect(screen.getByText("·")).toBeInTheDocument()
    expect(screen.getByText("Bob")).toBeInTheDocument()
    expect(screen.getByText(/^Last edited /)).toBeInTheDocument()
    expect(screen.queryByText(/创建于/)).toBeNull()
    expect(screen.queryByText(/最后编辑于/)).toBeNull()
  })

  it("英文环境下 Agent 作者头像提示展示「{owner}'s Agent」，注销回落为「已注销用户的 Agent」", async () => {
    await i18n.changeLanguage("en")
    vi.mocked(pagesApi.get).mockResolvedValue({
      ...page,
      createdByName: "deploy-bot",
      createdByAvatarUrl: null,
      createdByIsAgent: true,
      createdByOwnerName: "Alice",
      updatedByName: "sync-agent",
      updatedByAvatarUrl: null,
      updatedByIsAgent: true,
      updatedByOwnerName: null,
      createdAt: "2026-11-08T00:00:00.000Z",
      updatedAt: "2026-11-09T03:00:00.000Z"
    })
    renderView()

    expect(await screen.findByText("deploy-bot")).toBeInTheDocument()
    expect(screen.getByText("sync-agent")).toBeInTheDocument()

    const createdTrigger = screen.getByRole("button", { name: "deploy-bot" })
    fireEvent.pointerMove(createdTrigger)
    expect(await screen.findByText("Alice's Agent")).toBeInTheDocument()

    // S1: 英文下 owner 为 null 时，回落为中文「已注销用户的 Agent」与后端 DELETED_AUTHOR_NAME 一致
    const updatedTrigger = screen.getByRole("button", { name: "sync-agent" })
    fireEvent.focus(updatedTrigger)
    expect(await screen.findByText("已注销用户的 Agent")).toBeInTheDocument()
  })
})

describe("阅读页回到顶部按钮集成", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh")
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia
    useAuthStore.setState({
      user: memberUser,
      status: "ready",
      restricted: false
    })
    usePagesStore.setState({
      tree: [],
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })
    useSpacesStore.setState({
      spaces: [space({ myRole: "editor" })],
      status: "ready",
      error: null,
      currentId: 1
    })
    vi.mocked(pagesApi.get).mockResolvedValue(longPage())
    vi.mocked(pagesApi.tree).mockResolvedValue([])
    vi.mocked(pagesApi.download).mockReset()
  })

  it("长页面下滑超过一屏时回到顶部按钮出现，点击平滑回顶", async () => {
    const { container } = renderViewInScroller()
    const scroller = container.querySelector<HTMLElement>(
      '[data-testid="scroller"]'
    )!

    Object.defineProperty(scroller, "clientHeight", {
      value: 600,
      configurable: true
    })
    Object.defineProperty(scroller, "scrollHeight", {
      value: 2400,
      configurable: true
    })
    scroller.scrollTo = vi.fn()

    expect(await screen.findByText("支付服务部署手册")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "回到顶部" })
    ).not.toBeInTheDocument()

    scroller.scrollTop = 700
    scroller.dispatchEvent(new Event("scroll"))

    const button = await screen.findByRole("button", { name: "回到顶部" })
    expect(button).toBeInTheDocument()

    await userEvent.click(button)
    expect(scroller.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: "smooth"
    })
  })

  it("滚到底部时回到顶部按钮淡出让位，发表评论不被劫持，离开底部恢复显示", async () => {
    vi.mocked(commentsApi.create).mockResolvedValue({
      id: 101,
      parentId: null,
      authorId: 1,
      authorName: "小明",
      authorAvatarUrl: null,
      bodyMd: "测试评论内容",
      html: "<p>测试评论内容</p>",
      createdAt: "2026-11-22T08:00:00.000Z",
      editedAt: null,
      deletedAt: null,
      canEdit: true,
      canDelete: true
    })

    const { container } = renderViewInScroller()
    const scroller = container.querySelector<HTMLElement>(
      '[data-testid="scroller"]'
    )!

    Object.defineProperty(scroller, "clientHeight", {
      value: 600,
      configurable: true
    })
    Object.defineProperty(scroller, "scrollHeight", {
      value: 2400,
      configurable: true
    })
    scroller.scrollTo = vi.fn()

    // 1. 中间位置（scrollTop = 800，距离底部 2400 - 600 - 800 = 1000 > 96）：回到顶部按钮显现
    scroller.scrollTop = 800
    scroller.dispatchEvent(new Event("scroll"))
    expect(
      await screen.findByRole("button", { name: "回到顶部" })
    ).toBeInTheDocument()

    // 2. 滚到底部（scrollTop = 1800，距离底部 0 <= 96）：回到顶部按钮淡出消失让位
    scroller.scrollTop = 1800
    scroller.dispatchEvent(new Event("scroll"))

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "回到顶部" })
      ).not.toBeInTheDocument()
    })

    // 3. 此时输入评论并点击发表：点击直接落在「发表」按钮上，未被回顶劫持
    const textarea = await screen.findByLabelText("发表评论")
    await userEvent.type(textarea, "测试评论内容")

    const postButton = screen.getByRole("button", { name: "发表" })
    expect(postButton).toBeEnabled()

    await userEvent.click(postButton)

    // 验证：回顶函数 scrollTo 从未被触发（未被劫持）
    expect(scroller.scrollTo).not.toHaveBeenCalled()
    // 验证：发表评论接口被正确调用
    expect(commentsApi.create).toHaveBeenCalledWith(1, {
      bodyMd: "测试评论内容",
      parentId: null
    })

    // 4. 离开底部（向上滚到 scrollTop = 1200，距离底部 600 > 96）：回到顶部按钮恢复显示
    scroller.scrollTop = 1200
    scroller.dispatchEvent(new Event("scroll"))

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "回到顶部" })
      ).toBeInTheDocument()
    })
  })
})

describe("阅读页次要操作收进「更多」菜单", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh")
    useAuthStore.setState({
      user: memberUser,
      status: "ready",
      restricted: false
    })
    usePagesStore.setState({
      tree: [],
      spaceId: 1,
      loading: false,
      error: null,
      expanded: []
    })
    useSpacesStore.setState({
      spaces: [space({ myRole: "editor" })],
      status: "ready",
      error: null,
      currentId: 1
    })
    vi.mocked(pagesApi.get).mockResolvedValue(page)
    vi.mocked(pagesApi.tree).mockResolvedValue([])
    vi.mocked(pagesApi.download).mockReset()
  })

  it("菜单项顺序严格与现行平铺一致（移动、下载 .md、历史、删除），且删除项为红色危险样式", async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByText("支付服务部署手册")

    const moreButton = screen.getByRole("button", { name: "更多" })
    expect(moreButton).toBeInTheDocument()

    await user.click(moreButton)

    const menuItems = await screen.findAllByRole("menuitem")
    expect(menuItems.map((item) => item.textContent?.trim())).toEqual([
      "移动",
      "下载 .md",
      "历史",
      "删除"
    ])

    const deleteItem = screen.getByRole("menuitem", { name: "删除" })
    expect(deleteItem).toHaveAttribute("data-variant", "destructive")
  })

  it("点击移动打开移动对话框，且行为与口径保持不变", async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByText("支付服务部署手册")

    await user.click(screen.getByRole("button", { name: "更多" }))
    await user.click(await screen.findByRole("menuitem", { name: "移动" }))

    expect(
      await screen.findByText("移动「支付服务部署手册」")
    ).toBeInTheDocument()
  })

  it("点击历史打开版本历史弹窗，且行为保持不变", async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByText("支付服务部署手册")

    await user.click(screen.getByRole("button", { name: "更多" }))
    await user.click(await screen.findByRole("menuitem", { name: "历史" }))

    expect(await screen.findByText("版本历史")).toBeInTheDocument()
  })

  it("点击删除打开删除确认弹窗，移入回收站口径不变", async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByText("支付服务部署手册")

    await user.click(screen.getByRole("button", { name: "更多" }))
    await user.click(await screen.findByRole("menuitem", { name: "删除" }))

    expect(
      await screen.findByText("删除「支付服务部署手册」？")
    ).toBeInTheDocument()
    expect(
      screen.getByText("页面与全部子页面会移入回收站，之后可以在回收站里恢复。")
    ).toBeInTheDocument()
  })

  it("原生 DropdownMenu 支持按 Esc 键关闭菜单", async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByText("支付服务部署手册")

    await user.click(screen.getByRole("button", { name: "更多" }))
    expect(
      await screen.findByRole("menuitem", { name: "移动" })
    ).toBeInTheDocument()

    await user.keyboard("{Escape}")
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "移动" })).toBeNull()
    })
  })

  it("只读角色（viewer）更多菜单仅包含「下载 .md」和「历史」，无「移动」和「删除」", async () => {
    const user = userEvent.setup()
    useSpacesStore.setState({ spaces: [space({ myRole: "viewer" })] })
    renderView()
    await screen.findByText("支付服务部署手册")

    await user.click(screen.getByRole("button", { name: "更多" }))

    const menuItems = await screen.findAllByRole("menuitem")
    expect(menuItems.map((item) => item.textContent?.trim())).toEqual([
      "下载 .md",
      "历史"
    ])
    expect(screen.queryByRole("menuitem", { name: "移动" })).toBeNull()
    expect(screen.queryByRole("menuitem", { name: "删除" })).toBeNull()
  })

  it("工具栏容器包含 min-height/min-width 覆盖类，避免移动端 header 规则误伤导致高度不一", async () => {
    renderView()
    await screen.findByText("支付服务部署手册")

    const refreshButton = screen.getByRole("button", { name: "刷新" })
    const editLink = screen.getByRole("link", { name: "编辑" })
    const newChildButton = screen.getByRole("button", { name: "子页面" })
    const moreButton = screen.getByRole("button", { name: "更多" })

    expect(refreshButton).toHaveAttribute("data-size", "icon-sm")
    expect(editLink).toHaveAttribute("data-size", "sm")
    expect(newChildButton).toHaveAttribute("data-size", "sm")
    expect(moreButton).toHaveAttribute("data-size", "icon-sm")

    const toolbar = refreshButton.closest("div")
    expect(toolbar).not.toBeNull()
    expect(toolbar).toHaveClass("[&_[data-slot]]:!min-h-0")
    expect(toolbar).toHaveClass("[&_[data-slot]]:!min-w-0")
    expect(toolbar?.contains(editLink)).toBe(true)
    expect(toolbar?.contains(newChildButton)).toBe(true)
    expect(toolbar?.contains(moreButton)).toBe(true)
  })
})
