/**
 * 取色面板的预设标准色。
 *
 * 只做预设、不做自定义十六进制输入（主单口径）；色值取 Confluence 标准色，
 * 与用户从 Confluence 粘过来的颜色同一套，肉眼一致。
 * `value: null` 表示「清除」（回到正文默认色 / 无高亮 / 无底色）。
 *
 * 颜色名只存 key（editor.colors.*），渲染时由 ColorMenu 用 t() 取文字：
 * 数据里不留任何语言的文案，切语言即时生效。
 */

export interface ColorOption {
  labelKey: string
  value: string | null
}

export const TEXT_COLORS: ColorOption[] = [
  { labelKey: "editor.colors.black", value: "#172b4d" },
  { labelKey: "editor.colors.gray", value: "#6b778c" },
  { labelKey: "editor.colors.red", value: "#de350b" },
  { labelKey: "editor.colors.orange", value: "#d97008" },
  { labelKey: "editor.colors.yellow", value: "#a16207" },
  { labelKey: "editor.colors.green", value: "#1f845a" },
  { labelKey: "editor.colors.blue", value: "#0052cc" },
  { labelKey: "editor.colors.purple", value: "#6f42c1" },
  { labelKey: "editor.colors.clearText", value: null }
]

export const HIGHLIGHT_COLORS: ColorOption[] = [
  { labelKey: "editor.colors.yellow", value: "#ffe58f" },
  { labelKey: "editor.colors.orange", value: "#ffd7a8" },
  { labelKey: "editor.colors.red", value: "#ffd2cc" },
  { labelKey: "editor.colors.green", value: "#baf5c0" },
  { labelKey: "editor.colors.blue", value: "#cce0ff" },
  { labelKey: "editor.colors.purple", value: "#e4d5ff" },
  { labelKey: "editor.colors.gray", value: "#e4e6ea" },
  { labelKey: "editor.colors.cyan", value: "#c9f3f5" },
  { labelKey: "editor.colors.clearHighlight", value: null }
]

export const CELL_COLORS: ColorOption[] = [
  { labelKey: "editor.colors.gray", value: "#f4f5f7" },
  { labelKey: "editor.colors.red", value: "#ffebe6" },
  { labelKey: "editor.colors.orange", value: "#fff0b3" },
  { labelKey: "editor.colors.yellow", value: "#fffae6" },
  { labelKey: "editor.colors.green", value: "#e3fcef" },
  { labelKey: "editor.colors.blue", value: "#deebff" },
  { labelKey: "editor.colors.purple", value: "#eae6ff" },
  { labelKey: "editor.colors.cyan", value: "#e6fcff" },
  { labelKey: "editor.colors.clearCell", value: null }
]
