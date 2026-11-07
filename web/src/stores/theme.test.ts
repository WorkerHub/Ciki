import { beforeEach, describe, expect, it } from "vitest"
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
    localStorage.clear()
    useThemeStore.setState({ theme: "auto" })
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
})
