import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { App } from "./App"

describe("骨架占位页", () => {
  it("渲染标题、卡片说明与占位按钮", () => {
    render(<App />)

    expect(screen.getByRole("heading", { name: /ciki/ })).toBeInTheDocument()
    expect(screen.getByText("脚手架就位")).toBeInTheDocument()
    expect(screen.getByText(/Confluence 粘贴保真/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "占位按钮" })).toBeInTheDocument()
  })

  it("版本号来自构建期注入（define），不是写死的字符串", () => {
    render(<App />)

    expect(screen.getByText(/构建版本：test-build/)).toBeInTheDocument()
  })
})
