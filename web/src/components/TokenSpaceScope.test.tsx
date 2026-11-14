import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TokenSpaceScope } from "@/components/TokenSpaceScope"
import { i18n } from "@/i18n"
import { ApiError, type Space, type TokenSpaceIds } from "@/lib/api"
import { useSpacesStore } from "@/stores/spaces"

const SPACES: Space[] = [
  {
    id: 1,
    slug: "space-1",
    name: "默认空间",
    description: "",
    myRole: "admin",
    isDefault: true,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z"
  },
  {
    id: 2,
    slug: "space-2",
    name: "研发空间",
    description: "",
    myRole: "editor",
    isDefault: false,
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z"
  }
]

function seedSpaces(spaces: Space[] = SPACES) {
  useSpacesStore.setState({
    spaces,
    status: "ready",
    currentId: spaces[0]?.id ?? null
  })
}

beforeEach(() => {
  // 每个用例自己决定可见空间；默认就绪但为空，避免打到真 fetch。
  useSpacesStore.setState({ spaces: [], status: "ready", currentId: null })
})

function renderScope(spaceIds: TokenSpaceIds, save = vi.fn()) {
  const onSaved = vi.fn()
  save.mockImplementation(async (ids: TokenSpaceIds) => ({ spaceIds: ids }))
  const view = render(
    <TokenSpaceScope spaceIds={spaceIds} save={save} onSaved={onSaved} />
  )
  return { ...view, save, onSaved }
}

