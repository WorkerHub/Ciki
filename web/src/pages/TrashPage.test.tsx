import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { i18n } from "@/i18n"
import type { Me, Space, TrashNode } from "@/lib/api"
import { TrashPage } from "@/pages/TrashPage"
import { useAuthStore } from "@/stores/auth"
import { useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    pagesApi: {
      ...actual.pagesApi,
      trash: vi.fn(),
      restore: vi.fn(),
      removePermanent: vi.fn(),
      trashBatch: vi.fn()
    }
  }
})

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn()
  })
}))

const { pagesApi } = await import("@/lib/api")

const user: Me = {
  id: 1,
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

const defaultSpace: Space = {
  id: 1,
  slug: "default",
  name: "默认空间",
  description: "",
  myRole: "editor",
  isDefault: true,
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z"
}

const teamSpace: Space = {
  ...defaultSpace,
  id: 2,
  slug: "pay-team",
  name: "支付团队",
  myRole: "editor",
  isDefault: false
}

const viewerSpace: Space = {
  ...defaultSpace,
  id: 3,
  slug: "arch-team",
  name: "架构团队",
  myRole: "viewer",
  isDefault: false
}

function trashNode(
  id: number,
  title: string,
  options?: Partial<TrashNode>
): TrashNode {
  return {
    id,
    parentId: null,
    spaceId: 1,
    spaceName: "默认空间",
    title,
    childCount: 0,
    createdAt: "2026-11-08T00:00:00.000Z",
    deletedAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
    ...options
  }
}

function renderTrash() {
  const router = createMemoryRouter(
    [
      { path: "/s/:slug/trash", element: <TrashPage /> },
      { path: "/", element: <div>首页占位</div> }
    ],
    { initialEntries: ["/s/default/trash"] }
  )
  render(<RouterProvider router={router} />)
  return router
}

describe("跨空间汇总表与空间筛选", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh")
    useAuthStore.setState({ user, status: "ready", restricted: false })
    useSpacesStore.setState({
      spaces: [defaultSpace, teamSpace, viewerSpace],
      status: "ready",
      error: null,
      currentId: 1
    })
    vi.mocked(pagesApi.trash).mockImplementation(async (spaceId) => {
      if (spaceId === teamSpace.id) {
        return [
          trashNode(2, "支付接口规范", {
            spaceId: 2,
            spaceName: "支付团队",
            childCount: 3
          })
        ]
      }
      if (spaceId === defaultSpace.id) {
        return [
          trashNode(1, "旧版首页", {
            spaceId: 1,
            spaceName: "默认空间",
            childCount: 0
          })
        ]
      }
      return [
        trashNode(1, "旧版首页", {
          spaceId: 1,
          spaceName: "默认空间",
          childCount: 0
        }),
        trashNode(2, "支付接口规范", {
          spaceId: 2,
          spaceName: "支付团队",
          childCount: 3
        }),
        trashNode(3, "架构设计原则", {
          spaceId: 3,
          spaceName: "架构团队",
          childCount: 0
        })
      ]
    })
    vi.mocked(pagesApi.restore).mockResolvedValue({ success: true })
    vi.mocked(pagesApi.removePermanent).mockResolvedValue({ success: true })
    vi.mocked(pagesApi.trashBatch).mockResolvedValue({
      results: [
        { id: 1, ok: true },
        { id: 2, ok: true }
      ]
    })
  })

  it("默认汇总全部空间，展示空间列、创建与删除时间、子页面小字", async () => {
    renderTrash()

    expect(pagesApi.trash).toHaveBeenCalledWith(undefined)
    expect(await screen.findByText("旧版首页")).toBeInTheDocument()
    expect(screen.getByText("支付接口规范")).toBeInTheDocument()
    expect(screen.getByText("架构设计原则")).toBeInTheDocument()

    // 空间列
    expect(screen.getAllByText("默认空间").length).toBeGreaterThan(0)
    expect(screen.getAllByText("支付团队").length).toBeGreaterThan(0)
    expect(screen.getAllByText("架构团队").length).toBeGreaterThan(0)

    // 含子页面小字：N=3 时显示「含 3 个子页面」；0 不显示
    expect(screen.getByText("含 3 个子页面")).toBeInTheDocument()
    expect(screen.queryByText("含 0 个子页面")).toBeNull()
  })

  it("切换顶部空间筛选后，按选定空间重新拉取与展示", async () => {
    const click = userEvent.setup()
    renderTrash()
    expect(await screen.findByText("旧版首页")).toBeInTheDocument()

    // 顶部空间筛选下拉
    const trigger = screen.getByRole("combobox", { name: "空间" })
    await click.click(trigger)
    await click.click(await screen.findByRole("option", { name: "支付团队" }))

    expect(pagesApi.trash).toHaveBeenLastCalledWith(2)
    expect(await screen.findByText("支付接口规范")).toBeInTheDocument()
    expect(screen.queryByText("旧版首页")).toBeNull()
  })
})

