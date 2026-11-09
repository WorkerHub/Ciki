import { render, screen, waitFor } from "@testing-library/react"
import { createMemoryRouter, RouterProvider } from "react-router"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Me, PageDetail, Space } from "@/lib/api"
import { PageView } from "@/pages/PageView"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"
import { useAuthStore } from "@/stores/auth"
import { usePagesStore } from "@/stores/pages"
import { useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    pagesApi: {
      ...actual.pagesApi,
      get: vi.fn(),
      tree: vi.fn()
    }
  }
})

const { pagesApi } = await import("@/lib/api")

const memberUser: Me = {
  id: "u1",
  publicId: "AB23CD45",
  username: "小明",
  avatarUrl: null,
  email: "u1@example.com",
  role: "user",
  approvalStatus: "approved",
  createdAt: "2026-11-08T00:00:00.000Z",
  twofa: { totpEnabled: false, passkeyEnabled: false, passkeyCount: 0 }
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

    await screen.findByRole("heading", { level: 2 })
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
})
