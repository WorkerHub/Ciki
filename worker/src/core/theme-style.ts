/**
 * 主题风格（Theme Style）：Nova / 纸面（Paper）。
 * 服务端存储于 users.theme_style（TEXT NOT NULL DEFAULT 'nova'）。
 */

export const SUPPORTED_THEME_STYLES = ["nova", "paper"] as const

export type ThemeStyle = (typeof SUPPORTED_THEME_STYLES)[number]

export const DEFAULT_THEME_STYLE: ThemeStyle = "nova"

/** 精确匹配：仅 'nova' 或 'paper'。 */
export function isThemeStyle(value: unknown): value is ThemeStyle {
  return (
    typeof value === "string" &&
    (SUPPORTED_THEME_STYLES as readonly string[]).includes(value)
  )
}

/** 任意来源 → 支持集内的风格；不在集合里一律回退默认值 'nova'。 */
export function normalizeThemeStyle(value: unknown): ThemeStyle {
  return isThemeStyle(value) ? value : DEFAULT_THEME_STYLE
}
