import { beforeEach, describe, expect, it } from "vitest"
import { THEME_META_COLORS } from "@/lib/theme"
import { useThemeStore } from "@/stores/theme"

function setSystemDark(dark: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: dark,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

const isDark = () => document.documentElement.classList.contains("dark")

describe("主题三档（亮 / 暗 / 自动）", () => {
  beforeEach(() => {
    document.documentElement.className = ""
    document.documentElement.removeAttribute("data-mode")
    document.documentElement.removeAttribute("data-theme")
    localStorage.clear()
    useThemeStore.setState({ theme: "auto", style: "nova" })
  })

  it("深色档：写 .dark、data-mode 与 color-scheme，并持久化", () => {
    useThemeStore.getState().setTheme("dark")
    expect(isDark()).toBe(true)
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark")
    expect(document.documentElement.style.colorScheme).toBe("dark")
    expect(localStorage.getItem("ciki-theme")).toContain('"theme":"dark"')
  })

  it("浅色档：撤掉 .dark，Kumo 的 data-mode 同步为 light", () => {
    useThemeStore.getState().setTheme("dark")
    useThemeStore.getState().setTheme("light")
    expect(isDark()).toBe(false)
    expect(document.documentElement.getAttribute("data-mode")).toBe("light")
    expect(useThemeStore.getState().resolved).toBe("light")
  })

  it("自动档跟随系统，系统变化时重算", () => {
    setSystemDark(true)
    useThemeStore.getState().setTheme("auto")
    expect(isDark()).toBe(true)
    expect(useThemeStore.getState().resolved).toBe("dark")

    setSystemDark(false)
    useThemeStore.getState().syncSystem()
    expect(isDark()).toBe(false)
    expect(useThemeStore.getState().resolved).toBe("light")
  })

  it("自动档下系统切到深色时 syncSystem 会跟随", () => {
    setSystemDark(false)
    useThemeStore.getState().setTheme("auto")
    expect(isDark()).toBe(false)
    setSystemDark(true)
    useThemeStore.getState().syncSystem()
    expect(isDark()).toBe(true)
  })

  it("风格切换：切至纸面写 data-theme=paper 并持久化，切回 Nova 写 data-theme=nova", () => {
    useThemeStore.getState().setStyle("paper")
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper")
    expect(localStorage.getItem("ciki-theme")).toContain('"style":"paper"')

    useThemeStore.getState().setStyle("nova")
    expect(document.documentElement.getAttribute("data-theme")).toBe("nova")
    expect(localStorage.getItem("ciki-theme")).toContain('"style":"nova"')
  })

  it("2 主题 × 2 模式矩阵：各组合下属性、meta theme-color 与类名准确落定", () => {
    let meta = document.querySelector('meta[name="theme-color"]')
    if (!meta) {
      meta = document.createElement("meta")
      meta.setAttribute("name", "theme-color")
      document.head.appendChild(meta)
    }

    // 1. Nova 浅色
    useThemeStore.getState().setStyle("nova")
    useThemeStore.getState().setTheme("light")
    expect(document.documentElement.getAttribute("data-theme")).toBe("nova")
    expect(document.documentElement.getAttribute("data-mode")).toBe("light")
    expect(isDark()).toBe(false)
    expect(meta.getAttribute("content")).toBe("#ffffff")

    // 2. Nova 深色
    useThemeStore.getState().setStyle("nova")
    useThemeStore.getState().setTheme("dark")
    expect(document.documentElement.getAttribute("data-theme")).toBe("nova")
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark")
    expect(isDark()).toBe(true)
    expect(meta.getAttribute("content")).toBe("#0a0a0a")

    // 3. 纸面 浅色
    useThemeStore.getState().setStyle("paper")
    useThemeStore.getState().setTheme("light")
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper")
    expect(document.documentElement.getAttribute("data-mode")).toBe("light")
    expect(isDark()).toBe(false)
    expect(meta.getAttribute("content")).toBe("#f7f4ee")

    // 4. 纸面 深色
    useThemeStore.getState().setStyle("paper")
    useThemeStore.getState().setTheme("dark")
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper")
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark")
    expect(isDark()).toBe(true)
    expect(meta.getAttribute("content")).toBe("#0b0c0e")
  })

  it("THEME_META_COLORS 与各主题 light/dark 颜色保持单一真源", () => {
    expect(THEME_META_COLORS.nova.light).toBe("#ffffff")
    expect(THEME_META_COLORS.nova.dark).toBe("#0a0a0a")
    expect(THEME_META_COLORS.paper.light).toBe("#f7f4ee")
    expect(THEME_META_COLORS.paper.dark).toBe("#0b0c0e")
  })
})
