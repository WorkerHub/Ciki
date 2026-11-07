/** 主题：亮 / 暗 / 自动三档（规格 §3B）。 */

export type Theme = "auto" | "light" | "dark"

/** zustand persist 的存储键；web/index.html 的内联脚本也读这个键。 */
export const THEME_STORAGE_KEY = "ciki-theme"

export const THEME_OPTIONS: { value: Theme; label: string; hint: string }[] = [
  { value: "auto", label: "自动", hint: "跟随系统外观切换" },
  { value: "light", label: "浅色", hint: "始终使用浅色" },
  { value: "dark", label: "深色", hint: "始终使用深色" }
]

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

export function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme === "auto") return systemPrefersDark() ? "dark" : "light"
  return theme
}

/**
 * 把主题落到 <html>：
 * - `.dark` 给 shadcn 令牌用；
 * - `data-mode` + `color-scheme` 给 Kumo 的 light-dark() 用（它在 [data-mode="dark"] 里切 color-scheme）。
 * 首屏在同一套规则上由 index.html 的内联脚本先跑一次，避免闪烁。
 */
export function applyTheme(theme: Theme): "light" | "dark" {
  if (typeof document === "undefined") return resolveTheme(theme)
  const resolved = resolveTheme(theme)
  const dark = resolved === "dark"
  const root = document.documentElement
  root.classList.toggle("dark", dark)
  root.setAttribute("data-mode", dark ? "dark" : "light")
  root.style.colorScheme = dark ? "dark" : "light"
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute("content", dark ? "#0a0a0a" : "#ffffff")
  return resolved
}

/** 订阅系统明暗变化；返回取消订阅函数。 */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {}
  const query = window.matchMedia("(prefers-color-scheme: dark)")
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}
