/**
 * 展示层格式化：全站时间统一按 `Asia/Shanghai`（UTC+8）展示，
 * 文案与日期格式跟随当前界面语言（规格 §2.11）。
 * 例外：要求按注入值原样呈现的时刻（如关于页的构建时间）用 formatIsoUtc 直出 UTC。
 */
import { currentLanguage, i18n } from "@/i18n"
import { intlLocale, type Language } from "@/lib/language"

const TIME_ZONE = "Asia/Shanghai"

const dateTimeFormatters = new Map<Language, Intl.DateTimeFormat>()
const dateFormatters = new Map<Language, Intl.DateTimeFormat>()

function dateTimeFormatter(language: Language): Intl.DateTimeFormat {
  const cached = dateTimeFormatters.get(language)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat(intlLocale(language), {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  })
  dateTimeFormatters.set(language, formatter)
  return formatter
}

function dateFormatter(language: Language): Intl.DateTimeFormat {
  const cached = dateFormatters.get(language)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat(intlLocale(language), {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  })
  dateFormatters.set(language, formatter)
  return formatter
}

/** zh-CN 的 `/` 分隔符换成 `-`（现网口径）；en-US 用原生分隔符。 */
function localizeSeparators(text: string, language: Language): string {
  return language === "zh" ? text.replace(/\//g, "-") : text
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  const language = currentLanguage()
  return localizeSeparators(dateTimeFormatter(language).format(date), language)
}

/**
 * ISO 8601 UTC（秒级精度、`Z` 后缀）：给需要按注入值原样呈现的时刻用（如构建时间）。
 * 用 UTC 直出，不经运行环境本地时区换算，展示值与被注入的时刻是同一瞬间。
 */
export function formatIsoUtc(iso: string | null | undefined): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  // toISOString() 恒为 UTC（`...sssZ`）；裁掉秒后的小数部分即所需精度。
  return `${date.toISOString().slice(0, 19)}Z`
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  const language = currentLanguage()
  return localizeSeparators(dateFormatter(language).format(date), language)
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  const diffMs = Date.now() - date.getTime()
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diffMs < minute) return i18n.t("time.justNow")
  if (diffMs < hour) {
    return i18n.t("time.minutesAgo", {
      count: Math.floor(diffMs / minute)
    })
  }
  if (diffMs < day) {
    return i18n.t("time.hoursAgo", { count: Math.floor(diffMs / hour) })
  }
  if (diffMs < 7 * day) {
    return i18n.t("time.daysAgo", { count: Math.floor(diffMs / day) })
  }
  return formatDate(iso)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