describe("令牌空间范围", () => {
  it("不限制时是「全部空间」，不列勾选项", () => {
    seedSpaces()
    renderScope(null)

    expect(screen.getByRole("radio", { name: "全部空间" })).toHaveAttribute(
      "aria-checked",
      "true"
    )
    expect(screen.queryByRole("checkbox")).toBeNull()
    expect(screen.queryByRole("button", { name: "保存范围" })).toBeNull()
  })

  it("「指定空间」列出会话接口里的空间名，一个没勾时不能保存", async () => {
    seedSpaces()
    const user = userEvent.setup()
    renderScope(null)

    await user.click(screen.getByRole("radio", { name: "指定空间" }))

    expect(
      screen.getByRole("checkbox", { name: "默认空间" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("checkbox", { name: "研发空间" })
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "保存范围" })).toBeDisabled()
  })

  it("勾选两个空间后保存：发升序数组、提示已保存、把范围交回卡片", async () => {
    seedSpaces()
    const user = userEvent.setup()
    const { save, onSaved } = renderScope(null)

    await user.click(screen.getByRole("radio", { name: "指定空间" }))
    await user.click(screen.getByRole("checkbox", { name: "研发空间" }))
    await user.click(screen.getByRole("checkbox", { name: "默认空间" }))
    await user.click(screen.getByRole("button", { name: "保存范围" }))

    await waitFor(() => expect(save).toHaveBeenCalledWith([1, 2]))
    expect(await screen.findByText("空间范围已保存。")).toBeInTheDocument()
    expect(onSaved).toHaveBeenCalledWith([1, 2])
    // 已落库的范围成了新基线：保存按钮回到不可用，避免重复提交
    expect(screen.getByRole("button", { name: "保存范围" })).toBeDisabled()
  })

  it("服务端拒收范围时给出中文错误，勾选留着可以重来", async () => {
    seedSpaces()
    const user = userEvent.setup()
    const { save } = renderScope(null)
    save.mockRejectedValue(
      new ApiError(400, "Invalid space scope", "INVALID_SPACE_SCOPE")
    )

    await user.click(screen.getByRole("radio", { name: "指定空间" }))
    await user.click(screen.getByRole("checkbox", { name: "默认空间" }))
    await user.click(screen.getByRole("button", { name: "保存范围" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "空间范围无效，请重新选择。"
    )
    expect(screen.getByRole("checkbox", { name: "默认空间" })).toBeChecked()
    expect(screen.queryByText("空间范围已保存。")).toBeNull()
  })

  it("已收窄的令牌切回「全部空间」也能保存（清空范围）", async () => {
    seedSpaces()
    const user = userEvent.setup()
    const { save } = renderScope([1, 2])

    expect(screen.getByRole("checkbox", { name: "默认空间" })).toBeChecked()
    await user.click(screen.getByRole("radio", { name: "全部空间" }))

    expect(screen.queryByRole("checkbox")).toBeNull()
    await user.click(screen.getByRole("button", { name: "保存范围" }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(null))
  })

  it("范围里有已退出 / 已删除的空间：不显示幽灵勾选，保存只发可见空间", async () => {
    seedSpaces()
    const user = userEvent.setup()
    const { save } = renderScope([1, 99])

    expect(screen.getByRole("checkbox", { name: "默认空间" })).toBeChecked()
    expect(screen.queryByText("99")).toBeNull()

    await user.click(screen.getByRole("checkbox", { name: "研发空间" }))
    await user.click(screen.getByRole("button", { name: "保存范围" }))

    await waitFor(() => expect(save).toHaveBeenCalledWith([1, 2]))
  })

  it("空间列表还没到时不列勾选项", async () => {
    useSpacesStore.setState({ spaces: [], status: "loading", currentId: null })
    const user = userEvent.setup()
    renderScope(null)

    await user.click(screen.getByRole("radio", { name: "指定空间" }))
    expect(screen.queryByRole("checkbox")).toBeNull()
    expect(screen.getByText("加载中…")).toBeInTheDocument()
  })

  it("英文界面用 Space scope / All spaces / Selected spaces", async () => {
    seedSpaces()
    await i18n.changeLanguage("en")
    const user = userEvent.setup()
    renderScope(null)

    expect(screen.getByText("Space scope")).toBeInTheDocument()
    await user.click(screen.getByRole("radio", { name: "Selected spaces" }))
    // 空间名是数据，不随界面语言变
    expect(
      screen.getByRole("checkbox", { name: "默认空间" })
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save scope" })).toBeDisabled()
  })
})

/**
 * 草稿态：新建面（三期 §5）先把范围编辑好、随创建请求一起发，
 * 所以没有「保存范围」这一步，也不显示保存成功 / 失败行。
 */
function renderDraft(spaceIds: TokenSpaceIds = null) {
  const onChange = vi.fn()
  const view = render(
    <TokenSpaceScope spaceIds={spaceIds} onChange={onChange} />
  )
  return { ...view, onChange }
}

describe("令牌空间范围（草稿态）", () => {
  it("切换与勾选都直接交回范围，不出现保存行", async () => {
    seedSpaces()
    const user = userEvent.setup()
    const { onChange } = renderDraft(null)

    expect(screen.queryByRole("button", { name: "保存范围" })).toBeNull()

    await user.click(screen.getByRole("radio", { name: "指定空间" }))
    expect(onChange).toHaveBeenLastCalledWith([])

    await user.click(screen.getByRole("checkbox", { name: "研发空间" }))
    expect(onChange).toHaveBeenLastCalledWith([2])

    await user.click(screen.getByRole("checkbox", { name: "默认空间" }))
    expect(onChange).toHaveBeenLastCalledWith([1, 2])

    await user.click(screen.getByRole("radio", { name: "全部空间" }))
    expect(onChange).toHaveBeenLastCalledWith(null)
    expect(screen.queryByRole("button", { name: "保存范围" })).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("草稿不写库：没有任何保存动作与成功提示", async () => {
    seedSpaces()
    const user = userEvent.setup()
    renderDraft(null)

    await user.click(screen.getByRole("radio", { name: "指定空间" }))
    await user.click(screen.getByRole("checkbox", { name: "默认空间" }))

    expect(screen.queryByRole("button", { name: "保存范围" })).toBeNull()
    expect(screen.queryByText("空间范围已保存。")).toBeNull()
  })
})
