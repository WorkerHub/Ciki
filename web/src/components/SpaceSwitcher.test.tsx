import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, useLocation } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SpaceSwitcher } from "@/components/SpaceSwitcher"
import type { Me, Space } from "@/lib/api"
import { useAuthStore } from "@/stores/auth"
import { useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    spacesApi: {
      ...actual.spacesApi,
      list: vi.fn(),
      create: vi.fn()
    }
  }
})

const { spacesApi } = await import("@/lib/api")

const user: Me = {
  id: "u1",
  publicId: "AB23CD45",
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

const siteAdmin: Me = { ...user, role: "admin" }

const defaultSpace: Space = {
  id: "space-default",
  name: "默认空间",
  description: "",
  myRole: "editor",
  isDefault: true,
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z"
}

const teamSpace: Space = {
  ...defaultSpace,
  id: "space-2",
  name: "支付团队",
  myRole: "admin",
  isDefault: false
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

function renderSwitcher() {
  return render(
    <MemoryRouter initialEntries={["/p/abc"]}>
      <SpaceSwitcher />
      <LocationProbe />
    </MemoryRouter>
  )
}

async function openMenu() {
  const click = userEvent.setup()
  await click.click(screen.getByRole("button", { name: "切换空间" }))
  return click
}

describe("空间切换器", () => {
  beforeEach(() => {
    useAuthStore.setState({ user, status: "ready", restricted: false })
    useSpacesStore.setState({
      spaces: [defaultSpace, teamSpace],
      status: "ready",
      error: null,
      currentId: "space-default"
    })
    vi.mocked(spacesApi.create).mockReset()
  })

  it("触发器显示当前空间与角色，菜单列出全部可见空间并标出默认空间", async () => {
    renderSwitcher()
    expect(screen.getByRole("button", { name: "切换空间" })).toHaveTextContent(
      "默认空间"
    )
    expect(screen.getByRole("button", { name: "切换空间" })).toHaveTextContent(
      "编辑"
    )

    await openMenu()
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((item) => item.textContent)).toContain("支付团队管理员")
    const defaultItem = screen.getByRole("menuitem", { name: /默认空间/ })
    expect(defaultItem).toHaveTextContent("默认")
  })

  it("切换空间后更新当前空间并回首页", async () => {
    const click = userEvent.setup()
    renderSwitcher()

    await click.click(screen.getByRole("button", { name: "切换空间" }))
    await click.click(await screen.findByRole("menuitem", { name: /支付团队/ }))

    expect(useSpacesStore.getState().currentId).toBe("space-2")
    expect(screen.getByTestId("location")).toHaveTextContent("/")
  })

  it("viewer 看不到空间设置入口，但仍能新建空间", async () => {
    useSpacesStore.setState({
      spaces: [defaultSpace, { ...teamSpace, myRole: "viewer" }],
      currentId: "space-2"
    })
    renderSwitcher()

    await openMenu()
    expect(
      await screen.findByRole("menuitem", { name: "新建空间" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "空间设置" })).toBeNull()
  })

  it("空间管理员能看到空间设置入口并跳到设置页", async () => {
    const click = userEvent.setup()
    renderSwitcher()

    await click.click(screen.getByRole("button", { name: "切换空间" }))
    expect(screen.queryByRole("menuitem", { name: "空间设置" })).toBeNull()

    await click.click(await screen.findByRole("menuitem", { name: /支付团队/ }))
    await click.click(screen.getByRole("button", { name: "切换空间" }))
    await click.click(await screen.findByRole("menuitem", { name: "空间设置" }))

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/spaces/space-2/settings"
    )
  })

  it("站点管理员即使空间只是 editor 也能进入空间设置", async () => {
    useAuthStore.setState({
      user: siteAdmin,
      status: "ready",
      restricted: false
    })
    renderSwitcher()

    await openMenu()
    expect(
      await screen.findByRole("menuitem", { name: "空间设置" })
    ).toBeInTheDocument()
  })

  it("新建空间：提交名称后切到新空间并回首页", async () => {
    const click = userEvent.setup()
    vi.mocked(spacesApi.create).mockResolvedValue({
      ...defaultSpace,
      id: "space-new",
      name: "设计系统",
      myRole: "admin",
      isDefault: false
    })
    renderSwitcher()

    await click.click(screen.getByRole("button", { name: "切换空间" }))
    await click.click(await screen.findByRole("menuitem", { name: "新建空间" }))
    await click.type(await screen.findByLabelText("空间名称"), "设计系统")
    await click.click(screen.getByRole("button", { name: "创建空间" }))

    expect(spacesApi.create).toHaveBeenCalledWith({
      name: "设计系统",
      description: ""
    })
    expect(useSpacesStore.getState().currentId).toBe("space-new")
    expect(screen.getByTestId("location")).toHaveTextContent("/")
  })

  it("空间列表加载失败时给出重试入口", async () => {
    useSpacesStore.setState({ spaces: [], status: "error", error: "boom" })
    renderSwitcher()

    expect(screen.getByText("空间列表加载失败")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument()
  })
})