describe("彻底删除确认弹窗与计数", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh")
    useAuthStore.setState({ user, status: "ready", restricted: false })
    useSpacesStore.setState({
      spaces: [defaultSpace, teamSpace],
      status: "ready",
      error: null,
      currentId: 1
    })
    vi.mocked(pagesApi.trash).mockResolvedValue([
      trashNode(1, "单页根", { spaceId: 1, childCount: 2 }),
      trashNode(2, "独立页", { spaceId: 1, childCount: 0 })
    ])
    vi.mocked(pagesApi.removePermanent).mockResolvedValue({ success: true })
    vi.mocked(pagesApi.trashBatch).mockResolvedValue({
      results: [
        { id: 1, ok: true },
        { id: 2, ok: true }
      ]
    })
  })

  it("单条彻底删除弹窗：明示条目数 1 与含子页面总篇数 M=3", async () => {
    const click = userEvent.setup()
    renderTrash()
    expect(await screen.findByText("单页根")).toBeInTheDocument()

    const purgeButtons = screen.getAllByRole("button", { name: "彻底删除" })
    await click.click(purgeButtons[0])

    expect(await screen.findByText("彻底删除「单页根」？")).toBeInTheDocument()
    expect(
      screen.getByText(
        "共 1 项条目，含子页面共 3 篇。页面与它的全部版本记录会被永久删除，无法恢复。"
      )
    ).toBeInTheDocument()
  })

  it("批量彻底删除弹窗：明示条目数 2 与含子页面总篇数 M=4", async () => {
    const click = userEvent.setup()
    renderTrash()
    expect(await screen.findByText("单页根")).toBeInTheDocument()

    // 全选
    await click.click(screen.getByRole("checkbox", { name: "全选" }))
    expect(screen.getByText("已选 2 项")).toBeInTheDocument()

    await click.click(screen.getByRole("button", { name: "批量彻底删除" }))

    expect(await screen.findByText("彻底删除选中的 2 项？")).toBeInTheDocument()
    expect(
      screen.getByText(
        "共 2 项条目，含子页面共 4 篇。页面与它的全部版本记录会被永久删除，无法恢复。"
      )
    ).toBeInTheDocument()
  })
})

describe("批量恢复、批量彻底删除与清空回收站", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh")
    useAuthStore.setState({ user, status: "ready", restricted: false })
    useSpacesStore.setState({
      spaces: [defaultSpace, teamSpace],
      status: "ready",
      error: null,
      currentId: 1
    })
    vi.mocked(pagesApi.trash).mockResolvedValue([
      trashNode(10, "待恢复A", { spaceId: 1, childCount: 1 }),
      trashNode(20, "待恢复B", { spaceId: 1, childCount: 0 })
    ])
    vi.mocked(pagesApi.restore).mockResolvedValue({ success: true })
    vi.mocked(pagesApi.trashBatch).mockResolvedValue({
      results: [
        { id: 10, ok: true },
        { id: 20, ok: true }
      ]
    })
  })

  it("批量恢复直接生效不弹确认弹窗", async () => {
    const click = userEvent.setup()
    renderTrash()
    expect(await screen.findByText("待恢复A")).toBeInTheDocument()

    await click.click(screen.getByRole("checkbox", { name: "全选" }))
    await click.click(screen.getByRole("button", { name: "批量恢复" }))

    expect(pagesApi.trashBatch).toHaveBeenCalledWith("restore", [10, 20])
    expect(toast.success).toHaveBeenCalledWith("成功 2 项")
  })

  it("批量部分失败时不整批回滚，提示成功与失败数并保留失败项勾选", async () => {
    vi.mocked(pagesApi.trashBatch).mockResolvedValue({
      results: [
        { id: 10, ok: true },
        { id: 20, ok: false, error: "permission denied" }
      ]
    })
    const click = userEvent.setup()
    renderTrash()
    expect(await screen.findByText("待恢复A")).toBeInTheDocument()

    await click.click(screen.getByRole("checkbox", { name: "全选" }))
    await click.click(screen.getByRole("button", { name: "批量恢复" }))

    expect(toast).toHaveBeenCalledWith("成功 1 项、失败 1 项")
    // 失败条目 20 仍保留勾选，操作条显示已选 1 项
    expect(screen.getByText("已选 1 项")).toBeInTheDocument()
  })

  it("清空回收站：作用于当前筛选视图的全部条目", async () => {
    const click = userEvent.setup()
    renderTrash()
    expect(await screen.findByText("待恢复A")).toBeInTheDocument()

    await click.click(screen.getByRole("button", { name: "清空回收站" }))
    expect(await screen.findByText("清空回收站？")).toBeInTheDocument()
    expect(
      screen.getByText(
        "共 2 项条目，含子页面共 3 篇。页面与它的全部版本记录会被永久删除，无法恢复。"
      )
    ).toBeInTheDocument()

    // 确认清空
    const dialogActions = screen.getAllByRole("button", { name: "彻底删除" })
    await click.click(dialogActions[dialogActions.length - 1])

    expect(pagesApi.trashBatch).toHaveBeenCalledWith("purge", [10, 20])
  })
})

