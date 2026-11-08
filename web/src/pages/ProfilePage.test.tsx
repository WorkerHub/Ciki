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
    api: { ...actual.api, upload: vi.fn() },
    meApi: { ...actual.meApi, updateProfile: vi.fn() }
  }
})

const { api, meApi } = await import("@/lib/api")

const user: Me = {
  id: "u1",
  publicId: "AB23CD45",
  username: "小明",
  avatarUrl: null,
  email: "xiaoming@example.com",
  role: "user",
  approvalStatus: "approved",
  createdAt: "2026-11-07T00:00:00.000Z",
  twofa: { totpEnabled: false, passkeyEnabled: false, passkeyCount: 0 }
}

function setUser(value: Me = user) {
  useAuthStore.setState({ user: value, status: "ready", restricted: false })
}

describe("个人资料页", () => {
  beforeEach(() => {
    setUser()
    vi.mocked(api.upload).mockReset()
    vi.mocked(meApi.updateProfile).mockReset()
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

  it("选头像后保存时先走 /api/files 上传，再用 key 更新资料", async () => {
    const browser = userEvent.setup()
    vi.mocked(api.upload).mockResolvedValue({
      key: "avatar-key.png",
      url: "/api/files/avatar-key.png",
      contentType: "image/png",
      size: 3
    })
    vi.mocked(meApi.updateProfile).mockResolvedValue({
      ...user,
      avatarUrl: "/api/files/avatar-key.png"
    })
    render(<ProfilePage />)

    const file = new File(["png"], "avatar.png", { type: "image/png" })
    await browser.upload(screen.getByLabelText("选择头像"), file)
    expect(screen.queryByRole("alert")).toBeNull()

    await browser.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() =>
      expect(meApi.updateProfile).toHaveBeenCalledWith({
        avatarKey: "avatar-key.png"
      })
    )
    expect(api.upload).toHaveBeenCalledWith(file)
    expect(useAuthStore.getState().user?.avatarUrl).toBe(
      "/api/files/avatar-key.png"
    )
  })

  it("上传成功但资料更新失败后重试，复用已上传的 key，不重复上传", async () => {
    const browser = userEvent.setup()
    vi.mocked(api.upload).mockResolvedValue({
      key: "avatar-key.png",
      url: "/api/files/avatar-key.png",
      contentType: "image/png",
      size: 3
    })
    vi.mocked(meApi.updateProfile)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({
        ...user,
        avatarUrl: "/api/files/avatar-key.png"
      })
    render(<ProfilePage />)

    const file = new File(["png"], "avatar.png", { type: "image/png" })
    await browser.upload(screen.getByLabelText("选择头像"), file)

    await browser.click(screen.getByRole("button", { name: "保存" }))
    await waitFor(() => expect(meApi.updateProfile).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole("alert")).toBeInTheDocument()

    // 第一次更新失败后文件仍在；再点保存应直接复用 key，而不是再传一次
    await browser.click(screen.getByRole("button", { name: "保存" }))
    await waitFor(() => expect(meApi.updateProfile).toHaveBeenCalledTimes(2))
    expect(api.upload).toHaveBeenCalledTimes(1)
    expect(meApi.updateProfile).toHaveBeenLastCalledWith({
      avatarKey: "avatar-key.png"
    })
    expect(screen.getByRole("status")).toHaveTextContent("个人资料已保存")
  })

  it("不支持的图片类型在选文件时就报错，不发上传请求", async () => {
    // applyAccept: false —— 绕过 input 的 accept 过滤，验证组件自己的校验
    const browser = userEvent.setup({ applyAccept: false })
    render(<ProfilePage />)

    const file = new File(["svg"], "logo.svg", { type: "image/svg+xml" })
    await browser.upload(screen.getByLabelText("选择头像"), file)

    expect(screen.getByRole("alert")).toHaveTextContent(/只支持 PNG/)
    expect(api.upload).not.toHaveBeenCalled()
  })
})
