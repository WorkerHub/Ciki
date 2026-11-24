import { act, render, waitFor } from "@testing-library/react"
import { createMemoryRouter, RouterProvider } from "react-router"
import { beforeEach, describe, expect, it } from "vitest"
import type { PageNode, Space } from "@/lib/api"
import { changeLanguage } from "@/i18n"
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
    usePagesStore.setState({ tree: mockTree, loading: false })
    useSpacesStore.setState({ spaces: mockSpaces, status: "ready" })
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
})
