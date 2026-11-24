import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { PageCanvas } from "@/components/PageCanvas"

describe("PageCanvas 文章页正文画布", () => {
  it("正确渲染子元素且画布本身不设横向裁剪，避免裁切聚焦环", () => {
    render(
      <PageCanvas>
        <div data-testid="child-content">正文内容</div>
      </PageCanvas>
    )

    const child = screen.getByTestId("child-content")
    expect(child).toBeInTheDocument()

    const canvas = child.closest("[data-page-canvas]")
    expect(canvas).toBeInTheDocument()
    expect(canvas).not.toHaveClass("overflow-x-clip")
    expect(canvas).not.toHaveClass("[overflow-clip-margin:4px]")
  })

  it("外层容器提供固定内边距与最大宽度约束", () => {
    const { container } = render(
      <PageCanvas>
        <div>测试</div>
      </PageCanvas>
    )

    const outer = container.firstChild as HTMLElement
    expect(outer).toHaveClass("w-full", "px-4", "py-5", "sm:px-6", "sm:py-6")

    const canvas = outer.querySelector("[data-page-canvas]")
    expect(canvas).toHaveClass("mx-auto", "w-full", "max-w-[1600px]")
  })
})
