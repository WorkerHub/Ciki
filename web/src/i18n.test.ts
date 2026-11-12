import { beforeEach, describe, expect, it } from "vitest"
import { applyAccountLanguage, changeLanguage, currentLanguage } from "@/i18n"
import {
  detectBrowserLanguage,
  isLanguage,
  LANGUAGE_STORAGE_KEY,
  readStoredLanguage,
  SUPPORTED_LANGUAGES
} from "@/lib/language"

describe("语言代码与浏览器语言", () => {
  it("只认支持集内的值", () => {
    expect(SUPPORTED_LANGUAGES).toEqual(["zh", "en"])
    expect(isLanguage("zh")).toBe(true)
    expect(isLanguage("en")).toBe(true)
    expect(isLanguage("fr")).toBe(false)
    expect(isLanguage(null)).toBe(false)
  })

  it("navigator.language 以 en 开头取英文，其余中文", () => {
    expect(detectBrowserLanguage("en-US")).toBe("en")
    expect(detectBrowserLanguage("en")).toBe("en")
    expect(detectBrowserLanguage("zh-CN")).toBe("zh")
    expect(detectBrowserLanguage("fr-FR")).toBe("zh")
    expect(detectBrowserLanguage("")).toBe("zh")
  })
})

describe("localStorage 里的语言选择", () => {
  it("合法值可读写，非法值当作没有", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "en")
    expect(readStoredLanguage()).toBe("en")
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "fr")
    expect(readStoredLanguage()).toBeNull()
  })

  it("切换语言时写入 localStorage，并同步 <html lang>", async () => {
    await changeLanguage("en")
    expect(currentLanguage()).toBe("en")
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en")
    expect(document.documentElement.lang).toBe("en")
  })
})

describe("applyAccountLanguage", () => {
  beforeEach(async () => {
    await changeLanguage("zh")
  })

  it("账号语言覆盖本机选择，并同步 localStorage 与 <html lang>", async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "zh")
    await applyAccountLanguage("en")
    expect(currentLanguage()).toBe("en")
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en")
    expect(document.documentElement.lang).toBe("en")
  })

  it("缺字段或非法值不覆盖当前语言", async () => {
    await applyAccountLanguage(undefined)
    await applyAccountLanguage(null)
    await applyAccountLanguage("fr")
    expect(currentLanguage()).toBe("zh")
    expect(document.documentElement.lang).toBe("zh")
  })
})
