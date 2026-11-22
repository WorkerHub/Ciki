/**
 * 暗黑模式正文内联颜色无障碍可读性自适应算法（WCAG 2.1 相对对比度兜底）。
 *
 * 规范要求：
 * - 渲染层兜底：在深色背景下，对过暗的正文内联文字颜色根据 WCAG AA 标准（对比度 >= 4.5:1）
 *   进行亮度 (L) 提升兜底，严格保留原有色相 (H) 与饱和度 (S)；原本亮度已达标的颜色保持不变。
 * - 内联背景色（高亮 mark 与表格单元格底色 td/th）对称压暗：在 HSL 空间内对亮度做对称映射 (1 - L)，
 *   使暗黑模式下的浅色文字在带底色的文本上保持足够对比度与可读性。
 * - 纯函数设计，不依赖 DOM，零副作用。
 */

import { normalizeColor } from "./color"

export const DEFAULT_DARK_BG = "#222222"
export const WCAG_AA_CONTRAST = 4.5

/** 将十六进制颜色解析为 [R, G, B] (0-255) */
export function hexToRgb(hex: string): [number, number, number] | null {
  const normalized = normalizeColor(hex)
  if (!normalized) return null
  const r = Number.parseInt(normalized.slice(1, 3), 16)
  const g = Number.parseInt(normalized.slice(3, 5), 16)
  const b = Number.parseInt(normalized.slice(5, 7), 16)
  return [r, g, b]
}

/** 将 [R, G, B] 格式化为小写 `#rrggbb` 十六进制字符串 */
export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`
}

/**
 * RGB 转 HSL：
 * r, g, b 为 0-255；返回 [h (0-360), s (0-1), l (0-1)]
 */
export function rgbToHsl(
  r: number,
  g: number,
  b: number
): [number, number, number] {
  const rNorm = r / 255
  const gNorm = g / 255
  const bNorm = b / 255
  const max = Math.max(rNorm, gNorm, bNorm)
  const min = Math.min(rNorm, gNorm, bNorm)
  let h = 0
  let s = 0
  const l = (max + min) / 2

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case rNorm:
        h = (gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0)
        break
      case gNorm:
        h = (bNorm - rNorm) / d + 2
        break
      case bNorm:
        h = (rNorm - gNorm) / d + 4
        break
    }
    h /= 6
  }

  return [h * 360, s, l]
}

/**
 * HSL 转 RGB：
 * h: 0-360, s: 0-1, l: 0-1；返回 [r, g, b] (0-255 整数)
 */
export function hslToRgb(
  h: number,
  s: number,
  l: number
): [number, number, number] {
  const hNorm = (((h % 360) + 360) % 360) / 360
  let r: number
  let g: number
  let b: number

  if (s === 0) {
    r = g = b = l
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      let val = t
      if (val < 0) val += 1
      if (val > 1) val -= 1
      if (val < 1 / 6) return p + (q - p) * 6 * val
      if (val < 1 / 2) return q
      if (val < 2 / 3) return p + (q - p) * (2 / 3 - val) * 6
      return p
    }

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, hNorm + 1 / 3)
    g = hue2rgb(p, q, hNorm)
    b = hue2rgb(p, q, hNorm - 1 / 3)
  }

  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}

/**
 * WCAG 2.1 相对亮度（Relative Luminance）：
 * https://www.w3.org/WAI/GL/wiki/Relative_luminance
 */
export function relativeLuminance(r: number, g: number, b: number): number {
  const toLinear = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

/**
 * 计算两相对亮度之间的 WCAG 对比度（范围 1.0 - 21.0）
 */
export function contrastRatio(lum1: number, lum2: number): number {
  const lighter = Math.max(lum1, lum2)
  const darker = Math.min(lum1, lum2)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * 夜间模式文字颜色提亮自适应：
 * - 在固定深色背景（默认 #222222）下评估对比度；
 * - 若对比度已达标 (>= targetContrast 且比背景亮)，原色保持不变返回；
 * - 若对比度不足，固定色相 H 与饱和度 S，二分搜索寻找满足对比度 >= targetContrast 的最小亮度 L；
 * - 返回小写 `#rrggbb`，无法解析返回 null。
 */
export function adaptTextColorForDark(
  hex: string | null | undefined,
  targetContrast = WCAG_AA_CONTRAST,
  darkBg = DEFAULT_DARK_BG
): string | null {
  const normalized = normalizeColor(hex)
  if (!normalized) return null
  const rgb = hexToRgb(normalized)
  if (!rgb) return null

  const bgRgb = hexToRgb(darkBg) ?? [34, 34, 34]
  const bgLum = relativeLuminance(bgRgb[0], bgRgb[1], bgRgb[2])
  const curLum = relativeLuminance(rgb[0], rgb[1], rgb[2])

  // 原本亮度已达标且较背景亮：保持不变
  if (curLum >= bgLum && contrastRatio(curLum, bgLum) >= targetContrast) {
    return normalized
  }

  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2])
  let low = l
  let high = 1.0
  let best = 1.0

  // 20 次二分迭代，精度达到 2^-20 (~10^-6)
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2
    const [nr, ng, nb] = hslToRgb(h, s, mid)
    const midLum = relativeLuminance(nr, ng, nb)
    if (contrastRatio(midLum, bgLum) >= targetContrast) {
      best = mid
      high = mid
    } else {
      low = mid
    }
  }

  let [fr, fg, fb] = hslToRgb(h, s, best)
  // 弥补 Math.round 离散化引起的微小对比度折损，确保严格满足 >= targetContrast
  while (
    contrastRatio(relativeLuminance(fr, fg, fb), bgLum) < targetContrast &&
    best < 1.0
  ) {
    best = Math.min(1.0, best + 0.002)
    ;[fr, fg, fb] = hslToRgb(h, s, best)
  }

  return rgbToHex(fr, fg, fb)
}

/**
 * 夜间模式内联背景色（高亮/单元格背景）对称压暗：
 * - 保持色相 H 与饱和度 S 不变；
 * - 原本较亮（L > 0.5）的背景在 HSL 空间内对称映射到暗色区间：L' = 1 - L；
 * - 原本已经是深色（L <= 0.5）的背景维持原色不变。
 */
export function adaptBackgroundColorForDark(
  hex: string | null | undefined
): string | null {
  const normalized = normalizeColor(hex)
  if (!normalized) return null
  const rgb = hexToRgb(normalized)
  if (!rgb) return null

  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2])

  // 本身是深色背景则无需反转
  if (l <= 0.5) return normalized

  // 对称压暗：L' = 1 - L
  const darkL = 1 - l
  const [r, g, b] = hslToRgb(h, s, darkL)
  return rgbToHex(r, g, b)
}
