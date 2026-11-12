/**
 * i18next 初始化与语言切换（规格 §2.2/§2.3）。
 *
 * 当前语言只放在 i18next 里，组件用 react-i18next 的原生 `useTranslation()`，
 * 不另建 store 免得出现两份真相。优先级：
 * 账号 language（RootGate 拿到 Me 后由 applyAccountLanguage 覆盖）
 * > localStorage > 浏览器语言 > 默认 zh。
 */
import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import {
  DEFAULT_LANGUAGE,
  detectBrowserLanguage,
  isLanguage,
  type Language,
  readStoredLanguage,
  SUPPORTED_LANGUAGES,
  writeStoredLanguage
} from "@/lib/language"
import en from "@/locales/en.json"
import zh from "@/locales/zh.json"

function initialLanguage(): Language {
  return readStoredLanguage() ?? detectBrowserLanguage()
}

void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en }
  },
  lng: initialLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: [...SUPPORTED_LANGUAGES],
  interpolation: { escapeValue: false },
  react: { useSuspense: false }
})

/** `<html lang>` 随语言走（规格 §2.11）；值统一用 zh / en。 */
function applyDocumentLanguage(language: string) {
  if (typeof document === "undefined") return
  document.documentElement.lang = isLanguage(language)
    ? language
    : DEFAULT_LANGUAGE
}

i18n.on("languageChanged", applyDocumentLanguage)
applyDocumentLanguage(i18n.language)

/** 当前语言归一成支持集内的代码，给非 React 代码（format、api）用。 */
export function currentLanguage(): Language {
  const value = i18n.resolvedLanguage ?? i18n.language
  return isLanguage(value) ? value : DEFAULT_LANGUAGE
}

/**
 * 切换语言并记住选择（`persist: false` 只用于测试等不需要落盘的场合）。
 * 未登录页靠 localStorage 跨刷新保持；登录后账号语言会再覆盖一次。
 */
export async function changeLanguage(
  language: Language,
  options: { persist?: boolean } = {}
): Promise<void> {
  if (!isLanguage(language)) return
  if (options.persist !== false) writeStoredLanguage(language)
  if (currentLanguage() === language) return
  await i18n.changeLanguage(language)
}

/**
 * 登录后以账号设置覆盖本机选择（规格 §2.3）。
 * 旧后端没有 language 字段或值不在支持集内时静默忽略。
 */
export async function applyAccountLanguage(value: unknown): Promise<void> {
  if (!isLanguage(value)) return
  await changeLanguage(value)
}

export { i18n }
export default i18n
