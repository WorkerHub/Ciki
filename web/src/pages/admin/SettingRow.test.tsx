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
  it("可用时失焦会提交改动", () => {
    const onSave = vi.fn()
    render(row({ onSave }))
    const input = screen.getByLabelText("站点名称")

    fireEvent.change(input, { target: { value: "新站点" } })
    fireEvent.blur(input)

    expect(onSave).toHaveBeenCalledWith("新站点")
  })

  it("disabled（保存中）失焦不再提交", () => {
    const onSave = vi.fn()
    const { rerender } = render(row({ onSave }))
    const input = screen.getByLabelText("站点名称")

    fireEvent.change(input, { target: { value: "新站点" } })
    rerender(row({ onSave, disabled: true }))
    fireEvent.blur(input)

    expect(onSave).not.toHaveBeenCalled()
  })
})
