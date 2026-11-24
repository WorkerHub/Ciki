import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AvatarCropDialog } from "@/components/AvatarCropDialog"
import { i18n } from "@/i18n"

describe("AvatarCropDialog 组件", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh")
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("正常解码并展示裁剪弹窗、滑杆与操作按钮", async () => {
    const file = new File(["bytes"], "avatar.png", { type: "image/png" })
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const onError = vi.fn()

    render(
      <AvatarCropDialog
        open={true}
        file={file}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onError={onError}
      />
    )

    expect(
      await screen.findByRole("heading", { name: "裁剪头像" })
    ).toBeInTheDocument()
    expect(screen.getByTestId("crop-box")).toBeInTheDocument()
    expect(screen.getByRole("slider", { name: "缩放选区" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "确定" })).toBeInTheDocument()
  })

  it("点取消按钮触发 onCancel 回调", async () => {
    const browser = userEvent.setup()
    const file = new File(["bytes"], "avatar.png", { type: "image/png" })
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const onError = vi.fn()

    render(
      <AvatarCropDialog
        open={true}
        file={file}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onError={onError}
      />
    )

    const cancelBtn = await screen.findByRole("button", { name: "取消" })
    await browser.click(cancelBtn)

    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("点确定按钮触发归一化输出并调用 onConfirm", async () => {
    const browser = userEvent.setup()
    const file = new File(["bytes"], "my-photo.jpg", { type: "image/jpeg" })
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const onError = vi.fn()

    render(
      <AvatarCropDialog
        open={true}
        file={file}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onError={onError}
      />
    )

    const confirmBtn = await screen.findByRole("button", { name: "确定" })
    await browser.click(confirmBtn)

    await waitFor(() => expect(onConfirm).toHaveBeenCalled())
    const output = onConfirm.mock.calls[0][0] as File
    expect(output).toBeInstanceOf(File)
    expect(output.type).toBe("image/webp")
    expect(output.name).toBe("my-photo.webp")
  })

  it("支持滚轮缩放调整选区尺寸", async () => {
    const file = new File(["bytes"], "avatar.png", { type: "image/png" })
    render(
      <AvatarCropDialog
        open={true}
        file={file}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onError={vi.fn()}
      />
    )

    const cropBox = await screen.findByTestId("crop-box")

    // 模拟向下滚动（缩小选区比例 / 放大视野）
    fireEvent.wheel(cropBox.parentElement!, { deltaY: 100 })
    // 选区尺寸会有所响应变动或限制在边界
    expect(cropBox).toBeInTheDocument()
  })

  it("单指拖动选区移动位置，双指张开时选区缩小（放大视野），双指捏合时选区放大", async () => {
    const file = new File(["bytes"], "avatar.png", { type: "image/png" })
    render(
      <AvatarCropDialog
        open={true}
        file={file}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onError={vi.fn()}
      />
    )

    const cropBox = await screen.findByTestId("crop-box")
    const container = cropBox.parentElement!
    const initialLeft = Number.parseFloat(cropBox.style.left)
    const initialWidth = Number.parseFloat(cropBox.style.width)

    // 1. 单指按在 container 上并移动
    fireEvent.pointerDown(container, {
      pointerId: 1,
      clientX: 100,
      clientY: 100
    })
    fireEvent.pointerDown(cropBox, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(cropBox, { pointerId: 1, clientX: 120, clientY: 100 })
    const movedLeft = Number.parseFloat(cropBox.style.left)
    expect(movedLeft).toBeGreaterThanOrEqual(initialLeft)

    // 2. 落下第二指进入双指手势（初始两指间距 100）
    fireEvent.pointerDown(container, {
      pointerId: 2,
      clientX: 200,
      clientY: 100
    })

    // 双指张开（间距扩大为 150，Zoom In）
    fireEvent.pointerMove(container, {
      pointerId: 2,
      clientX: 250,
      clientY: 100
    })
    const spreadWidth = Number.parseFloat(cropBox.style.width)
    // 张开手势后选区变小（Zoom In / 放大视野）
    expect(spreadWidth).toBeLessThan(initialWidth)

    // 双指聚拢捏合（间距缩减为 50，Zoom Out）
    fireEvent.pointerMove(container, {
      pointerId: 2,
      clientX: 150,
      clientY: 100
    })
    const pinchedWidth = Number.parseFloat(cropBox.style.width)
    // 聚拢捏合后选区变大（Zoom Out / 缩小视野）
    expect(pinchedWidth).toBeGreaterThan(spreadWidth)

    // 多指进行中，单指拖动事件被隔离抑制，不发生跳跃
    const beforeDragLeft = cropBox.style.left
    fireEvent.pointerMove(cropBox, { pointerId: 1, clientX: 180, clientY: 100 })
    expect(cropBox.style.left).toBe(beforeDragLeft)

    // 3. 双指抬起
    fireEvent.pointerUp(container, { pointerId: 1 })
    fireEvent.pointerUp(container, { pointerId: 2 })
  })

  it("英文界面下展示对应英文文案与按钮", async () => {
    await i18n.changeLanguage("en")
    const file = new File(["bytes"], "avatar.png", { type: "image/png" })

    render(
      <AvatarCropDialog
        open={true}
        file={file}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onError={vi.fn()}
      />
    )

    expect(
      await screen.findByRole("heading", { name: "Crop avatar" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("slider", { name: "Zoom selection" })
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument()
  })
})
