import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MovePageDialog } from "@/components/MovePageDialog"
import { ApiError, type PageNode, type Space } from "@/lib/api"
import { useAuthStore } from "@/stores/auth"
import { usePagesStore } from "@/stores/pages"
import { useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    pagesApi: { ...actual.pagesApi, tree: vi.fn() }
  }
})

const { pagesApi } = await import("@/lib/api")

const AT = "2026-11-08T00:00:00.000Z"

function space(overrides: Partial<Space> = {}): Space {
  return {
    id: 1,
    slug: "space-1",
    name: "空间一",
    description: "",
    myRole: "editor",
    isDefault: true,
    createdAt: AT,
    updatedAt: AT,
    ...overrides
  }
}

function node(
  id: number,
  title: string,
  sortOrder: number,
  parentId: number | null,
  children: PageNode[] = []
): PageNode {
  return { id, title, sortOrder, parentId, updatedAt: AT, children }
}

/** 当前空间：父页 A（下面有被移动页 2 和兄弟页 4，被移动页还有孙页 3）+ 另一根页 9。 */
const sourceTree: PageNode[] = [
  node(1, "父页 A", 0, null, [
    node(2, "被移动页", 0, 1, [node(3, "孙页", 0, 2)]),
    node(4, "兄弟页", 1, 1)
  ]),
  node(9, "另一根页", 1, null)
]

/** 目标空间：M（下面有子页 N）。 */
const targetTree: PageNode[] = [
  node(20, "目标空间页面 M", 0, null, [node(21, "目标空间子页 N", 0, 20)])
]

const movePageTo = vi.fn()

function renderDialog(
  props: Partial<React.ComponentProps<typeof MovePageDialog>> = {}
) {
  const onOpenChange = vi.fn()
  const onMoved = vi.fn()
  render(
    <MovePageDialog
      pageId={2}
      pageTitle="被移动页"
      parentId={1}
      sourceSpaceId={1}
      open
      onOpenChange={onOpenChange}
      onMoved={onMoved}
      {...props}
    />
  )
  return { onOpenChange, onMoved }
}

const parentSelect = () => screen.getByRole("combobox", { name: "父页面" })
const targetSelect = () => screen.getByRole("combobox", { name: "目标空间" })
const submitButton = () => screen.getByRole("button", { name: "移动" })

async function pickOption(select: HTMLElement, name: string): Promise<void> {
  const user = userEvent.setup()
  await user.click(select)
  await user.click(await screen.findByRole("option", { name }))
}

describe("移动页面对话框", () => {
  beforeEach(() => {
    movePageTo.mockReset()
    movePageTo.mockResolvedValue(undefined)
    vi.mocked(pagesApi.tree).mockReset()
    vi.mocked(pagesApi.tree).mockImplementation(async (spaceId) =>
      spaceId === 2 ? targetTree : sourceTree
    )
    useAuthStore.setState({ user: null, status: "ready", restricted: false })
    useSpacesStore.setState({
      spaces: [
        space(),
        space({ id: 2, slug: "space-2", name: "空间二", isDefault: false })
      ],
      status: "ready",
      error: null,
      currentId: 1
    })
    usePagesStore.setState({
      tree: sourceTree,
      spaceId: 1,
      loading: false,
      error: null,
      expanded: [],
      movePageTo: movePageTo as unknown as ReturnType<
        typeof usePagesStore.getState
      >["movePageTo"]
    })
  })

  it("打开时默认目标空间是页面所在空间，父页面是页面现父页", async () => {
    renderDialog()

    expect(targetSelect()).toHaveTextContent("空间一")
    expect(
      await screen.findByRole("combobox", { name: "父页面" })
    ).toHaveTextContent("父页 A")
    // 什么都没改：提交按钮禁用，避免「点一下把页面挪到自己同级末尾」
    expect(submitButton()).toBeDisabled()
  })

  it("父页面选项含「顶层」与整棵树的页面，但不含被移动页自己与它的后代", async () => {
    const user = userEvent.setup()
    renderDialog()

    await screen.findByRole("combobox", { name: "父页面" })
    await user.click(parentSelect())

    const names = (await screen.findAllByRole("option")).map(
      (option) => option.textContent
    )
    expect(names).toEqual(["顶层（无父页面）", "父页 A", "兄弟页", "另一根页"])
    expect(screen.queryByRole("option", { name: "被移动页" })).toBeNull()
    expect(screen.queryByRole("option", { name: "孙页" })).toBeNull()
  })

  it("切换目标空间后父页面列表换成该空间的页面，选择重置为顶层", async () => {
    const user = userEvent.setup()
    renderDialog()

    await screen.findByRole("combobox", { name: "父页面" })
    await pickOption(targetSelect(), "空间二")

    expect(pagesApi.tree).toHaveBeenCalledWith(2)
    expect(
      await screen.findByRole("combobox", { name: "父页面" })
    ).toHaveTextContent("顶层（无父页面）")
    await user.click(parentSelect())
    expect(
      (await screen.findAllByRole("option")).map((option) => option.textContent)
    ).toEqual(["顶层（无父页面）", "目标空间页面 M", "目标空间子页 N"])
  })

  it("跨空间指定父页面：提交带目标空间、父页与新父级末尾下标", async () => {
    const { onMoved, onOpenChange } = renderDialog()

    await screen.findByRole("combobox", { name: "父页面" })
    await pickOption(targetSelect(), "空间二")
    await pickOption(parentSelect(), "目标空间页面 M")
    await userEvent.setup().click(submitButton())

    // M 已有一个子页 N → 落位是下标 1
    expect(movePageTo).toHaveBeenCalledWith(2, 2, 20, 1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onMoved).toHaveBeenCalledWith(2)
  })

  it("同空间改回顶层：提交父页为 null，落位根级末尾", async () => {
    renderDialog()

    await screen.findByRole("combobox", { name: "父页面" })
    await pickOption(parentSelect(), "顶层（无父页面）")
    await userEvent.setup().click(submitButton())

    // 剪掉自身子树后根级只剩「父页 A」「另一根页」→ 追加到下标 2
    expect(movePageTo).toHaveBeenCalledWith(2, 1, null, 2)
  })

  it("服务端拒绝时错误留在对话框里，框不关、可改选重试", async () => {
    movePageTo.mockRejectedValueOnce(
      new ApiError(
        409,
        "Cannot move a page into its own subtree",
        "PAGE_MOVE_CYCLE"
      )
    )
    const { onOpenChange } = renderDialog()

    await screen.findByRole("combobox", { name: "父页面" })
    await pickOption(parentSelect(), "顶层（无父页面）")
    await userEvent.setup().click(submitButton())

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "不能把页面移动到它自己的子页面下。"
    )
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(submitButton()).toBeEnabled()
  })

  it("目标空间列表包含页面当前所在的空间", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(targetSelect())
    expect(
      (await screen.findAllByRole("option")).map((option) => option.textContent)
    ).toEqual(["空间一", "空间二"])
  })
})