describe("无编辑权空间条目只读", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh")
    useAuthStore.setState({ user, status: "ready", restricted: false })
    useSpacesStore.setState({
      spaces: [defaultSpace, viewerSpace],
      status: "ready",
      error: null,
      currentId: 1
    })
    vi.mocked(pagesApi.trash).mockResolvedValue([
      trashNode(1, "可写页面", { spaceId: 1 }),
      trashNode(2, "只读页面", { spaceId: 3, spaceName: "架构团队" })
    ])
  })

  it("只读条目无勾选框且无操作按钮", async () => {
    renderTrash()
    expect(await screen.findByText("可写页面")).toBeInTheDocument()
    expect(screen.getByText("只读页面")).toBeInTheDocument()

    // 可写条目有选择框与操作按钮
    expect(
      screen.getByRole("checkbox", { name: "选择「可写页面」" })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("checkbox", { name: "选择「只读页面」" })
    ).toBeNull()

    // 恢复与彻底删除按钮各只有 1 个（只读条目没有）
    expect(screen.getAllByRole("button", { name: "恢复" })).toHaveLength(1)
    expect(screen.getAllByRole("button", { name: "彻底删除" })).toHaveLength(1)
  })
})

describe("单条恢复与彻底删除", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh")
    useAuthStore.setState({ user, status: "ready", restricted: false })
    useSpacesStore.setState({
      spaces: [defaultSpace],
      status: "ready",
      error: null,
      currentId: 1
    })
    vi.mocked(pagesApi.trash).mockResolvedValue([
      trashNode(1, "旧版首页", { spaceId: 1 })
    ])
    vi.mocked(pagesApi.restore).mockResolvedValue({ success: true })
    vi.mocked(pagesApi.removePermanent).mockResolvedValue({ success: true })
  })

  it("单条恢复直接调用 pagesApi.restore", async () => {
    const click = userEvent.setup()
    renderTrash()
    expect(await screen.findByText("旧版首页")).toBeInTheDocument()

    await click.click(screen.getByRole("button", { name: "恢复" }))
    expect(pagesApi.restore).toHaveBeenCalledWith(1)
  })

  it("单条彻底删除确认后调用 pagesApi.removePermanent", async () => {
    const click = userEvent.setup()
    renderTrash()
    expect(await screen.findByText("旧版首页")).toBeInTheDocument()

    await click.click(screen.getByRole("button", { name: "彻底删除" }))
    const dialogActions = screen.getAllByRole("button", { name: "彻底删除" })
    await click.click(dialogActions[dialogActions.length - 1])

    expect(pagesApi.removePermanent).toHaveBeenCalledWith(1)
  })
})

describe("回收站英文界面", () => {
  beforeEach(async () => {
    useAuthStore.setState({ user, status: "ready", restricted: false })
    useSpacesStore.setState({
      spaces: [{ ...defaultSpace, name: "Default space", myRole: "viewer" }],
      status: "ready",
      error: null,
      currentId: 1
    })
    vi.mocked(pagesApi.trash).mockResolvedValue([
      trashNode(1, "Old home page", {
        spaceId: 1,
        spaceName: "Default space",
        childCount: 1
      })
    ])
    await i18n.changeLanguage("en")
  })

  it("页头汇总说明、列名与只读提示按英文渲染", async () => {
    renderTrash()

    expect(await screen.findByText("Old home page")).toBeInTheDocument()
    expect(screen.getByText("All spaces summary.")).toBeInTheDocument()
    expect(
      screen.getByText(
        /^Soft-deleted pages stay here together with their subpages/
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText("You are a read-only member and can only look.")
    ).toBeInTheDocument()

    // 列名
    expect(screen.getByText("Space")).toBeInTheDocument()
    expect(screen.getByText("Title")).toBeInTheDocument()
    expect(screen.getByText("Created at")).toBeInTheDocument()
    expect(screen.getByText("Deleted at")).toBeInTheDocument()

    // 只读成员无按钮
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull()
    expect(screen.queryByText(/[\u4e00-\u9fff]/)).toBeNull()
  })
})
