import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, useLocation } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import type { AdminSpace, Space } from "@/lib/api"
import { SpacesTab } from "@/pages/admin/SpacesTab"
import { useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    adminApi: { ...actual.adminApi, spaces: vi.fn() },
    spacesApi: { ...actual.spacesApi, create: vi.fn() }
  }
})

const { adminApi, spacesApi } = await import("@/lib/api")

const defaultSpace: AdminSpace = {
  id: 1,
  slug: "default",
  name: "默认空间",
  description: "",
  isDefault: true,
  createdBy: 1,
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z",
  memberCount: 5,
  pageCount: 12,
  trashedPageCount: 3
}

const teamSpace: AdminSpace = {
  ...defaultSpace,
  id: 2,
  slug: "pay-team",
  name: "支付团队",
  description: "支付相关文档",
  isDefault: false,
  memberCount: 4,
  pageCount: 7,
  trashedPageCount: 0
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

describe("系统管理 · 空间总览", () => {
  beforeEach(() => {
    vi.mocked(adminApi.spaces).mockReset()
    vi.mocked(spacesApi.create).mockReset()
    useSpacesStore.setState({
      spaces: [],
      status: "ready",
      error: null,
      currentId: null
    })
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
    expect(teamRow.querySelector('a[href="/s/pay-team/settings"]')).toBeTruthy()
  })

  it("后端没下发 slug 时不给空间设置死链", async () => {
    const { slug: _slug, ...spaceWithoutSlug } = teamSpace
    vi.mocked(adminApi.spaces).mockResolvedValue([spaceWithoutSlug])
    render(
      <MemoryRouter>
        <SpacesTab />
      </MemoryRouter>
    )

    const row = (await screen.findByText("支付团队")).closest(
      "tr"
    ) as HTMLElement
    expect(row.querySelector("a")).toBeNull()
    expect(row).not.toHaveTextContent("/s/")
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

  it("头部包含新建空间按钮，点击打开共享对话框并创建空间", async () => {
    const click = userEvent.setup()
    const createdSpace: Space = {
      id: 3,
      slug: "brand-new",
      name: "总览新建空间",
      description: "",
      myRole: "admin",
      isDefault: false,
      createdAt: "2026-11-27T00:00:00.000Z",
      updatedAt: "2026-11-27T00:00:00.000Z"
    }
    vi.mocked(adminApi.spaces).mockResolvedValue([defaultSpace, teamSpace])
    vi.mocked(spacesApi.create).mockResolvedValue(createdSpace)

    render(
      <MemoryRouter initialEntries={["/admin/spaces"]}>
        <SpacesTab />
        <LocationProbe />
      </MemoryRouter>
    )

    const createButton = await screen.findByRole("button", { name: "新建空间" })
    expect(createButton).toBeInTheDocument()

    await click.click(createButton)
    expect(await screen.findByRole("heading", { name: "新建空间" })).toBeInTheDocument()

    await click.type(screen.getByLabelText("空间名称"), "总览新建空间")
    await click.click(screen.getByRole("button", { name: "创建空间" }))

    expect(spacesApi.create).toHaveBeenCalledWith({
      name: "总览新建空间",
      description: ""
    })
    expect(useSpacesStore.getState().currentId).toBe(3)
    expect(screen.getByTestId("location")).toHaveTextContent("/")
  })
})

describe("系统管理 · 空间总览 · 英文界面", () => {
  it("表头、默认标记与空间设置链接都是英文", async () => {
    await i18n.changeLanguage("en")
    vi.mocked(adminApi.spaces).mockResolvedValue([defaultSpace, teamSpace])
    render(
      <MemoryRouter>
        <SpacesTab />
      </MemoryRouter>
    )

    expect(await screen.findByText("Space overview")).toBeInTheDocument()
    expect(
      screen.getByRole("columnheader", { name: "Members" })
    ).toBeInTheDocument()
    expect(screen.getByText("Default")).toBeInTheDocument()
    expect(screen.getAllByText("Space settings").length).toBeGreaterThan(0)
  })
})
