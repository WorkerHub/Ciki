import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SetupResult } from "@/lib/api"
import { DatabaseTab } from "@/pages/admin/DatabaseTab"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    adminApi: { ...actual.adminApi, runAsAdmin: vi.fn() }
  }
})

const { adminApi } = await import("@/lib/api")

const result: SetupResult = {
  success: true,
  tablePrefix: "ciki_",
  migrations: [
    { name: "schema_v1", status: "applied" },
    { name: "schema_v2", status: "skipped" }
  ]
}

describe("系统管理 · 数据库升级", () => {
  beforeEach(() => {
    vi.mocked(adminApi.runAsAdmin).mockReset()
  })

  it("只保留升级区：旧说明文字不再渲染", () => {
    render(<DatabaseTab />)

    expect(screen.getByText("数据库升级")).toBeInTheDocument()
    expect(screen.queryByText("数据库迁移")).toBeNull()
    expect(screen.queryByText(/没有删表/)).toBeNull()
    expect(screen.queryByText(/按站点约定/)).toBeNull()
    expect(screen.queryByText(/迁移是追加式的/)).toBeNull()
  })

  it("点「检查并升级数据库」后回显当前表前缀与迁移结果", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.runAsAdmin).mockResolvedValue(result)
    render(<DatabaseTab />)

    await user.click(screen.getByRole("button", { name: "检查并升级数据库" }))

    expect(adminApi.runAsAdmin).toHaveBeenCalledTimes(1)
    expect(await screen.findByText("当前表前缀")).toBeInTheDocument()
    expect(screen.queryByText("生效的表前缀")).toBeNull()
    expect(screen.getByText("ciki_")).toBeInTheDocument()
    expect(screen.getByText("schema_v1")).toBeInTheDocument()
    expect(screen.getByText("已应用")).toBeInTheDocument()
    expect(screen.getByText("已是最新")).toBeInTheDocument()
  })

  it("失败时回显错误且不显示升级结果", async () => {
    const user = userEvent.setup()
    vi.mocked(adminApi.runAsAdmin).mockRejectedValue(new Error("boom"))
    render(<DatabaseTab />)

    await user.click(screen.getByRole("button", { name: "检查并升级数据库" }))

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(screen.queryByText("当前表前缀")).toBeNull()
  })
})
