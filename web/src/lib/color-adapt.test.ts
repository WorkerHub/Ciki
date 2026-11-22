import { describe, expect, it } from "vitest"
import {
  DEFAULT_DARK_BG,
  WCAG_AA_CONTRAST,
  adaptBackgroundColorForDark,
  adaptTextColorForDark,
  contrastRatio,
  hexToRgb,
  hslToRgb,
  relativeLuminance,
  rgbToHex,
  rgbToHsl
} from "./color-adapt"

describe("颜色转换与 WCAG 算法纯函数", () => {
  it("hex 与 RGB 互转", () => {
    expect(hexToRgb("#ffffff")).toEqual([255, 255, 255])
    expect(hexToRgb("#000000")).toEqual([0, 0, 0])
    expect(hexToRgb("#de350b")).toEqual([222, 53, 11])
    expect(hexToRgb("invalid")).toBeNull()

    expect(rgbToHex(255, 255, 255)).toBe("#ffffff")
    expect(rgbToHex(0, 0, 0)).toBe("#000000")
    expect(rgbToHex(222, 53, 11)).toBe("#de350b")
  })

  it("RGB 与 HSL 互转保持一致", () => {
    const testRgb: [number, number, number][] = [
      [222, 53, 11],
      [0, 82, 204],
      [217, 112, 8],
      [128, 128, 128],
      [0, 0, 0],
      [255, 255, 255]
    ]
    for (const [r, g, b] of testRgb) {
      const [h, s, l] = rgbToHsl(r, g, b)
      const [r2, g2, b2] = hslToRgb(h, s, l)
      expect(Math.abs(r - r2)).toBeLessThanOrEqual(1)
      expect(Math.abs(g - g2)).toBeLessThanOrEqual(1)
      expect(Math.abs(b - b2)).toBeLessThanOrEqual(1)
    }
  })

  it("相对亮度与对比度符合 WCAG 标准", () => {
    const blackLum = relativeLuminance(0, 0, 0)
    const whiteLum = relativeLuminance(255, 255, 255)
    expect(blackLum).toBeCloseTo(0, 4)
    expect(whiteLum).toBeCloseTo(1, 4)

    // 黑白对比度为 21:1
    expect(contrastRatio(whiteLum, blackLum)).toBeCloseTo(21, 0)
    // 同色对比度为 1:1
    expect(contrastRatio(whiteLum, whiteLum)).toBeCloseTo(1, 4)
  })
})

describe("adaptTextColorForDark（夜间模式文字颜色自适应）", () => {
  const bgRgb = hexToRgb(DEFAULT_DARK_BG)!
  const bgLum = relativeLuminance(bgRgb[0], bgRgb[1], bgRgb[2])

  it("过暗文字提亮后在深色背景下对比度 >= 4.5:1", () => {
    const darkColors = [
      "#172b4d", // 预设深黑/深蓝
      "#0052cc", // 预设蓝色
      "#de350b", // 预设红色
      "#000000", // 纯黑
      "#6f42c1", // 预设紫色
      "#1f845a", // 预设绿色
      "#6b778c" // 预设灰色
    ]

    for (const color of darkColors) {
      const adapted = adaptTextColorForDark(color)!
      expect(adapted).toBeTruthy()
      expect(adapted).not.toBe(color)

      const rgb = hexToRgb(adapted)!
      const lum = relativeLuminance(rgb[0], rgb[1], rgb[2])
      const cr = contrastRatio(lum, bgLum)
      expect(cr).toBeGreaterThanOrEqual(WCAG_AA_CONTRAST)
    }
  })

  it("已经达标 (>= 4.5:1) 的文字颜色原样保持不变", () => {
    // #d97008 在 #222222 下对比度约为 4.75:1，已达标
    expect(adaptTextColorForDark("#d97008")).toBe("#d97008")
    // #ffffff 纯白对比度 16:1，已达标
    expect(adaptTextColorForDark("#ffffff")).toBe("#ffffff")
  })

  it("提亮时保持色相 H 与饱和度 S 恒定", () => {
    const testColors = ["#0052cc", "#de350b", "#1f845a", "#6f42c1"]
    for (const color of testColors) {
      const [r1, g1, b1] = hexToRgb(color)!
      const [h1, s1, l1] = rgbToHsl(r1, g1, b1)

      const adapted = adaptTextColorForDark(color)!
      const [r2, g2, b2] = hexToRgb(adapted)!
      const [h2, s2, l2] = rgbToHsl(r2, g2, b2)

      // 色相误差在 1 度以内
      expect(Math.abs(h1 - h2)).toBeLessThanOrEqual(1.0)
      // 饱和度误差在 0.03 以内（受 8-bit RGB 离散化影响）
      expect(Math.abs(s1 - s2)).toBeLessThanOrEqual(0.03)
      // 亮度必须提升
      expect(l2).toBeGreaterThan(l1)
    }
  })

  it("非法/空输入安全返回 null", () => {
    expect(adaptTextColorForDark(null)).toBeNull()
    expect(adaptTextColorForDark(undefined)).toBeNull()
    expect(adaptTextColorForDark("")).toBeNull()
    expect(adaptTextColorForDark("not-a-color")).toBeNull()
  })
})

describe("adaptBackgroundColorForDark（夜间模式背景对称压暗）", () => {
  it("较亮背景（L > 0.5）做对称压暗 (L' = 1 - L)", () => {
    const lightBgs = [
      "#ffe58f", // 预设黄色高亮
      "#ffd7a8", // 预设橙色高亮
      "#ffd2cc", // 预设红色高亮
      "#baf5c0", // 预设绿色高亮
      "#cce0ff", // 预设蓝色高亮
      "#f4f5f7", // 预设浅灰表格背景
      "#ffebe6", // 预设浅红表格背景
      "#fffae6" // 预设浅黄表格背景
    ]

    for (const bg of lightBgs) {
      const [r1, g1, b1] = hexToRgb(bg)!
      const [h1, s1, l1] = rgbToHsl(r1, g1, b1)
      expect(l1).toBeGreaterThan(0.5)

      const adapted = adaptBackgroundColorForDark(bg)!
      expect(adapted).toBeTruthy()
      expect(adapted).not.toBe(bg)

      const [r2, g2, b2] = hexToRgb(adapted)!
      const [h2, s2, l2] = rgbToHsl(r2, g2, b2)

      // 色相与饱和度保持恒定
      expect(Math.abs(h1 - h2)).toBeLessThanOrEqual(1.0)
      expect(Math.abs(s1 - s2)).toBeLessThanOrEqual(0.03)
      // 亮度对称：l2 接近 1 - l1
      expect(Math.abs(l2 - (1 - l1))).toBeLessThanOrEqual(0.02)
    }
  })

  it("纯白 (#ffffff) 对称压暗为纯黑 (#000000)", () => {
    expect(adaptBackgroundColorForDark("#ffffff")).toBe("#000000")
  })

  it("已经是深色的背景 (L <= 0.5) 保持原色不变", () => {
    expect(adaptBackgroundColorForDark("#000000")).toBe("#000000")
    expect(adaptBackgroundColorForDark("#222222")).toBe("#222222")
    expect(adaptBackgroundColorForDark("#123456")).toBe("#123456")
  })

  it("非法/空输入安全返回 null", () => {
    expect(adaptBackgroundColorForDark(null)).toBeNull()
    expect(adaptBackgroundColorForDark(undefined)).toBeNull()
    expect(adaptBackgroundColorForDark("")).toBeNull()
    expect(adaptBackgroundColorForDark("not-a-color")).toBeNull()
  })
})
