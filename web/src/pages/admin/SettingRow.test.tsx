import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { SettingTextRow } from "@/pages/admin/SettingRow"

function row(props: { disabled?: boolean; onSave: () => void }) {
  return (
    <SettingTextRow
      label="站点名称"
      description="显示在浏览器页签与品牌区"
      value="Ciki"
      {...props}
    />
  )
}

describe("SettingTextRow", () => {
  it("值未改变时保存按钮禁用，修改后可点", () => {
    const onSave = vi.fn()
    render(row({ onSave }))
    const input = screen.getByLabelText("站点名称")
    const saveButton = screen.getByRole("button", { name: "保存" })

    expect(saveButton).toBeDisabled()
    fireEvent.change(input, { target: { value: "新站点" } })
    expect(saveButton).toBeEnabled()
  })

  it("失焦不调用 onSave，输入保留为草稿", () => {
    const onSave = vi.fn()
    render(row({ onSave }))
    const input = screen.getByLabelText("站点名称")

    fireEvent.change(input, { target: { value: "新站点" } })
    fireEvent.blur(input)

    expect(onSave).not.toHaveBeenCalled()
    expect(input).toHaveValue("新站点")
  })

  it("点击保存按钮提交改动", () => {
    const onSave = vi.fn()
    render(row({ onSave }))
    const input = screen.getByLabelText("站点名称")
    const saveButton = screen.getByRole("button", { name: "保存" })

    fireEvent.change(input, { target: { value: "新站点" } })
    fireEvent.click(saveButton)

    expect(onSave).toHaveBeenCalledWith("新站点")
  })

  it("Enter 键提交改动", () => {
    const onSave = vi.fn()
    render(row({ onSave }))
    const input = screen.getByLabelText("站点名称")

    fireEvent.change(input, { target: { value: "新站点" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(onSave).toHaveBeenCalledWith("新站点")
  })

  it("Escape 键还原为已保存值并禁用保存按钮", () => {
    const onSave = vi.fn()
    render(row({ onSave }))
    const input = screen.getByLabelText("站点名称")
    const saveButton = screen.getByRole("button", { name: "保存" })

    fireEvent.change(input, { target: { value: "新站点" } })
    expect(saveButton).toBeEnabled()

    fireEvent.keyDown(input, { key: "Escape" })
    expect(input).toHaveValue("Ciki")
    expect(saveButton).toBeDisabled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it("disabled（保存中）按钮与输入均禁用且不提交", () => {
    const onSave = vi.fn()
    const { rerender } = render(row({ onSave }))
    const input = screen.getByLabelText("站点名称")
    const saveButton = screen.getByRole("button", { name: "保存" })

    fireEvent.change(input, { target: { value: "新站点" } })
    rerender(row({ onSave, disabled: true }))

    expect(input).toBeDisabled()
    expect(saveButton).toBeDisabled()

    fireEvent.click(saveButton)
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.blur(input)

    expect(onSave).not.toHaveBeenCalled()
  })
})
