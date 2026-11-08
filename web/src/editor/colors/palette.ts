/**
 * 取色面板的预设标准色。
 *
 * 只做预设、不做自定义十六进制输入（主单口径）；色值取 Confluence 标准色，
 * 与用户从 Confluence 粘过来的颜色同一套，肉眼一致。
 * `value: null` 表示「清除」（回到正文默认色 / 无高亮 / 无底色）。
 */

export interface ColorOption {
  name: string
  value: string | null
}

export const TEXT_COLORS: ColorOption[] = [
  { name: "黑色", value: "#172b4d" },
  { name: "灰色", value: "#6b778c" },
  { name: "红色", value: "#de350b" },
  { name: "橙色", value: "#d97008" },
  { name: "黄色", value: "#a16207" },
  { name: "绿色", value: "#1f845a" },
  { name: "蓝色", value: "#0052cc" },
  { name: "紫色", value: "#6f42c1" },
  { name: "清除颜色", value: null }
]

export const HIGHLIGHT_COLORS: ColorOption[] = [
  { name: "黄色", value: "#ffe58f" },
  { name: "橙色", value: "#ffd7a8" },
  { name: "红色", value: "#ffd2cc" },
  { name: "绿色", value: "#baf5c0" },
  { name: "蓝色", value: "#cce0ff" },
  { name: "紫色", value: "#e4d5ff" },
  { name: "灰色", value: "#e4e6ea" },
  { name: "青色", value: "#c9f3f5" },
  { name: "清除高亮", value: null }
]

export const CELL_COLORS: ColorOption[] = [
  { name: "灰色", value: "#f4f5f7" },
  { name: "红色", value: "#ffebe6" },
  { name: "橙色", value: "#fff0b3" },
  { name: "黄色", value: "#fffae6" },
  { name: "绿色", value: "#e3fcef" },
  { name: "蓝色", value: "#deebff" },
  { name: "紫色", value: "#eae6ff" },
  { name: "青色", value: "#e6fcff" },
  { name: "清除底色", value: null }
]
