import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { i18n } from "@/i18n"
import type { Me } from "@/lib/api"
import { ProfilePage } from "@/pages/ProfilePage"
import { useAuthStore } from "@/stores/auth"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    meApi: {
      ...actual.meApi,
      updateProfile: vi.fn(),
      uploadAvatar: vi.fn()
    }
  }
})

const { meApi } = await import("@/lib/api")

const user: Me = {
  id: 1,
  username: "小明",
  avatarUrl: null,
  email: "xiaoming@example.com",
  role: "user",
  approvalStatus: "approved",
  createdAt: "2026-11-07T00:00:00.000Z",
  twofa: {
    totpEnabled: false,
    passkeyEnabled: false,
    passkeyCount: 0,
    emailOtpEnabled: false
  }
}

function setUser(value: Me = user) {
  useAuthStore.setState({ user: value, status: "ready", restricted: false })
}

describe("个人资料页", () => {
  beforeEach(() => {
    setUser()
    vi.mocked(meApi.updateProfile).mockReset()
    vi.mocked(meApi.uploadAvatar).mockReset()
  })

  it("只读展示邮箱，用户名默认纯文本展示并带修改按钮；无常驻输入框，未选文件无保存按钮", () => {
    render(<ProfilePage />)

    expect(screen.getByText("xiaoming@example.com")).toBeInTheDocument()
    // 对外身份只有用户名：个人页没有「用户 ID」这一行
    expect(screen.queryByText("用户 ID")).toBeNull()
    expect(screen.queryByText("AB23CD45")).toBeNull()
    // 默认展示态：无输入框，纯文本展示用户名与修改按钮
    expect(screen.queryByRole("textbox", { name: "用户名" })).toBeNull()
    expect(screen.getByText("小明")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "修改" })).toBeInTheDocument()
    // 未选头像文件时，页面上不渲染保存按钮
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull()
  })

  it("点「修改」进编辑态，展示输入框并预填当前用户名与自动聚焦，带保存与取消", async () => {
    const browser = userEvent.setup()
    render(<ProfilePage />)

    await browser.click(screen.getByRole("button", { name: "修改" }))

    const input = screen.getByLabelText("用户名")
    expect(input).toBeInTheDocument()
    expect(input).toHaveValue("小明")
    expect(input).toHaveFocus()
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument()
  })

  it("取消编辑丢弃修改、回展示态且不发请求", async () => {
    const browser = userEvent.setup()
    render(<ProfilePage />)

    await browser.click(screen.getByRole("button", { name: "修改" }))
    await browser.clear(screen.getByLabelText("用户名"))
    await browser.type(screen.getByLabelText("用户名"), "改动但想取消")
    await browser.click(screen.getByRole("button", { name: "取消" }))

    expect(meApi.updateProfile).not.toHaveBeenCalled()
    expect(screen.queryByRole("textbox", { name: "用户名" })).toBeNull()
    expect(screen.getByText("小明")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "修改" })).toBeInTheDocument()
  })

  it("用户名为空时拦截并不发请求，错误提示并停留在编辑态", async () => {
    const browser = userEvent.setup()
    render(<ProfilePage />)

    await browser.click(screen.getByRole("button", { name: "修改" }))
    await browser.clear(screen.getByLabelText("用户名"))
    await browser.click(screen.getByRole("button", { name: "保存" }))

    expect(screen.getByRole("alert")).toHaveTextContent("用户名不能为空")
    expect(meApi.updateProfile).not.toHaveBeenCalled()
    expect(screen.getByLabelText("用户名")).toBeInTheDocument()
  })

  it("改用户名保存成功后回写 store 并显示成功提示，回展示态且新名生效", async () => {
    const browser = userEvent.setup()
    const updated = { ...user, username: "新名字" }
    vi.mocked(meApi.updateProfile).mockResolvedValue(updated)
    render(<ProfilePage />)

    await browser.click(screen.getByRole("button", { name: "修改" }))
    await browser.clear(screen.getByLabelText("用户名"))
    await browser.type(screen.getByLabelText("用户名"), "  新名字  ")
    await browser.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() =>
      expect(meApi.updateProfile).toHaveBeenCalledWith({ username: "新名字" })
    )
    expect(screen.getByRole("status")).toHaveTextContent("个人资料已保存")
    expect(useAuthStore.getState().user?.username).toBe("新名字")
    expect(screen.queryByRole("textbox", { name: "用户名" })).toBeNull()
    expect(screen.getByText("新名字")).toBeInTheDocument()
  })

  it("改名失败（如重名）报错并停留在编辑态，可修改后重试", async () => {
    const browser = userEvent.setup()
    vi.mocked(meApi.updateProfile)
      .mockRejectedValueOnce(new Error("USERNAME_TAKEN"))
      .mockResolvedValueOnce({ ...user, username: "可用名字" })
    render(<ProfilePage />)

    await browser.click(screen.getByRole("button", { name: "修改" }))
    await browser.clear(screen.getByLabelText("用户名"))
    await browser.type(screen.getByLabelText("用户名"), "已占用名字")
    await browser.click(screen.getByRole("button", { name: "保存" }))

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    // 停留在编辑态
    expect(screen.getByLabelText("用户名")).toBeInTheDocument()

    // 重试
    await browser.clear(screen.getByLabelText("用户名"))
    await browser.type(screen.getByLabelText("用户名"), "可用名字")
    await browser.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("个人资料已保存")
    )
    expect(screen.queryByRole("textbox", { name: "用户名" })).toBeNull()
    expect(screen.getByText("可用名字")).toBeInTheDocument()
  })

  it("选头像后保存按钮出现，保存时走头像专用上传口且不提交用户名", async () => {
    const browser = userEvent.setup()
    const withAvatar = {
      ...user,
      avatarUrl: "/api/files/avatars/avatar-key.png"
    }
    vi.mocked(meApi.uploadAvatar).mockResolvedValue(withAvatar)
    render(<ProfilePage />)

    expect(screen.queryByRole("button", { name: "保存" })).toBeNull()

    const file = new File(["png"], "avatar.png", { type: "image/png" })
    await browser.upload(screen.getByLabelText("选择头像"), file)
    expect(screen.queryByRole("alert")).toBeNull()

    // 选头像后，页面级保存按钮出现
    const saveBtn = screen.getByRole("button", { name: "保存" })
    expect(saveBtn).toBeInTheDocument()

    await browser.click(saveBtn)

    await waitFor(() => expect(meApi.uploadAvatar).toHaveBeenCalledWith(file))
    // 用户名未改：不调 updateProfile
    expect(meApi.updateProfile).not.toHaveBeenCalled()
    expect(useAuthStore.getState().user?.avatarUrl).toBe(
      "/api/files/avatars/avatar-key.png"
    )
    expect(screen.getByRole("status")).toHaveTextContent("个人资料已保存")
    // 保存完成后，待上传文件已清空，保存按钮消失
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull()
  })

  it("先选头像又点修改时，两个保存按钮按规格字面并存保留", async () => {
    const browser = userEvent.setup()
    render(<ProfilePage />)

    const file = new File(["png"], "avatar.png", { type: "image/png" })
    await browser.upload(screen.getByLabelText("选择头像"), file)
    expect(screen.getAllByRole("button", { name: "保存" })).toHaveLength(1)

    await browser.click(screen.getByRole("button", { name: "修改" }))
    // 此时头像保存按钮与用户名保存按钮同时出现
    expect(screen.getAllByRole("button", { name: "保存" })).toHaveLength(2)
  })

  it("不支持的图片类型在选文件时就报错，不发上传请求且不出现保存按钮", async () => {
    // applyAccept: false —— 绕过 input 的 accept 过滤，验证组件自己的校验
    const browser = userEvent.setup({ applyAccept: false })
    render(<ProfilePage />)

    const file = new File(["svg"], "logo.svg", { type: "image/svg+xml" })
    await browser.upload(screen.getByLabelText("选择头像"), file)

    expect(screen.getByRole("alert")).toHaveTextContent(/只支持 PNG/)
    expect(meApi.uploadAvatar).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull()
  })

  it("默认展示一句话简介，点「修改简介」进入编辑态并展示 Textarea 与字符数", async () => {
    setUser({ ...user, bio: "热爱开源与知识库构建" })
    const browser = userEvent.setup()
    render(<ProfilePage />)

    expect(screen.getByText("一句话简介")).toBeInTheDocument()
    expect(screen.getByText("热爱开源与知识库构建")).toBeInTheDocument()
    const editBioBtn = screen.getByRole("button", { name: "修改简介" })
    expect(editBioBtn).toBeInTheDocument()
    expect(screen.queryByLabelText("一句话简介")).toBeNull()

    await browser.click(editBioBtn)

    const textarea = screen.getByLabelText("一句话简介")
    expect(textarea).toBeInTheDocument()
    expect(textarea).toHaveValue("热爱开源与知识库构建")
    expect(screen.getByText("10/100")).toBeInTheDocument()
  })

  it("简介修改并保存成功后回写 store 与通知，成功返回展示态", async () => {
    const browser = userEvent.setup()
    const updated = { ...user, bio: "全栈开发者，专注协同软件" }
    vi.mocked(meApi.updateProfile).mockResolvedValue(updated)
    render(<ProfilePage />)

    await browser.click(screen.getByRole("button", { name: "修改简介" }))
    const textarea = screen.getByLabelText("一句话简介")
    await browser.clear(textarea)
    await browser.type(textarea, "  全栈开发者，专注协同软件  ")

    const saveBtn = screen.getByRole("button", { name: "保存" })
    await browser.click(saveBtn)

    await waitFor(() =>
      expect(meApi.updateProfile).toHaveBeenCalledWith({
        bio: "全栈开发者，专注协同软件"
      })
    )
    expect(screen.getByRole("status")).toHaveTextContent("个人资料已保存")
    expect(useAuthStore.getState().user?.bio).toBe("全栈开发者，专注协同软件")
    expect(screen.queryByLabelText("一句话简介")).toBeNull()
    expect(screen.getByText("全栈开发者，专注协同软件")).toBeInTheDocument()
  })

  it("简介超过 100 码点时展示超长提示并禁用保存按钮", async () => {
    const browser = userEvent.setup()
    render(<ProfilePage />)

    await browser.click(screen.getByRole("button", { name: "修改简介" }))
    const textarea = screen.getByLabelText("一句话简介")
    const longBio = "字".repeat(101)
    await browser.type(textarea, longBio)

    expect(screen.getByText("简介不能超过 100 个字符。")).toBeInTheDocument()
    expect(screen.getByText("101/100")).toBeInTheDocument()
    const saveBtn = screen.getByRole("button", { name: "保存" })
    expect(saveBtn).toBeDisabled()
  })

  it("取消简介编辑丢弃修改、恢复原值并返回展示态", async () => {
    setUser({ ...user, bio: "原始简介" })
    const browser = userEvent.setup()
    render(<ProfilePage />)

    await browser.click(screen.getByRole("button", { name: "修改简介" }))
    const textarea = screen.getByLabelText("一句话简介")
    await browser.type(textarea, "想改但取消")
    await browser.click(screen.getByRole("button", { name: "取消" }))

    expect(meApi.updateProfile).not.toHaveBeenCalled()
    expect(screen.queryByLabelText("一句话简介")).toBeNull()
    expect(screen.getByText("原始简介")).toBeInTheDocument()
  })
})

describe("个人资料页 · 英文界面", () => {
  beforeEach(() => setUser())

  it("展示态显示 Edit 按钮与纯文本，点 Edit 展开 Username 输入框与 Save/Cancel", async () => {
    await i18n.changeLanguage("en")
    const browser = userEvent.setup()
    render(<ProfilePage />)

    expect(screen.getByText("Profile")).toBeInTheDocument()
    expect(screen.getByText("Avatar")).toBeInTheDocument()
    expect(screen.getByLabelText("Choose an avatar")).toBeInTheDocument()
    expect(screen.getByText("Email")).toBeInTheDocument()
    // 默认展示态
    expect(screen.queryByRole("textbox", { name: "Username" })).toBeNull()
    expect(screen.getByText("小明")).toBeInTheDocument()
    const editBtn = screen.getByRole("button", { name: "Edit" })
    expect(editBtn).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()

    // 进入编辑态
    await browser.click(editBtn)
    expect(screen.getByLabelText("Username")).toHaveValue("小明")
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()

    // 验证 Bio 卡片在英文环境下的呈现
    expect(screen.getByText("Bio")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Edit bio" })).toBeInTheDocument()
  })
})
