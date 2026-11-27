import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, useSearchParams } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Space } from "@/lib/api"
import { SearchPage } from "@/pages/SearchPage"
import { useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    searchApi: { ...actual.searchApi, query: vi.fn() }
  }
})

const { searchApi } = await import("@/lib/api")

const defaultSpace: Space = {
  id: 1,
  slug: "default",
  name: "默认空间",
  description: "",
  myRole: "admin",
  isDefault: true,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z"
}

const paySpace: Space = {
  id: 2,
  slug: "pay",
  name: "支付团队",
  description: "",
  myRole: "editor",
  isDefault: false,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z"
}

function LocationMonitor() {
  const [params] = useSearchParams()
  return (
    <div data-testid="search-params">space={params.get("space") ?? "none"}</div>
  )
}

describe("搜索结果的空间标注", () => {
  beforeEach(() => {
    vi.mocked(searchApi.query).mockReset()
    useSpacesStore.setState({
      spaces: [],
      currentId: null,
      status: "ready"
    })
  })

  it("全空间搜索时每条结果显示所属空间名", async () => {
    vi.mocked(searchApi.query).mockResolvedValue({
      query: "部署",
      results: [
        {
          pageId: 1,
          title: "部署手册",
          snippet: "支付服务的部署步骤",
          updatedAt: "2026-11-08T00:00:00.000Z",
          spaceId: 2,
          spaceName: "支付团队"
        },
        {
          pageId: 2,
          title: "默认空间的部署说明",
          snippet: "站点级部署",
          updatedAt: "2026-11-08T00:00:00.000Z",
          spaceId: 1,
          spaceName: "默认空间"
        }
      ]
    })
    render(
      <MemoryRouter initialEntries={["/s/default/search?q=部署"]}>
        <SearchPage />
      </MemoryRouter>
    )

    const links = await screen.findAllByRole("link")
    expect(links).toHaveLength(2)
    expect(links[0]).toHaveTextContent("支付团队")
    expect(links[1]).toHaveTextContent("默认空间")
  })

  it("旧响应缺空间名时不渲染空徽章", async () => {
    vi.mocked(searchApi.query).mockResolvedValue({
      query: "部署",
      results: [
        {
          pageId: 1,
          title: "部署手册",
          snippet: "支付服务的部署步骤",
          updatedAt: "2026-11-08T00:00:00.000Z",
          spaceId: 1,
          spaceName: ""
        }
      ]
    })
    render(
      <MemoryRouter initialEntries={["/s/default/search?q=部署"]}>
        <SearchPage />
      </MemoryRouter>
    )

    const link = await screen.findByRole("link")
    expect(link.textContent).not.toContain("默认空间")
  })
})

describe("搜索页空间过滤下拉与 URL 参数联动", () => {
  beforeEach(() => {
    vi.mocked(searchApi.query).mockReset()
    vi.mocked(searchApi.query).mockResolvedValue({
      query: "部署",
      results: []
    })
    useSpacesStore.setState({
      spaces: [defaultSpace, paySpace],
      currentId: 1,
      status: "ready"
    })
  })

  it("默认全部空间：URL 无 space 时默认全部空间，不按路由 slug 预选", async () => {
    render(
      <MemoryRouter initialEntries={["/s/pay/search?q=部署"]}>
        <SearchPage />
      </MemoryRouter>
    )

    const trigger = await screen.findByRole("combobox")
    expect(trigger).toHaveTextContent("全部空间")
    expect(searchApi.query).toHaveBeenCalledWith("部署", 20, undefined)
  })

  it("URL 带合法 space 参数时选中对应空间并传 spaceId 查询", async () => {
    render(
      <MemoryRouter initialEntries={["/s/default/search?q=部署&space=2"]}>
        <SearchPage />
      </MemoryRouter>
    )

    const trigger = await screen.findByRole("combobox")
    expect(trigger).toHaveTextContent("支付团队")
    expect(searchApi.query).toHaveBeenCalledWith("部署", 20, 2)
  })

  it("URL 里的 space 不在可见空间列表中时回退到全部空间处理并展示全部空间", async () => {
    render(
      <MemoryRouter initialEntries={["/s/default/search?q=部署&space=999"]}>
        <SearchPage />
      </MemoryRouter>
    )

    const trigger = await screen.findByRole("combobox")
    expect(trigger).toHaveTextContent("全部空间")
    expect(searchApi.query).toHaveBeenCalledWith("部署", 20, undefined)
  })

  it("下拉切换空间更新 URL 并以对应 spaceId 重新查询，切回全部空间清除 URL space 参数", async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={["/s/default/search?q=部署"]}>
        <SearchPage />
        <LocationMonitor />
      </MemoryRouter>
    )

    expect(searchApi.query).toHaveBeenCalledWith("部署", 20, undefined)
    expect(screen.getByTestId("search-params")).toHaveTextContent("space=none")

    // 切换到「支付团队」
    const trigger = screen.getByRole("combobox")
    await user.click(trigger)
    const payOption = await screen.findByRole("option", { name: "支付团队" })
    await user.click(payOption)

    expect(searchApi.query).toHaveBeenLastCalledWith("部署", 20, 2)
    expect(screen.getByTestId("search-params")).toHaveTextContent("space=2")
    expect(trigger).toHaveTextContent("支付团队")

    // 切回「全部空间」
    await user.click(trigger)
    const allOption = await screen.findByRole("option", { name: "全部空间" })
    await user.click(allOption)

    expect(searchApi.query).toHaveBeenLastCalledWith("部署", 20, undefined)
    expect(screen.getByTestId("search-params")).toHaveTextContent("space=none")
    expect(trigger).toHaveTextContent("全部空间")
  })

  it("无 query 时不触发 searchApi.query 但空间下拉正常渲染", async () => {
    render(
      <MemoryRouter initialEntries={["/s/default/search"]}>
        <SearchPage />
      </MemoryRouter>
    )

    expect(searchApi.query).not.toHaveBeenCalled()
    expect(screen.getByRole("combobox")).toHaveTextContent("全部空间")
  })
})
