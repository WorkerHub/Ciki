import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api"
import { SetupPage } from "@/pages/auth/SetupPage"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    setupApi: { ...actual.setupApi, state: vi.fn(), run: vi.fn() }
  }
})

const { setupApi } = await import("@/lib/api")

const renderSetup = () =>
  render(
    <MemoryRouter initialEntries={["/setup"]}>
      <SetupPage />
    </MemoryRouter>
  )

describe("初始化页", () => {
  beforeEach(() => {
    vi.mocked(setupApi.state).mockResolvedValue({
      initialized: false,
      enabled: true
    })
    vi.mocked(setupApi.run).mockResolvedValue({
      success: true,
      tablePrefix: "ciki_",
      migrations: [{ name: "schema_v1", status: "applied" }]
    })
  })

  it("密钥框是 password、autocomplete=off、id/name 固定为 setup-secret", async () => {
    renderSetup()
    const secret = await screen.findByLabelText("SETUP_SECRET")
    expect(secret).toHaveAttribute("type", "password")
    expect(secret).toHaveAttribute("id", "setup-secret")
    expect(secret).toHaveAttribute("name", "setup-secret")
    expect(secret).toHaveAttribute("autocomplete", "off")
  })

  it("提交后回显生效前缀与迁移结果", async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.type(await screen.findByLabelText("SETUP_SECRET"), "s3cret")
    await user.click(screen.getByRole("button", { name: "初始化数据库" }))

    expect(setupApi.run).toHaveBeenCalledWith("s3cret")
    expect(await screen.findByText("初始化完成")).toBeInTheDocument()
    expect(screen.getByText("ciki_")).toBeInTheDocument()
    expect(screen.getByText("已应用")).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "注册首个管理员账号" })
    ).toBeInTheDocument()
  })

  it("密钥错误时给出中文提示，且不展示结果", async () => {
    vi.mocked(setupApi.run).mockRejectedValue(
      new ApiError(403, "Invalid setup secret")
    )
    const user = userEvent.setup()
    renderSetup()
    await user.type(await screen.findByLabelText("SETUP_SECRET"), "wrong")
    await user.click(screen.getByRole("button", { name: "初始化数据库" }))

    expect(await screen.findByText(/初始化密钥不正确/)).toBeInTheDocument()
    expect(screen.queryByText("初始化完成")).not.toBeInTheDocument()
  })

  it("前缀冲突时说明另一套前缀已存在", async () => {
    vi.mocked(setupApi.run).mockRejectedValue(
      new ApiError(409, "prefix conflict", "PREFIX_CONFLICT", undefined, {
        detectedPrefixes: ["other_"],
        resolvedPrefix: "ciki_"
      })
    )
    const user = userEvent.setup()
    renderSetup()
    await user.type(await screen.findByLabelText("SETUP_SECRET"), "s3cret")
    await user.click(screen.getByRole("button", { name: "初始化数据库" }))

    expect(await screen.findByText(/other_/)).toBeInTheDocument()
    expect(screen.getAllByText(/初始化已中止/).length).toBeGreaterThan(0)
  })

  it("初始化页已关闭时不再给初始化表单", async () => {
    vi.mocked(setupApi.state).mockResolvedValue({
      initialized: true,
      enabled: false
    })
    renderSetup()
    expect(await screen.findByText(/已完成初始化/)).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "初始化数据库" })
    ).not.toBeInTheDocument()
  })
})
