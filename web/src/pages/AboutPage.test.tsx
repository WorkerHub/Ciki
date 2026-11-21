import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { buildInfo } from "@/lib/build-info"
import { AboutPage } from "@/pages/AboutPage"

/** 用户定版介绍段：逐字比对，不引用源码常量（避免自证）。 */
const INTRO =
  "ciki 是团队内部使用的 wiki。页面按树组织，编辑器支持标题、代码块、表格、任务列表与图片；每次保存都会留下版本记录，可随时回滚，正文支持全文检索。成员按空间协作，登录支持 Passkey 与两步验证，也可用浏览器插件把外部页面剪藏进来。"

describe("关于页构建信息", () => {
  it("版本号显示 buildInfo.version 全串（无 g 前缀、无 +build）", () => {
    render(<AboutPage />)
    expect(screen.getByText(buildInfo.version)).toBeInTheDocument()
  })

  it("构建日期、构建时间分两行，时间带时区标注", () => {
    render(<AboutPage />)
    expect(screen.getByText("构建日期")).toBeInTheDocument()
    expect(screen.getByText("构建时间")).toBeInTheDocument()
    expect(screen.getByText(/\(UTC[+-]\d{2}:\d{2}\)$/)).toBeInTheDocument()
  })

  it("页眉不再有单独的「版本 1.0.0」行", () => {
    render(<AboutPage />)
    expect(screen.queryByText(/^版本 \d/)).toBeNull()
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

describe("关于页标题", () => {
  it("标题是「关于Ciki」", () => {
    render(<AboutPage />)

    expect(
      screen.getByRole("heading", { level: 1, name: "关于Ciki" })
    ).toBeInTheDocument()
  })
})
