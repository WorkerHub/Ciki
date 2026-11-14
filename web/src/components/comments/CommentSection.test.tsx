import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CommentSection } from "@/components/comments/CommentSection"
import { i18n } from "@/i18n"
import { ApiError, type CommentDto, type CommentThread } from "@/lib/api"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    commentsApi: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      preview: vi.fn()
    }
  }
})

const { commentsApi } = await import("@/lib/api")

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 1,
    parentId: null,
    authorId: 1,
    authorName: "小明",
    authorAvatarUrl: null,
    bodyMd: "第一行\n第二行",
    html: "<p>第一行</p><p>第二行</p>",
    createdAt: "2026-11-11T02:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    canEdit: true,
    canDelete: true,
    ...overrides
  }
}

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return { ...comment(), replies: [], ...overrides }
}

function renderSection() {
  return render(<CommentSection pageId={1} />)
}

function item(id: number) {
  return document.querySelector<HTMLElement>(`[data-comment-id="${id}"]`)
}

/** 输入框所在的发表/回复/编辑框（同一时刻可能有多个，按输入框反查）。 */
function composerOf(textbox: HTMLElement) {
  return textbox.closest<HTMLElement>("[data-comment-composer]") as HTMLElement
}

describe("页尾评论区", () => {
  beforeEach(() => {
    vi.mocked(commentsApi.list).mockReset()
    vi.mocked(commentsApi.create).mockReset()
    vi.mocked(commentsApi.update).mockReset()
    vi.mocked(commentsApi.remove).mockReset()
    vi.mocked(commentsApi.preview).mockReset()
    vi.mocked(commentsApi.list).mockResolvedValue({ total: 0, threads: [] })
    vi.mocked(commentsApi.create).mockResolvedValue(comment())
    vi.mocked(commentsApi.update).mockResolvedValue(comment())
    vi.mocked(commentsApi.remove).mockResolvedValue({ success: true })
    vi.mocked(commentsApi.preview).mockResolvedValue({ html: "<p>预览</p>" })
  })

  it("0 条只显标题，不显「0 条」这类赘文案", async () => {
    renderSection()
    const heading = await screen.findByRole("heading", { name: /^评论/ })
    // 发表框出现即列表已就绪，避免在加载态上断言
    await screen.findByRole("textbox", { name: "发表评论" })
    expect(heading).toHaveTextContent(/^评论$/)
    expect(screen.queryByText("0")).toBeNull()
  })

  it("有评论时标题带服务端给的条数", async () => {
    vi.mocked(commentsApi.list).mockResolvedValue({
      total: 3,
      threads: [thread({ replies: [comment({ id: 4, parentId: 1 })] })]
    })
    renderSection()
    const heading = await screen.findByRole("heading", { name: /^评论/ })
    expect(await within(heading).findByText("3")).toBeInTheDocument()
  })

  it("回复缩进挂在所属顶层评论的那一串里，按服务端顺序平铺", async () => {
    vi.mocked(commentsApi.list).mockResolvedValue({
      total: 3,
      threads: [
        thread({
          replies: [
            comment({ id: 4, parentId: 1, authorName: "小红" }),
            comment({ id: 5, parentId: 1, authorName: "小刚" })
          ]
        })
      ]
    })
    renderSection()
    await screen.findByText("小红")

    const top = item(1) as HTMLElement
    const first = item(4) as HTMLElement
    const second = item(5) as HTMLElement
    // 回复不在顶层评论的正文元素里，而是与它同处一个串容器
    expect(top.contains(first)).toBe(false)
    expect(top.parentElement?.contains(first)).toBe(true)
    // 串容器里回复那段是缩进层（左边线），顺序与响应一致
    const indent = first.parentElement as HTMLElement
    expect(indent.className).toContain("border-l")
    expect(indent.contains(second)).toBe(true)
    expect(
      Array.from(indent.querySelectorAll<HTMLElement>("[data-comment-id]")).map(
        (node) => Number(node.dataset.commentId)
      )
    ).toEqual([4, 5])
  })

  it("编辑过的评论在名字行尾显「已编辑」，没编辑过的不显", async () => {
    vi.mocked(commentsApi.list).mockResolvedValue({
      total: 2,
      threads: [
        thread({ editedAt: "2026-11-11T03:00:00.000Z" }),
        thread({ id: 2, authorName: "小红" })
      ]
    })
    renderSection()
    await screen.findByText("小明")
    expect(
      within(item(1) as HTMLElement).getByText("已编辑")
    ).toBeInTheDocument()
    expect(within(item(2) as HTMLElement).queryByText("已编辑")).toBeNull()
  })

  it("服务端下发的 HTML 直接呈现，不经过任何前端渲染", async () => {
    vi.mocked(commentsApi.list).mockResolvedValue({
      total: 1,
      threads: [
        thread({
          html: '<p>看这里</p><pre><code class="language-ts">const a = 1</code></pre>'
        })
      ]
    })
    renderSection()
    await screen.findByText("看这里")
    const pre = document.querySelector(".comment-body pre")
    expect(pre).not.toBeNull()
    expect(pre?.querySelector("code")?.className).toBe("language-ts")
    expect(pre?.textContent).toBe("const a = 1")
  })

  it("有回复的顶层被软删后留占位、回复保留，占位本身没有任何操作", async () => {
    vi.mocked(commentsApi.list).mockResolvedValue({
      total: 1,
      threads: [
        thread({
          deletedAt: "2026-11-11T04:00:00.000Z",
          html: "",
          canEdit: false,
          canDelete: false,
          replies: [comment({ id: 4, parentId: 1, authorName: "小红" })]
        })
      ]
    })
    renderSection()
    await screen.findByText("该评论已删除")

    expect(within(item(1) as HTMLElement).queryByRole("button")).toBeNull()
    expect(screen.getByText("小红")).toBeInTheDocument()
    expect(
      within(item(4) as HTMLElement).getByRole("button", { name: "回复" })
    ).toBeInTheDocument()
  })

  it("操作按钮照 canEdit / canDelete 显隐：他人评论只有回复，管理员多一个删除", async () => {
    vi.mocked(commentsApi.list).mockResolvedValue({
      total: 3,
      threads: [
        thread({ canEdit: true, canDelete: true }),
        thread({
          id: 2,
          authorName: "小红",
          canEdit: false,
          canDelete: false
        }),
        thread({
          id: 3,
          authorName: "小刚",
          canEdit: false,
          canDelete: true
        })
      ]
    })
    renderSection()
    await screen.findByText("小明")

    // 自己的：编辑 + 删除
    expect(
      within(item(1) as HTMLElement).getByRole("button", { name: "编辑" })
    ).toBeInTheDocument()
    expect(
      within(item(1) as HTMLElement).getByRole("button", { name: "删除" })
    ).toBeInTheDocument()
    // 他人的：只有回复
    expect(
      within(item(2) as HTMLElement).queryByRole("button", { name: "编辑" })
    ).toBeNull()
    expect(
      within(item(2) as HTMLElement).queryByRole("button", { name: "删除" })
    ).toBeNull()
    expect(
      within(item(2) as HTMLElement).getByRole("button", { name: "回复" })
    ).toBeInTheDocument()
    // 管理员删他人评论：多一个删除、仍然没有编辑
    expect(
      within(item(3) as HTMLElement).queryByRole("button", { name: "编辑" })
    ).toBeNull()
    expect(
      within(item(3) as HTMLElement).getByRole("button", { name: "删除" })
    ).toBeInTheDocument()
  })

  it("空正文不能提交；发表后清空草稿并就地重拉列表", async () => {
    const user = userEvent.setup()
    renderSection()

    const composer = await screen.findByRole("textbox", { name: "发表评论" })
    expect(screen.getByRole("button", { name: "发表" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "预览" })).toBeDisabled()
    await user.type(composer, "问一下")
    expect(screen.getByRole("button", { name: "发表" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "预览" })).toBeEnabled()

    vi.mocked(commentsApi.list).mockResolvedValue({
      total: 1,
      threads: [thread({ id: 6, bodyMd: "问一下", html: "<p>问一下</p>" })]
    })
    await user.click(screen.getByRole("button", { name: "发表" }))

    expect(vi.mocked(commentsApi.create)).toHaveBeenCalledWith(1, {
      bodyMd: "问一下",
      parentId: null
    })
    expect(await screen.findByText("问一下")).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "发表评论" })).toHaveValue("")
    expect(vi.mocked(commentsApi.list)).toHaveBeenCalledTimes(2)
  })

  it("对回复点回复，展开的仍是该串的行内框，parentId 落在顶层评论 id 上", async () => {
    const user = userEvent.setup()
    vi.mocked(commentsApi.list).mockResolvedValue({
      total: 2,
      threads: [
        thread({
          id: 1,
          replies: [comment({ id: 4, parentId: 1, html: "<p>追问</p>" })]
        })
      ]
    })
    renderSection()
    await screen.findByText("追问")

    await user.click(
      within(item(4) as HTMLElement).getByRole("button", { name: "回复" })
    )
    const box = screen.getByRole("textbox", { name: "回复内容" })
    await user.type(box, "再追一句")
    await user.click(
      within(composerOf(box)).getByRole("button", { name: "回复" })
    )

    expect(vi.mocked(commentsApi.create)).toHaveBeenCalledWith(1, {
      bodyMd: "再追一句",
      parentId: 1
    })
  })

  it("编辑时原位预填原文，保存后回到呈现态；取消不发请求", async () => {
    const user = userEvent.setup()
    vi.mocked(commentsApi.list).mockResolvedValue({
      total: 1,
      threads: [thread()]
    })
    renderSection()
    await screen.findByText("第一行")

    await user.click(
      within(item(1) as HTMLElement).getByRole("button", { name: "编辑" })
    )
    let box = within(item(1) as HTMLElement).getByRole("textbox", {
      name: "编辑评论"
    })
    expect(box).toHaveValue("第一行\n第二行")

    await user.click(
      within(item(1) as HTMLElement).getByRole("button", { name: "取消" })
    )
    expect(
      within(item(1) as HTMLElement).queryByRole("textbox", {
        name: "编辑评论"
      })
    ).toBeNull()
    expect(vi.mocked(commentsApi.update)).not.toHaveBeenCalled()

    await user.click(
      within(item(1) as HTMLElement).getByRole("button", { name: "编辑" })
    )
    box = within(item(1) as HTMLElement).getByRole("textbox", {
      name: "编辑评论"
    })
    await user.clear(box)
    await user.type(box, "改好了")
    await user.click(
      within(item(1) as HTMLElement).getByRole("button", { name: "保存" })
    )

    expect(vi.mocked(commentsApi.update)).toHaveBeenCalledWith(1, 1, "改好了")
    expect(
      within(item(1) as HTMLElement).queryByRole("textbox", {
        name: "编辑评论"
      })
    ).toBeNull()
  })

  it("删除走二次确认：取消不发请求，确认才删", async () => {
    const user = userEvent.setup()
    vi.mocked(commentsApi.list).mockResolvedValue({
      total: 1,
      threads: [thread()]
    })
    renderSection()
    await screen.findByText("第一行")

    await user.click(
      within(item(1) as HTMLElement).getByRole("button", { name: "删除" })
    )
    let dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText("删除这条评论？")).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "取消" }))
    expect(vi.mocked(commentsApi.remove)).not.toHaveBeenCalled()

    await user.click(
      within(item(1) as HTMLElement).getByRole("button", { name: "删除" })
    )
    dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "删除" }))
    expect(vi.mocked(commentsApi.remove)).toHaveBeenCalledWith(1, 1)
    // 删除成功才关框
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  })

  it("删除失败时对话框留着，可以直接重试", async () => {
    const user = userEvent.setup()
    vi.mocked(commentsApi.list).mockResolvedValue({
      total: 1,
      threads: [thread()]
    })
    renderSection()
    await screen.findByText("第一行")

    await user.click(
      within(item(1) as HTMLElement).getByRole("button", { name: "删除" })
    )
    const dialog = await screen.findByRole("alertdialog")
    vi.mocked(commentsApi.remove).mockRejectedValueOnce(
      new ApiError(403, "只有作者或管理员能删除")
    )
    await user.click(within(dialog).getByRole("button", { name: "删除" }))

    // 失败：框不关、确认按钮重新可用，用户可以再点一次
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "删除" })).toBeEnabled()
    )
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()

    await user.click(within(dialog).getByRole("button", { name: "删除" }))
    expect(vi.mocked(commentsApi.remove)).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  })

  it("预览调服务端同一条渲染链，返回的 HTML 直接呈现，再点收起回文本域", async () => {
    const user = userEvent.setup()
    vi.mocked(commentsApi.list).mockResolvedValue({
      total: 1,
      threads: [thread()]
    })
    vi.mocked(commentsApi.preview).mockResolvedValue({
      html: "<p>预览段<strong>加粗</strong></p>"
    })
    renderSection()
    await screen.findByText("第一行")

    const composer = screen.getByRole("textbox", { name: "发表评论" })
    await user.type(composer, "草稿")
    await user.click(screen.getByRole("button", { name: "预览" }))

    expect(vi.mocked(commentsApi.preview)).toHaveBeenCalledWith(1, "草稿")
    expect(await screen.findByText("加粗")).toBeInTheDocument()
    expect(screen.queryByRole("textbox", { name: "发表评论" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "预览" }))
    expect(
      screen.getByRole("textbox", { name: "发表评论" })
    ).toBeInTheDocument()
    expect(screen.queryByText("加粗")).toBeNull()
  })

  it("列表拉取失败时给出错误与重试，成功后就地恢复", async () => {
    const user = userEvent.setup()
    vi.mocked(commentsApi.list).mockRejectedValueOnce(new ApiError(500, "boom"))
    renderSection()

    expect(await screen.findByRole("alert")).toHaveTextContent("boom")
    expect(screen.queryByRole("textbox", { name: "发表评论" })).toBeNull()

    vi.mocked(commentsApi.list).mockResolvedValue({
      total: 1,
      threads: [thread()]
    })
    await user.click(screen.getByRole("button", { name: "重试" }))
    expect(await screen.findByText("第一行")).toBeInTheDocument()
    expect(
      screen.getByRole("textbox", { name: "发表评论" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
  })
})

/** 输入框的文案与提交标签是 props：父组件传 t()，切语言后整块跟着变。 */
describe("页尾评论区英文界面", () => {
  beforeEach(async () => {
    vi.mocked(commentsApi.list).mockReset()
    vi.mocked(commentsApi.create).mockReset()
    vi.mocked(commentsApi.update).mockReset()
    vi.mocked(commentsApi.remove).mockReset()
    vi.mocked(commentsApi.preview).mockReset()
    vi.mocked(commentsApi.remove).mockResolvedValue({ success: true })
    vi.mocked(commentsApi.preview).mockResolvedValue({ html: "<p>Preview</p>" })
    await i18n.changeLanguage("en")
  })

  it("标题、发表框、预览与删除确认都按英文渲染", async () => {
    vi.mocked(commentsApi.list).mockResolvedValue({
      total: 1,
      threads: [thread({ editedAt: "2026-11-11T03:00:00.000Z" })]
    })
    renderSection()

    expect(
      await screen.findByRole("heading", { name: /^Comments/ })
    ).toBeInTheDocument()
    await screen.findByRole("textbox", { name: "Post a comment" })
    expect(screen.getByText("Edited")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reply" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Post" })).toBeInTheDocument()

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Delete" }))

    expect(await screen.findByText("Delete this comment?")).toBeInTheDocument()
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
  })
})
