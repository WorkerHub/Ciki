/**
 * 界面语言（i18n 规格 §2.1）：服务端只认支持集内的值，与前端各存一份常量。
 *
 * 落库形态是 `users.language`（`TEXT NOT NULL DEFAULT 'zh'`），存量全是 `zh`、
 * 无数据迁移。两条入口口径不同：
 * - **更新接口**（`PUT /api/me/profile`）用 `isLanguage` 严格判定，非法值 400
 *   `INVALID_LANGUAGE`，不猜、不纠正；
 * - **注册入参**与**读库出口**用 `normalizeLanguage` 回退默认 `zh`——注册不能被一个
 *   坏入参拦下（§4），库里的历史/人工脏值也不能让前端或邮件拿到未知语言码。
 * - **setup 入参**（首次建库的默认空间名）用 `resolveRequestLanguage`：显式值优先，
 *   否则看 `Accept-Language`，再回退 `zh`。
 *
 * 加语言 = 在 `SUPPORTED_LANGUAGES` 加一项，并补齐文案表（服务端在
 * `services/email.ts`，前端在 locale 资源里）。
 */

export const SUPPORTED_LANGUAGES = ["zh", "en"] as const

export type Language = (typeof SUPPORTED_LANGUAGES)[number]

export const DEFAULT_LANGUAGE: Language = "zh"

/** 精确匹配：不 trim、不大小写归一（`"EN"`、`" en "` 都不算支持集内值）。 */
export function isLanguage(value: unknown): value is Language {
  return (
    typeof value === "string" &&
    (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
  )
}

/** 任意来源 → 支持集内的语言；不在集合里一律回退默认值。 */
export function normalizeLanguage(value: unknown): Language {
  return isLanguage(value) ? value : DEFAULT_LANGUAGE
}

/**
 * 浏览器语言一级（规格 §2.3）：`Accept-Language` 的首个标签以 `en` 开头取 `en`，
 * 其余（含 `zh-CN`、`*`、缺头）一律 `zh`——与前端 `detectBrowserLanguage` 同一判据。
 */
export function languageFromAcceptLanguage(
  header: string | null | undefined
): Language {
  const first = (header ?? "").split(",")[0]?.trim().toLowerCase() ?? ""
  return first.startsWith("en") ? "en" : DEFAULT_LANGUAGE
}

/**
 * 请求自带语言（规格 §2.3 链的落地下法）：显式传入的合法值优先（前端已按
 * 「账号设置 > localStorage > 浏览器语言」解析好），否则看 `Accept-Language`，
 * 最后回退 `zh`。坏入参不拦请求，与注册入参同口径。
 */
export function resolveRequestLanguage(
  value: unknown,
  acceptLanguage: string | null | undefined
): Language {
  return isLanguage(value) ? value : languageFromAcceptLanguage(acceptLanguage)
}
