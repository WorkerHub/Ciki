/**
 * 界面语言：只认支持集内的语言代码（规格 §2.1/§2.2）。
 * 当前语言由 i18next 持有，这里只放常量与浏览器 / 存储侧的归一逻辑。
 * 后续加语言 = 支持集加一行 + `web/src/locales` 加一份 JSON。
 */

export const SUPPORTED_LANGUAGES = ["zh", "en"] as const

export type Language = (typeof SUPPORTED_LANGUAGES)[number]

export const DEFAULT_LANGUAGE: Language = "zh"

/** 未登录页的语言选择存 localStorage；登录后以账号语言为准并同步这里。 */
export const LANGUAGE_STORAGE_KEY = "ciki-language"

export function isLanguage(value: unknown): value is Language {
  return (
    typeof value === "string" &&
    (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
  )
}

/** 规格 §2.3：浏览器语言以 `en` 开头取英文，其余一律中文。 */
export function detectBrowserLanguage(
  navigatorLanguage = typeof navigator === "undefined" ? "" : navigator.language
): Language {
  return navigatorLanguage.toLowerCase().startsWith("en")
    ? "en"
    : DEFAULT_LANGUAGE
}

export function readStoredLanguage(): Language | null {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    return isLanguage(stored) ? stored : null
  } catch {
    return null
  }
}

export function writeStoredLanguage(language: Language): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    /* 存储被禁用时只保留本次会话的语言 */
  }
}

/** Intl 的 locale 标签：语言代码到地域写法只在这里映射。 */
export function intlLocale(language: Language): string {
  return language === "en" ? "en-US" : "zh-CN"
}
