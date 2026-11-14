import { render, screen } from "@testing-library/react"
import { createMemoryRouter, RouterProvider } from "react-router"
import { beforeEach, describe, expect, it } from "vitest"
import { SpaceRoute } from "@/components/SpaceRoute"
import type { Space } from "@/lib/api"
import { useSpacesStore } from "@/stores/spaces"

function space(overrides: Partial<Space>): Space {
  return {
    id: 1,
    slug: "default",
    name: "默认空间",
    description: "",
    myRole: "editor",
    isDefault: true,
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
    ...overrides
  }
}

const defaultSpace = space({})
const teamSpace = space({
  id: 2,
  slug: "pay-team",
  name: "支付团队",
  isDefault: false
})

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/s/:slug",
        element: <SpaceRoute />,
        children: [
          { index: true, element: <div>空间首页占位</div> },
          { path: "trash", element: <div>回收站占位</div> }
        ]
      }
    ],
    { initialEntries: [path] }
  )
  return { router, ...render(<RouterProvider router={router} />) }
}

describe("空间 slug 路由网关", () => {
  beforeEach(() => {
    useSpacesStore.setState({
      spaces: [defaultSpace, teamSpace],
      status: "ready",
      error: null,
      currentId: 1
    })
  })

  it("slug 命中时把当前空间切过去，再渲染子页", () => {
    renderAt("/s/pay-team/trash")

    expect(useSpacesStore.getState().currentId).toBe(2)
    expect(screen.getByText("回收站占位")).toBeInTheDocument()
  })

  it("空间首页与子页共用同一层：index 也认 slug", () => {
    renderAt("/s/pay-team")

    expect(useSpacesStore.getState().currentId).toBe(2)
    expect(screen.getByText("空间首页占位")).toBeInTheDocument()
  })

  it("未知 slug 按不存在处理，不渲染子页", () => {
    renderAt("/s/gone/trash")

    expect(screen.getByText("页面不存在")).toBeInTheDocument()
    expect(screen.queryByText("回收站占位")).toBeNull()
    // 空间没有被改动
    expect(useSpacesStore.getState().currentId).toBe(1)
  })

  it("空间列表还在路上时只给骨架，不提前渲染子页", () => {
    useSpacesStore.setState({
      spaces: [],
      status: "loading",
      error: null,
      currentId: null
    })
    renderAt("/s/pay-team/trash")

    expect(screen.getByLabelText("空间加载中")).toBeInTheDocument()
    expect(screen.queryByText("回收站占位")).toBeNull()
  })
})
