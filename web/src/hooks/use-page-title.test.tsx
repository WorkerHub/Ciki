import { act, render, waitFor } from "@testing-library/react"
import { createMemoryRouter, RouterProvider } from "react-router"
import { beforeEach, describe, expect, it } from "vitest"
import { changeLanguage } from "@/i18n"
import type { PageNode, Space } from "@/lib/api"
import { usePagesStore } from "@/stores/pages"
import { useSiteStore } from "@/stores/site"
import { useSpacesStore } from "@/stores/spaces"
import {
  formatDocumentTitle,
  resolveTitle,
  usePageTitle
} from "./use-page-title"

const mockTree: PageNode[] = [
  {
    id: 1,
    title: "团队指南",
    parentId: null,
    sortOrder: 0,
    updatedAt: "2026-11-01T00:00:00.000Z",
    children: [
      {
        id: 2,
        title: "部署规范",
        parentId: 1,
        sortOrder: 0,
        updatedAt: "2026-11-01T00:00:00.000Z",
        children: []
      }
    ]
  },
  {
    id: 3,
    title: "",
    parentId: null,
    sortOrder: 1,
    updatedAt: "2026-11-01T00:00:00.000Z",
    children: []
  }
]

const mockSpaces: Space[] = [
  {
    id: 1,
    slug: "engineering",
    name: "工程团队",
    description: "",
    myRole: "editor",
    isDefault: true,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z"
  },
  {
    id: 2,
    slug: "product%20design",
    name: "产品设计",
    description: "",
    myRole: "viewer",
    isDefault: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z"
  }
]

describe("formatDocumentTitle", () => {
  it("站点设置已加载时拼接「标题 · 站名」", () => {
    expect(formatDocumentTitle("个人资料", "Ciki", true)).toBe(
      "个人资料 · Ciki"
    )
  })

  it("站点设置未加载时只显示标题", () => {
    expect(formatDocumentTitle("个人资料", "Ciki", false)).toBe("个人资料")
  })

  it("站名为空字符串时只显示标题", () => {
    expect(formatDocumentTitle("个人资料", "", true)).toBe("个人资料")
  })

  it("页面标题为空时只显示站名", () => {
    expect(formatDocumentTitle("", "Ciki", true)).toBe("Ciki")
    expect(formatDocumentTitle("", "Ciki", false)).toBe("Ciki")
    expect(formatDocumentTitle("   ", "Ciki", true)).toBe("Ciki")
  })

  it("页面标题与站名均为空时返回空字符串", () => {
    expect(formatDocumentTitle("", "", true)).toBe("")
    expect(formatDocumentTitle("", "", false)).toBe("")
  })
})

