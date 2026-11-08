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

function renderView() {
  const router = createMemoryRouter(
    [
      { path: "/p/:pageId", element: <PageView /> },
      { path: "/", element: <div>首页占位</div> }
    ],
    { initialEntries: ["/p/a"] }
  )
  return render(<RouterProvider router={router} />)
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
})
