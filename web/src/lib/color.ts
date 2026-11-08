/**
 * 颜色值的唯一形态 —— 与后端冻结契约（docs/api-contract.md「服务端消毒规则」）逐字对齐。
 *
 * 全链路只认小写 `#rrggbb`：TipTap JSON 里存它，contentHtml 的 data 载具（data-text-color /
 * data-color / data-cell-bg）也存它。所以浏览器把内联样式序列化成 `rgb(222, 53, 11)`
 * 之后必须能再归一回来，否则「粘贴一次 → 存一次」就会把颜色值写成本地化后的形态。
 * 归一不出来的写法（var(--x)、命名色、半透明、oklch()…）一律丢弃，不猜。
 */

/** 契约形态：小写六位十六进制。 */
const HEX_COLOR = /^#[0-9a-f]{6}$/

/**
 * 颜色字面量的长度上限：合法形态最长也就 `rgba(255, 255, 255, 1)`（22 字符）。
 * 先挡长度再做正则匹配，畸形超长输入（剪贴板恶意 style 里的几万个连续空格）
 * 连一次回溯都不发生。
 */
const MAX_COLOR_LENGTH = 64

const SHORT_HEX = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/
// 分隔符写成互斥的「逗号 + 可选空白」或「若干空白」：两种写法不会吃同一批字符，
// 引擎不需要在同一个空白串上反复回溯（`\s*[,\s]\s*` 那种写法是 O(n²) 的）。
const RGB =
  /^rgba?\(\s*(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/

function channel(raw: string): string {
  const value = Math.min(255, Number.parseInt(raw, 10))
  return value.toString(16).padStart(2, "0")
}

/** 任意 CSS 颜色写法 → `#rrggbb`；归一不了（或带透明度）返回 null。 */
export function normalizeColor(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_COLOR_LENGTH) return null
  const value = raw.trim().toLowerCase()
  if (HEX_COLOR.test(value)) return value
  const short = SHORT_HEX.exec(value)
  if (short) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  }
  const rgb = RGB.exec(value)
  if (!rgb) return null
  // 带 alpha 的一律不收：高亮/底色半透明会让正文可读性不可控
  if (rgb[4] !== undefined && rgb[4] !== "1") return null
  return `#${channel(rgb[1])}${channel(rgb[2])}${channel(rgb[3])}`
}