describe("resolveTitle 路由映射", () => {
  const dummyT = ((key: string) => `i18n:${key}`) as any

  it("wiki 页面阅读页取树中标题", () => {
    expect(resolveTitle("/p/1", mockTree, mockSpaces, dummyT)).toBe("团队指南")
    expect(resolveTitle("/p/2", mockTree, mockSpaces, dummyT)).toBe("部署规范")
  })

  it("wiki 页面树中标题为空时回落未命名", () => {
    expect(resolveTitle("/p/3", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:page.untitled"
    )
  })

  it("wiki 页面编辑页取树中标题", () => {
    expect(resolveTitle("/p/1/edit", mockTree, mockSpaces, dummyT)).toBe(
      "团队指南"
    )
  })

  it("wiki 页面 id 格式非法时回落 notFound", () => {
    expect(resolveTitle("/p/not-number", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:notFound.title"
    )
    expect(
      resolveTitle("/p/not-number/edit", mockTree, mockSpaces, dummyT)
    ).toBe("i18n:notFound.title")
  })

  it("wiki 页面 id 不在树中时回落 notFound", () => {
    expect(resolveTitle("/p/999", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:notFound.title"
    )
    expect(resolveTitle("/p/999/edit", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:notFound.title"
    )
  })

  it("wiki 页面在目录加载中时返回空字符串（仅显示站名）", () => {
    expect(
      resolveTitle("/p/1", [], mockSpaces, dummyT, {
        pagesLoading: true,
        pagesError: null
      })
    ).toBe("")
    expect(
      resolveTitle("/p/1/edit", [], mockSpaces, dummyT, {
        pagesLoading: true,
        pagesError: null
      })
    ).toBe("")
  })

  it("wiki 页面在目录加载失败时返回空字符串（仅显示站名）", () => {
    expect(
      resolveTitle("/p/1", [], mockSpaces, dummyT, {
        pagesLoading: false,
        pagesError: "网络连接异常"
      })
    ).toBe("")
    expect(
      resolveTitle("/p/1/edit", [], mockSpaces, dummyT, {
        pagesLoading: false,
        pagesError: "网络连接异常"
      })
    ).toBe("")
  })

  it("wiki 页面在目录成功加载后查不到目标才回落 notFound", () => {
    expect(
      resolveTitle("/p/999", mockTree, mockSpaces, dummyT, {
        pagesLoading: false,
        pagesError: null
      })
    ).toBe("i18n:notFound.title")
    expect(
      resolveTitle("/p/999/edit", mockTree, mockSpaces, dummyT, {
        pagesLoading: false,
        pagesError: null
      })
    ).toBe("i18n:notFound.title")
  })

  it("wiki 页面非法 id 即使在加载中也立即回落 notFound", () => {
    expect(
      resolveTitle("/p/not-number", [], mockSpaces, dummyT, {
        pagesLoading: true
      })
    ).toBe("i18n:notFound.title")
    expect(
      resolveTitle("/p/not-number/edit", [], mockSpaces, dummyT, {
        pagesLoading: true
      })
    ).toBe("i18n:notFound.title")
  })

  it("空间首页按 slug 取空间名", () => {
    expect(resolveTitle("/s/engineering", mockTree, mockSpaces, dummyT)).toBe(
      "工程团队"
    )
  })

  it("空间首页百分号编码的 slug 能够正确解码并匹配", () => {
    expect(
      resolveTitle("/s/product%2520design", mockTree, mockSpaces, dummyT)
    ).toBe("产品设计")
  })

  it("空间不存在时回落 notFound", () => {
    expect(resolveTitle("/s/non-existent", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:notFound.title"
    )
  })

  it("空间首页在空间列表加载中或加载失败时返回空字符串（仅显示站名）", () => {
    expect(
      resolveTitle("/s/engineering", mockTree, [], dummyT, {
        spacesStatus: "loading"
      })
    ).toBe("")
    expect(
      resolveTitle("/s/engineering", mockTree, [], dummyT, {
        spacesStatus: "error"
      })
    ).toBe("")
  })

  it("空间首页在空间列表就绪且不存在时才回落 notFound", () => {
    expect(
      resolveTitle("/s/non-existent", mockTree, mockSpaces, dummyT, {
        spacesStatus: "ready"
      })
    ).toBe("i18n:notFound.title")
  })

  it("空间功能区映射到对应页名", () => {
    expect(
      resolveTitle("/s/engineering/search", mockTree, mockSpaces, dummyT)
    ).toBe("i18n:search.title")
    expect(
      resolveTitle("/s/engineering/trash", mockTree, mockSpaces, dummyT)
    ).toBe("i18n:trash.title")
    expect(
      resolveTitle("/s/engineering/settings", mockTree, mockSpaces, dummyT)
    ).toBe("i18n:shell.spaces.settings")
  })

  it("系统页面映射到对应 i18n key", () => {
    expect(resolveTitle("/", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:pageTitle.home"
    )
    expect(resolveTitle("/login", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:pageTitle.login"
    )
    expect(resolveTitle("/register", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:pageTitle.register"
    )
    expect(resolveTitle("/setup", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:pageTitle.setup"
    )
    expect(resolveTitle("/forgot-password", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:auth.forgot.title"
    )
    expect(resolveTitle("/verify-email", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:auth.verify.title"
    )
    expect(resolveTitle("/profile", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:profile.title"
    )
    expect(resolveTitle("/settings", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:settings.title"
    )
    expect(resolveTitle("/about", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:about.title"
    )
    expect(resolveTitle("/users/12", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:user.title"
    )
    expect(resolveTitle("/users/invalid", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:notFound.title"
    )
    expect(resolveTitle("/admin", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:admin.title"
    )
    expect(resolveTitle("/admin/users", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:admin.title"
    )
    expect(resolveTitle("/admin/spaces", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:admin.title"
    )
    expect(resolveTitle("/admin/site", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:admin.title"
    )
    expect(resolveTitle("/admin/security", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:admin.title"
    )
    expect(resolveTitle("/admin/email", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:admin.title"
    )
    expect(resolveTitle("/admin/others", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:admin.title"
    )
  })

  it("未匹配路径回落 notFound", () => {
    expect(
      resolveTitle("/some/unknown/path", mockTree, mockSpaces, dummyT)
    ).toBe("i18n:notFound.title")
    expect(resolveTitle("/admin/unknown", mockTree, mockSpaces, dummyT)).toBe(
      "i18n:notFound.title"
    )
  })
})

function TitleWatcher() {
  usePageTitle()
  return <div>watcher</div>
}

describe("usePageTitle hook 集成", () => {
  beforeEach(async () => {
    await changeLanguage("zh")
    useSiteStore.setState({ name: "Ciki", loaded: true })
    usePagesStore.setState({ tree: mockTree, loading: false, error: null })
    useSpacesStore.setState({
      spaces: mockSpaces,
      status: "ready",
      error: null
    })
  })

  function renderWithRoute(path: string) {
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: <TitleWatcher />
        }
      ],
      { initialEntries: [path] }
    )
    return {
      router,
      ...render(<RouterProvider router={router} />)
    }
  }

  it("挂在根部能随路由切换标题", async () => {
    const { router } = renderWithRoute("/login")
    await waitFor(() => expect(document.title).toBe("登录 · Ciki"))

    await act(async () => {
      await router.navigate("/p/1")
    })
    await waitFor(() => expect(document.title).toBe("团队指南 · Ciki"))

    await act(async () => {
      await router.navigate("/s/engineering")
    })
    await waitFor(() => expect(document.title).toBe("工程团队 · Ciki"))

    await act(async () => {
      await router.navigate("/s/engineering/trash")
    })
    await waitFor(() => expect(document.title).toBe("回收站 · Ciki"))

    await act(async () => {
      await router.navigate("/404-not-found")
    })
    await waitFor(() => expect(document.title).toBe("页面不存在 · Ciki"))
  })

  it("系统管理各分区及裸 /admin 均正确显示系统管理标题，未知子路径回落 404", async () => {
    const { router } = renderWithRoute("/admin/users")
    await waitFor(() => expect(document.title).toBe("系统管理 · Ciki"))

    const partitions = [
      "/admin/spaces",
      "/admin/site",
      "/admin/security",
      "/admin/email",
      "/admin/others",
      "/admin"
    ]
    for (const path of partitions) {
      await act(async () => {
        await router.navigate(path)
      })
      await waitFor(() => expect(document.title).toBe("系统管理 · Ciki"))
    }

    await act(async () => {
      await router.navigate("/admin/not-found-subpath")
    })
    await waitFor(() => expect(document.title).toBe("页面不存在 · Ciki"))
  })

  it("站名未加载时只显示标题，加载后拼接站名", async () => {
    useSiteStore.setState({ name: "Ciki", loaded: false })
    renderWithRoute("/login")

    await waitFor(() => expect(document.title).toBe("登录"))

    act(() => {
      useSiteStore.setState({ name: "我的团队", loaded: true })
    })

    await waitFor(() => expect(document.title).toBe("登录 · 我的团队"))
  })

  it("改名或保存后页面树变更即时同步页签标题", async () => {
    renderWithRoute("/p/1")
    await waitFor(() => expect(document.title).toBe("团队指南 · Ciki"))

    act(() => {
      usePagesStore.setState({
        tree: [
          {
            ...mockTree[0],
            title: "新团队指南"
          }
        ]
      })
    })

    await waitFor(() => expect(document.title).toBe("新团队指南 · Ciki"))
  })

  it("语言切换后同步重算标题", async () => {
    renderWithRoute("/login")
    await waitFor(() => expect(document.title).toBe("登录 · Ciki"))

    await act(async () => {
      await changeLanguage("en")
    })

    await waitFor(() => expect(document.title).toBe("Sign in · Ciki"))
  })

  it("整页刷新真实文档时加载中只显示站名，加载完成后更新为正确标题，全程不显示「页面不存在」", async () => {
    usePagesStore.setState({ tree: [], loading: true, error: null })
    renderWithRoute("/p/1")
    await waitFor(() => expect(document.title).toBe("Ciki"))

    act(() => {
      usePagesStore.setState({ tree: mockTree, loading: false, error: null })
    })
    await waitFor(() => expect(document.title).toBe("团队指南 · Ciki"))
  })

  it("编辑页整页刷新时加载中只显示站名，加载完成后更新为正确标题", async () => {
    usePagesStore.setState({ tree: [], loading: true, error: null })
    renderWithRoute("/p/1/edit")
    await waitFor(() => expect(document.title).toBe("Ciki"))

    act(() => {
      usePagesStore.setState({ tree: mockTree, loading: false, error: null })
    })
    await waitFor(() => expect(document.title).toBe("团队指南 · Ciki"))
  })

  it("目录加载失败时保持只显示站名，不误报「页面不存在」", async () => {
    usePagesStore.setState({
      tree: [],
      loading: false,
      error: "Failed to fetch"
    })
    renderWithRoute("/p/1")
    await waitFor(() => expect(document.title).toBe("Ciki"))
  })

  it("整页刷新空间首页时加载中只显示站名，加载完成后更新为空间名", async () => {
    useSpacesStore.setState({ spaces: [], status: "loading" })
    renderWithRoute("/s/engineering")
    await waitFor(() => expect(document.title).toBe("Ciki"))

    act(() => {
      useSpacesStore.setState({ spaces: mockSpaces, status: "ready" })
    })
    await waitFor(() => expect(document.title).toBe("工程团队 · Ciki"))
  })

  it("空间列表加载失败时保持只显示站名，不误报「页面不存在」", async () => {
    useSpacesStore.setState({ spaces: [], status: "error" })
    renderWithRoute("/s/engineering")
    await waitFor(() => expect(document.title).toBe("Ciki"))
  })

  it("真实不存在的文档 id 加载完成后正确显示「页面不存在」", async () => {
    usePagesStore.setState({ tree: [], loading: true, error: null })
    renderWithRoute("/p/999")
    await waitFor(() => expect(document.title).toBe("Ciki"))

    act(() => {
      usePagesStore.setState({ tree: mockTree, loading: false, error: null })
    })
    await waitFor(() => expect(document.title).toBe("页面不存在 · Ciki"))
  })
})
