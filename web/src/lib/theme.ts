/** 主题明暗模式：亮 / 暗 / 自动三档（规格 §3B）。 */
export type ThemeMode = "auto" | "light" | "dark"

/** 主题风格（外观）：现行 Nova / 纸面 (Paper) / 自然 (Natural) / 墨纸 (E-Ink) */
export type ThemeStyle = "nova" | "paper" | "natural" | "eink"

/** zustand persist 的存储键；web/index.html 的内联脚本也读这个键。 */
export const THEME_STORAGE_KEY = "ciki-theme"

export interface ThemeDefinition {
  id: ThemeStyle
  labelKey: string
  metaColor: {
    light: string
    dark: string
  }
}

export const THEME_META_COLORS: Record<
  ThemeStyle,
  { light: string; dark: string }
> = (typeof window !== "undefined" &&
  (
    window as unknown as {
      __THEME_META_COLORS__?: Record<
        ThemeStyle,
        { light: string; dark: string }
      >
    }
  ).__THEME_META_COLORS__) || {
  nova: { light: "#ffffff", dark: "#0a0a0a" },
  paper: { light: "#f7f4ee", dark: "#0b0c0e" },
  natural: { light: "#faf6f1", dark: "#191612" },
  eink: { light: "#f5f3ea", dark: "#171814" }
}

export const THEME_STYLES: ThemeDefinition[] = [
  {
    id: "nova",
    labelKey: "common.theme.style.nova",
    metaColor: THEME_META_COLORS.nova
  },
  {
    id: "paper",
    labelKey: "common.theme.style.paper",
    metaColor: THEME_META_COLORS.paper
  },
  {
    id: "natural",
    labelKey: "common.theme.style.natural",
    metaColor: THEME_META_COLORS.natural
  },
  {
    id: "eink",
    labelKey: "common.theme.style.eink",
    metaColor: THEME_META_COLORS.eink
  }
]

export const DEFAULT_THEME_STYLE: ThemeStyle = "nova"

export function isThemeStyle(style: unknown): style is ThemeStyle {
  return typeof style === "string" && THEME_STYLES.some((s) => s.id === style)
}

export function getThemeDefinition(style: ThemeStyle): ThemeDefinition {
  return THEME_STYLES.find((s) => s.id === style) ?? THEME_STYLES[0]
}

export const THEME_STYLE_OPTIONS: {
  value: ThemeStyle
  labelKey: string
}[] = THEME_STYLES.map((def) => ({
  value: def.id,
  labelKey: def.labelKey
}))

/** 三档的可选值与其文案 key：文案在 `locales/*.json` 的 `common.theme.*`。 */
export const THEME_MODE_OPTIONS: {
  value: ThemeMode
  labelKey: string
  hintKey: string
}[] = [
  {
    value: "auto",
    labelKey: "common.theme.auto.label",
    hintKey: "common.theme.auto.hint"
  },
  {
    value: "light",
    labelKey: "common.theme.light.label",
    hintKey: "common.theme.light.hint"
  },
  {
    value: "dark",
    labelKey: "common.theme.dark.label",
    hintKey: "common.theme.dark.hint"
  }
]

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

export function resolveMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "auto") return systemPrefersDark() ? "dark" : "light"
  if (mode === "dark") return "dark"
  return "light"
}

/**
 * 把主题与风格落到 <html>：
 * - `data-theme`: "nova" | "paper" | "natural" | "eink" 驱动主题风格令牌；
 * - `.dark` 给 shadcn 令牌用；
 * - `data-mode` + `color-scheme` 给 Kumo 的 light-dark() 用（它在 [data-mode="dark"] 里切 color-scheme）。
 * - `meta[name="theme-color"]`: 对齐对应主题在浅/深下的页面基色。
 * 首屏在同一套规则上由 index.html 的内联脚本先跑一次，避免闪烁。
 */
export function applyTheme(
  mode: ThemeMode,
  style: ThemeStyle = DEFAULT_THEME_STYLE
): "light" | "dark" {
  const safeMode: ThemeMode =
    mode === "light" || mode === "dark" ? mode : "auto"
  const safeStyle: ThemeStyle = isThemeStyle(style)
    ? style
    : DEFAULT_THEME_STYLE
  if (typeof document === "undefined") return resolveMode(safeMode)
  const resolved = resolveMode(safeMode)
  const dark = resolved === "dark"
  const root = document.documentElement
  root.classList.toggle("dark", dark)
  root.setAttribute("data-mode", dark ? "dark" : "light")
  root.setAttribute("data-theme", safeStyle)
  root.style.colorScheme = dark ? "dark" : "light"
  const def = getThemeDefinition(safeStyle)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    meta.setAttribute(
      "content",
      dark ? def.metaColor.dark : def.metaColor.light
    )
  }
  return resolved
}

/** 订阅系统明暗变化；返回取消订阅函数。 */
export function watchSystemMode(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {}
  const query = window.matchMedia("(prefers-color-scheme: dark)")
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}
