import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { UnsavedChangesGuard } from "@/components/unsaved-changes-guard"

describe("UnsavedChangesGuard", () => {
  it("在无 DataRouter 环境（单体渲染）下降级为不渲染任何内容", () => {
    const { asFragment } = render(<UnsavedChangesGuard isDirty={true} />)
    expect(asFragment().childNodes.length).toBe(0)
  })

  it("dirty 时挂载 beforeunload 监听，卸载时移除", () => {
    const addSpy = vi.spyOn(window, "addEventListener")
    const removeSpy = vi.spyOn(window, "removeEventListener")

    const { unmount } = render(<UnsavedChangesGuard isDirty={true} />)
    expect(addSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function))

    unmount()
    expect(removeSpy).toHaveBeenCalledWith(
      "beforeunload",
      expect.any(Function)
    )

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })
})
