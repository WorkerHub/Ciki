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
/** Confluence 标准亮红（拍板决策 B：夜间豁免提亮，严格保持原色） */
export const EXEMPT_RED_COLOR = "#de350b"

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
 * WCAG 相对亮度转 CIE 1976 感知亮度 L* (归一化范围 0.0 - 1.0)
 * https://en.wikipedia.org/wiki/CIELAB_color_space
 */
export function perceptualLightness(r: number, g: number, b: number): number {
  const y = relativeLuminance(r, g, b)
  return y <= 0.008856 ? (y * 903.3) / 100 : 1.16 * Math.cbrt(y) - 0.16
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

  // 拍板决策 B：#de350b（Confluence 标准亮红）夜间豁免提亮，严格保持原色
  if (normalized === EXEMPT_RED_COLOR) {
    return normalized
  }

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
 * - 压暗阈值按 WCAG 相对亮度/感知亮度判断：相对亮度 <= 0.18（感知亮度 L* <= 0.5）视为深色背景无需压暗；
 * - 原本较亮（HSL L > 0.5）的背景在 HSL 空间内对称映射到暗色区间：L' = 1 - L；
 * - 中点高饱和亮色（如 #ffab00 橙、#ffff00 黄、#00ffff 青，HSL L 恰为 0.5 但实际相对亮度高），
 *   按感知亮度对称压暗 L' = 1 - L*。
 */
export function adaptBackgroundColorForDark(
  hex: string | null | undefined
): string | null {
  const normalized = normalizeColor(hex)
  if (!normalized) return null
  const rgb = hexToRgb(normalized)
  if (!rgb) return null

  // 压暗阈值改用 WCAG 相对亮度/感知亮度判断，而非裸 HSL L 值：
  // 相对亮度 <= 0.18（感知亮度 L* <= 0.5）的背景本身已属于暗色区间，无需压暗
  const lum = relativeLuminance(rgb[0], rgb[1], rgb[2])
  if (lum <= 0.18) return normalized

  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2])

  // 对亮背景做对称压暗：
  // 对于常规浅色背景（HSL L > 0.5），采用对称压暗 L' = 1 - L；
  // 对于中点高饱和亮色（HSL L <= 0.5 但感知亮度高，如 #ffab00 橙、#ffff00 黄、#00ffff 青），
  // 裸 HSL L 无法体现真实亮度，按感知亮度做对称压暗 L' = 1 - L*
  const pLight = perceptualLightness(rgb[0], rgb[1], rgb[2])
  const darkL = l > 0.5 ? 1 - l : Math.max(0.05, 1 - pLight)

  const [r, g, b] = hslToRgb(h, s, darkL)
  return rgbToHex(r, g, b)
}

/**
 * 联合自适应文字颜色（拍板决策 A）：
 * 当文字颜色处于高亮（mark）或单元格底色（td/th）内时，
 * 以对称压暗后的有效背景色为基准计算并自适应文字颜色（保持「浅底深字 → 深底浅字」配对）。
 * 若未提供有效背景色（独立文字），则回退至默认深色背景（DEFAULT_DARK_BG）。
 */
export function adaptJointTextColorForDark(
  textColor: string | null | undefined,
  bgColor: string | null | undefined,
  targetContrast = WCAG_AA_CONTRAST
): string | null {
  const normalizedText = normalizeColor(textColor)
  if (!normalizedText) return null

  // 豁免亮红一律保持原色
  if (normalizedText === EXEMPT_RED_COLOR) {
    return normalizedText
  }

  const normalizedBg = normalizeColor(bgColor)
  // 有效底色：若有指定背景色，以对称压暗后的深色背景作为基准，否则以全局默认深底作为基准
  const effectiveDarkBg = normalizedBg
    ? (adaptBackgroundColorForDark(normalizedBg) ?? DEFAULT_DARK_BG)
    : DEFAULT_DARK_BG

  return adaptTextColorForDark(normalizedText, targetContrast, effectiveDarkBg)
}

/**
 * 对 DOM 根节点下的内联颜色载具应用联合自适应：
 * - 扫描所有 `span[data-text-color]` 与 `mark[data-color]`；
 * - 检查是否嵌套于高亮背景或表格单元格底色下；
 * - 动态计算并更新 `--dark-text-color` 变量。
 */
export function applyJointColorAdaptation(
  root: HTMLElement | null | undefined
) {
  if (!root) return

  // 1. 处理所有 span[data-text-color]
  const spans = root.querySelectorAll<HTMLElement>("span[data-text-color]")
  spans.forEach((span) => {
    const textColor = span.getAttribute("data-text-color")
    if (!textColor) return

    // 检查是否有外部 mark 包裹，或外部单元格底色包裹
    const mark = span.closest<HTMLElement>("mark[data-color]")
    const cell = span.closest<HTMLElement>("td[data-cell-bg], th[data-cell-bg]")

    const effectiveBg =
      mark?.getAttribute("data-color") ?? cell?.getAttribute("data-cell-bg")

    const darkColor = adaptJointTextColorForDark(textColor, effectiveBg)
    if (darkColor) {
      span.style.setProperty("--dark-text-color", darkColor)
    }
  })

  // 2. 处理嵌套在 span[data-text-color] 内的 mark[data-color]：
  // 当 span 包裹 mark 时，由于 mark 自身不是 span[data-text-color]，
  // 为 mark 注入针对该高亮底色的联合字色变量，避免 mark 内部文本继承 span 的默认深底字色。
  const marks = root.querySelectorAll<HTMLElement>("mark[data-color]")
  marks.forEach((mark) => {
    const parentSpan = mark.closest<HTMLElement>("span[data-text-color]")
    const markBg = mark.getAttribute("data-color")
    const textColor = parentSpan?.getAttribute("data-text-color")

    if (parentSpan && markBg && textColor) {
      const darkColor = adaptJointTextColorForDark(textColor, markBg)
      if (darkColor) {
        mark.style.setProperty("--dark-text-color", darkColor)
      }
    } else {
      mark.style.removeProperty("--dark-text-color")
    }
  })
}
