import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { AboutPage } from "@/pages/AboutPage"

/**
 * 关于页「构建时间」按 ISO 8601 UTC 直出（秒级、`Z` 后缀），值内不含汉字与括号。
 * 用例里的注入值来自 web/vitest.config.ts：2026-01-01T00:00:00.000Z。
 */
describe("关于页构建时间", () => {
  const buildTimeValue = () => {
    render(<AboutPage />)
    const label = screen.getByText("构建时间")
    return label.nextElementSibling?.textContent ?? ""
  }

  it("值形如 YYYY-MM-DDTHH:mm:ssZ，且与注入时刻是同一瞬间", () => {
    const value = buildTimeValue()
    expect(value).toBe("2026-01-01T00:00:00Z")
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it("值内没有汉字与括号（不再带「（北京时间）」）", () => {
    const value = buildTimeValue()
    expect(value).not.toMatch(/[\u4e00-\u9fff（）()]/)
    expect(value).not.toContain("北京时间")
  })

  it("字段标签保持「构建时间」不变", () => {
    render(<AboutPage />)
    expect(screen.getByText("构建时间")).toBeInTheDocument()
  })
})
