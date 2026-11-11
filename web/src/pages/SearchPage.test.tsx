import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SearchPage } from "@/pages/SearchPage"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    searchApi: { ...actual.searchApi, query: vi.fn() }
  }
})

const { searchApi } = await import("@/lib/api")

describe("搜索结果的空间标注", () => {
  beforeEach(() => {
    vi.mocked(searchApi.query).mockReset()
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
