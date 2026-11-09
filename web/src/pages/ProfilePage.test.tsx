import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
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
  id: "u1",
  publicId: "AB23CD45",
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

  it("只读展示用户 ID 与邮箱，用户名取当前显示名", () => {
    render(<ProfilePage />)

    expect(screen.getByText("AB23CD45")).toBeInTheDocument()
    expect(screen.getByText("xiaoming@example.com")).toBeInTheDocument()
    expect(screen.getByLabelText("用户名")).toHaveValue("小明")
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled()
  })

  it("用户名为空时不发请求", async () => {
    const browser = userEvent.setup()
    render(<ProfilePage />)

    await browser.clear(screen.getByLabelText("用户名"))
    await browser.click(screen.getByRole("button", { name: "保存" }))

    expect(screen.getByRole("alert")).toHaveTextContent("用户名不能为空")
    expect(meApi.updateProfile).not.toHaveBeenCalled()
  })

  it("改用户名保存成功后回写 store 并显示成功提示", async () => {
    const browser = userEvent.setup()
    const updated = { ...user, username: "新名字" }
    vi.mocked(meApi.updateProfile).mockResolvedValue(updated)
    render(<ProfilePage />)

    await browser.clear(screen.getByLabelText("用户名"))
    await browser.type(screen.getByLabelText("用户名"), "  新名字  ")
    await browser.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() =>
      expect(meApi.updateProfile).toHaveBeenCalledWith({ username: "新名字" })
    )
    expect(screen.getByRole("status")).toHaveTextContent("个人资料已保存")
    expect(useAuthStore.getState().user?.username).toBe("新名字")
  })

  it("选头像后保存时走头像专用上传口，并用返回资料回写 store", async () => {
    const browser = userEvent.setup()
    const withAvatar = {
      ...user,
      avatarUrl: "/api/files/avatars/avatar-key.png"
    }
    vi.mocked(meApi.uploadAvatar).mockResolvedValue(withAvatar)
    render(<ProfilePage />)

    const file = new File(["png"], "avatar.png", { type: "image/png" })
    await browser.upload(screen.getByLabelText("选择头像"), file)
    expect(screen.queryByRole("alert")).toBeNull()

    await browser.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() => expect(meApi.uploadAvatar).toHaveBeenCalledWith(file))
    // 用户名没变：不再额外提交一次资料
    expect(meApi.updateProfile).not.toHaveBeenCalled()
    expect(useAuthStore.getState().user?.avatarUrl).toBe(
      "/api/files/avatars/avatar-key.png"
    )
    expect(screen.getByRole("status")).toHaveTextContent("个人资料已保存")
  })

  it("用户名先保存；头像失败时保留已选文件，再次保存只重试头像", async () => {
    const browser = userEvent.setup()
    const renamed = { ...user, username: "新名字" }
    vi.mocked(meApi.updateProfile).mockResolvedValue(renamed)
    vi.mocked(meApi.uploadAvatar)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({
        ...renamed,
        avatarUrl: "/api/files/avatars/avatar-key.png"
      })
    render(<ProfilePage />)

    const file = new File(["png"], "avatar.png", { type: "image/png" })
    await browser.upload(screen.getByLabelText("选择头像"), file)
    await browser.clear(screen.getByLabelText("用户名"))
    await browser.type(screen.getByLabelText("用户名"), "新名字")
    await browser.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() => expect(meApi.uploadAvatar).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole("alert")).toBeInTheDocument()
    // 头像失败不影响已经成功的用户名
    expect(useAuthStore.getState().user?.username).toBe("新名字")

    await browser.click(screen.getByRole("button", { name: "保存" }))
    await waitFor(() => expect(meApi.uploadAvatar).toHaveBeenCalledTimes(2))
    expect(meApi.updateProfile).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState().user?.avatarUrl).toBe(
      "/api/files/avatars/avatar-key.png"
    )
  })

  it("不支持的图片类型在选文件时就报错，不发上传请求", async () => {
    // applyAccept: false —— 绕过 input 的 accept 过滤，验证组件自己的校验
    const browser = userEvent.setup({ applyAccept: false })
    render(<ProfilePage />)

    const file = new File(["svg"], "logo.svg", { type: "image/svg+xml" })
    await browser.upload(screen.getByLabelText("选择头像"), file)

    expect(screen.getByRole("alert")).toHaveTextContent(/只支持 PNG/)
    expect(meApi.uploadAvatar).not.toHaveBeenCalled()
  })
})
