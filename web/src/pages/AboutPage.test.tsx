import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { AboutPage } from "@/pages/AboutPage"

/** 用户定版介绍段：逐字比对，不引用源码常量（避免自证）。 */
const INTRO =
  "ciki 是团队内部使用的 wiki。页面按树组织，编辑器支持标题、代码块、表格、任务列表与图片；每次保存都会留下版本记录，可随时回滚，正文支持全文检索。成员按空间协作，登录支持 Passkey 与两步验证，也可用浏览器插件把外部页面剪藏进来。"

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

  it("值内没有汉字与括号（不再附带时区文字）", () => {
    const value = buildTimeValue()
    expect(value).not.toMatch(/[\u4e00-\u9fff（）()]/)
  })

  it("字段标签保持「构建时间」不变", () => {
    render(<AboutPage />)
    expect(screen.getByText("构建时间")).toBeInTheDocument()
  })
})

describe("关于页文案：删三处 + 换介绍段 + TipTap 3", () => {
  it("页顶副标题与构建信息卡的 CI 注入说明都不再渲染", () => {
    render(<AboutPage />)

    expect(
      screen.queryByText("把 Confluence 页面原样粘进来的团队 wiki。")
    ).toBeNull()
    expect(
      screen.queryByText("版本号与构建时间由 CI 在构建时注入，源码里不写死。")
    ).toBeNull()
  })

  it("「粘贴保真的边界」整卡已删（标题与帮助提示都不留）", () => {
    render(<AboutPage />)

    expect(screen.queryByText("粘贴保真的边界")).toBeNull()
    expect(
      screen.queryByText("顶栏的「帮助」里有完整支持矩阵与操作快捷键。")
    ).toBeNull()
  })

  it("介绍段是选定稿原文", () => {
    render(<AboutPage />)

    expect(screen.getByText(INTRO)).toBeInTheDocument()
  })

  it("技术栈的编辑器行锁定为 TipTap 3 与原有扩展清单", () => {
    render(<AboutPage />)

    expect(
      screen.getByText(
        /^TipTap 3（StarterKit \/ CodeBlockLowlight \/ Table \/ TaskList \/ Image \/ Link \/ Underline）$/
      )
    ).toBeInTheDocument()
  })
})
