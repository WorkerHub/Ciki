import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, useLocation } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CreateSpaceDialog } from "@/components/CreateSpaceDialog"
import { ApiError, type Space } from "@/lib/api"
import { useSpacesStore } from "@/stores/spaces"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    spacesApi: {
      ...actual.spacesApi,
      create: vi.fn()
    }
  }
})

const { spacesApi } = await import("@/lib/api")

const newSpace: Space = {
  id: 10,
  slug: "design-system",
  name: "设计系统",
  description: "系统描述",
  myRole: "admin",
  isDefault: false,
  createdAt: "2026-11-27T00:00:00.000Z",
  updatedAt: "2026-11-27T00:00:00.000Z"
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

function renderDialog({
  open = true,
  onOpenChange = vi.fn(),
  onSuccess = vi.fn()
}: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSuccess?: (space: Space) => void
} = {}) {
  return {
    onOpenChange,
    onSuccess,
    ...render(
      <MemoryRouter initialEntries={["/admin/spaces"]}>
        <CreateSpaceDialog
          open={open}
          onOpenChange={onOpenChange}
          onSuccess={onSuccess}
        />
        <LocationProbe />
      </MemoryRouter>
    )
  }
}

describe("新建空间共享对话框 (CreateSpaceDialog)", () => {
  beforeEach(() => {
    useSpacesStore.setState({
      spaces: [],
      status: "ready",
      error: null,
      currentId: null
    })
    vi.mocked(spacesApi.create).mockReset()
  })

  it("渲染名称、带 /s/ 前缀的空间地址与描述输入框", () => {
    renderDialog()
    expect(screen.getByRole("heading", { name: "新建空间" })).toBeInTheDocument()
    expect(screen.getByLabelText("空间名称")).toBeInTheDocument()
    expect(screen.getByLabelText("空间地址")).toBeInTheDocument()
    expect(screen.getByText("/s/")).toBeInTheDocument()
    expect(screen.getByLabelText("描述（可选）")).toBeInTheDocument()
  })

  it("未手动编辑 slug 时，输入名称实时跟随填充候选", async () => {
    const user = userEvent.setup()
    renderDialog()

    const nameInput = screen.getByLabelText("空间名称")
    const slugInput = screen.getByLabelText("空间地址")

    await user.type(nameInput, "Design System")
    expect(slugInput).toHaveValue("design-system")

    await user.clear(nameInput)
    await user.type(nameInput, "Pay Team")
    expect(slugInput).toHaveValue("pay-team")
  })

  it("纯中文名称时候选为空串", async () => {
    const user = userEvent.setup()
    renderDialog()

    const nameInput = screen.getByLabelText("空间名称")
    const slugInput = screen.getByLabelText("空间地址")

    await user.type(nameInput, "研发空间")
    expect(slugInput).toHaveValue("")
  })

  it("手动编辑 slug 框后再修改名称，slug 框不被覆盖", async () => {
    const user = userEvent.setup()
    renderDialog()

    const nameInput = screen.getByLabelText("空间名称")
    const slugInput = screen.getByLabelText("空间地址")

    await user.type(nameInput, "Design")
    expect(slugInput).toHaveValue("design")

    await user.clear(slugInput)
    await user.type(slugInput, "my-custom-slug")

    await user.type(nameInput, " System")
    expect(slugInput).toHaveValue("my-custom-slug")
  })

  it("手动输入非法 slug 即时提示错误，并不允许提交", async () => {
    const user = userEvent.setup()
    renderDialog()

    const nameInput = screen.getByLabelText("空间名称")
    const slugInput = screen.getByLabelText("空间地址")

    await user.type(nameInput, "Test Space")
    await user.clear(slugInput)
    await user.type(slugInput, "INVALID_SLUG!")

    expect(
      screen.getByText("只许 1–48 位小写字母、数字与单连字符，首尾不能为连字符")
    ).toBeInTheDocument()
    expect(slugInput).toHaveAttribute("aria-invalid", "true")

    await user.click(screen.getByRole("button", { name: "创建空间" }))
    expect(spacesApi.create).not.toHaveBeenCalled()
  })

  it("清空 slug 框后错误消除，提交时不发 slug 字段走后端自动生成", async () => {
    const user = userEvent.setup()
    vi.mocked(spacesApi.create).mockResolvedValue(newSpace)
    const { onOpenChange, onSuccess } = renderDialog()

    const nameInput = screen.getByLabelText("空间名称")
    const slugInput = screen.getByLabelText("空间地址")

    await user.type(nameInput, "Test Space")
    await user.clear(slugInput)

    expect(
      screen.queryByText("只许 1–48 位小写字母、数字与单连字符，首尾不能为连字符")
    ).toBeNull()

    await user.click(screen.getByRole("button", { name: "创建空间" }))

    expect(spacesApi.create).toHaveBeenCalledWith({
      name: "Test Space",
      description: ""
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSuccess).toHaveBeenCalledWith(newSpace)
    expect(screen.getByTestId("location")).toHaveTextContent("/")
  })

  it("未手动修改 slug 框时提交，不发 slug 字段（显示的候选仅供预填）", async () => {
    const user = userEvent.setup()
    vi.mocked(spacesApi.create).mockResolvedValue(newSpace)
    renderDialog()

    await user.type(screen.getByLabelText("空间名称"), "Team Alfa")
    await user.click(screen.getByRole("button", { name: "创建空间" }))

    expect(spacesApi.create).toHaveBeenCalledWith({
      name: "Team Alfa",
      description: ""
    })
  })

  it("手动输入合法 slug 时，提交包含 slug 字段", async () => {
    const user = userEvent.setup()
    vi.mocked(spacesApi.create).mockResolvedValue(newSpace)
    renderDialog()

    await user.type(screen.getByLabelText("空间名称"), "Design")
    const slugInput = screen.getByLabelText("空间地址")
    await user.clear(slugInput)
    await user.type(slugInput, "design-core")

    await user.click(screen.getByRole("button", { name: "创建空间" }))

    expect(spacesApi.create).toHaveBeenCalledWith({
      name: "Design",
      description: "",
      slug: "design-core"
    })
  })

  it("后端返回 409 冲突时就地展示冲突错误信息", async () => {
    const user = userEvent.setup()
    vi.mocked(spacesApi.create).mockRejectedValue(
      new ApiError(409, "Space slug is already taken", "SPACE_SLUG_TAKEN")
    )
    renderDialog()

    await user.type(screen.getByLabelText("空间名称"), "Design")
    const slugInput = screen.getByLabelText("空间地址")
    await user.clear(slugInput)
    await user.type(slugInput, "taken-slug")

    await user.click(screen.getByRole("button", { name: "创建空间" }))

    expect(screen.getByText("这个空间地址已被占用")).toBeInTheDocument()
    expect(slugInput).toHaveAttribute("aria-invalid", "true")
  })

  it("名称为空时提交提示名称必填", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("button", { name: "创建空间" }))
    expect(screen.getByText("请填写空间名称")).toBeInTheDocument()
    expect(spacesApi.create).not.toHaveBeenCalled()
  })
})
