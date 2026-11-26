import { describe, expect, it } from "vitest"
import {
  DEFAULT_THEME_STYLE,
  isThemeStyle,
  normalizeThemeStyle,
  SUPPORTED_THEME_STYLES
} from "../src/core/theme-style"

describe("theme-style 核心定义与校验", () => {
  it("支持集与默认值：nova, paper, natural, eink, notion, sketch, distill，默认值为 nova", () => {
    expect(SUPPORTED_THEME_STYLES).toEqual([
      "nova",
      "paper",
      "natural",
      "eink",
      "notion",
      "sketch",
      "distill"
    ])
    expect(DEFAULT_THEME_STYLE).toBe("nova")
  })

  it("isThemeStyle：合法风格返回 true，其余一律 false", () => {
    expect(isThemeStyle("nova")).toBe(true)
    expect(isThemeStyle("paper")).toBe(true)
    expect(isThemeStyle("natural")).toBe(true)
    expect(isThemeStyle("eink")).toBe(true)
    expect(isThemeStyle("notion")).toBe(true)
    expect(isThemeStyle("sketch")).toBe(true)
    expect(isThemeStyle("distill")).toBe(true)

    expect(isThemeStyle("dark")).toBe(false)
    expect(isThemeStyle("light")).toBe(false)
    expect(isThemeStyle("auto")).toBe(false)
    expect(isThemeStyle("NOVA")).toBe(false)
    expect(isThemeStyle(" paper ")).toBe(false)
    expect(isThemeStyle("")).toBe(false)
    expect(isThemeStyle(null)).toBe(false)
    expect(isThemeStyle(undefined)).toBe(false)
    expect(isThemeStyle(123)).toBe(false)
    expect(isThemeStyle({})).toBe(false)
  })

  it("normalizeThemeStyle：合法风格原样返回，其余回退默认 nova", () => {
    expect(normalizeThemeStyle("nova")).toBe("nova")
    expect(normalizeThemeStyle("paper")).toBe("paper")
    expect(normalizeThemeStyle("natural")).toBe("natural")
    expect(normalizeThemeStyle("eink")).toBe("eink")
    expect(normalizeThemeStyle("notion")).toBe("notion")
    expect(normalizeThemeStyle("sketch")).toBe("sketch")
    expect(normalizeThemeStyle("distill")).toBe("distill")

    expect(normalizeThemeStyle("unknown")).toBe("nova")
    expect(normalizeThemeStyle("")).toBe("nova")
    expect(normalizeThemeStyle(null)).toBe("nova")
    expect(normalizeThemeStyle(undefined)).toBe("nova")
  })
})
