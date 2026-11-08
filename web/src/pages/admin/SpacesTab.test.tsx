import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AdminSpace } from "@/lib/api"
import { SpacesTab } from "@/pages/admin/SpacesTab"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    adminApi: { ...actual.adminApi, spaces: vi.fn() }
  }
})

const { adminApi } = await import("@/lib/api")

const defaultSpace: AdminSpace = {
  id: "space-default",
  name: "默认空间",
  description: "",
  isDefault: true,
  createdBy: "u1",
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z",
  memberCount: 5,
  pageCount: 12,
  trashedPageCount: 3
}

const teamSpace: AdminSpace = {
  ...defaultSpace,
  id: "space-2",
  name: "支付团队",
  description: "支付相关文档",
  isDefault: false,
  memberCount: 4,
  pageCount: 7,
  trashedPageCount: 0
}

describe("系统管理 · 空间总览", () => {
  beforeEach(() => {
    vi.mocked(adminApi.spaces).mockReset()
  })

  it("渲染每个空间的成员/页面/回收站统计与默认空间标记", async () => {
    vi.mocked(adminApi.spaces).mockResolvedValue([defaultSpace, teamSpace])
    render(
      <MemoryRouter>
        <SpacesTab />
      </MemoryRouter>
    )

    const teamRow = (await screen.findByText("支付团队")).closest(
      "tr"
    ) as HTMLElement
    const cells = teamRow.querySelectorAll("td")
    expect(cells[2]).toHaveTextContent("4")
    expect(cells[3]).toHaveTextContent("7")
    expect(cells[4]).toHaveTextContent("0")

    const defaultRow = screen.getByText("默认空间").closest("tr") as HTMLElement
    expect(defaultRow).toHaveTextContent("默认")
    expect(defaultRow.querySelectorAll("td")[3]).toHaveTextContent("12")
    expect(defaultRow.querySelectorAll("td")[4]).toHaveTextContent("3")
  })

  it("每行都能进空间设置", async () => {
    vi.mocked(adminApi.spaces).mockResolvedValue([defaultSpace, teamSpace])
    render(
      <MemoryRouter>
        <SpacesTab />
      </MemoryRouter>
    )

    const teamRow = (await screen.findByText("支付团队")).closest(
      "tr"
    ) as HTMLElement
    expect(
      teamRow.querySelector('a[href="/spaces/space-2/settings"]')
    ).toBeTruthy()
  })

  it("加载失败显示错误", async () => {
    vi.mocked(adminApi.spaces).mockRejectedValue(new Error("boom"))
    render(
      <MemoryRouter>
        <SpacesTab />
      </MemoryRouter>
    )

    expect(await screen.findByRole("alert")).toBeInTheDocument()
  })
})
