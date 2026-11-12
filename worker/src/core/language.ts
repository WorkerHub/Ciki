/**
 * 界面语言（i18n 规格 §2.1）：服务端只认支持集内的值，与前端各存一份常量。
 *
 * 落库形态是 `users.language`（`TEXT NOT NULL DEFAULT 'zh'`），存量全是 `zh`、
 * 无数据迁移。两条入口口径不同：
 * - **更新接口**（`PUT /api/me/profile`）用 `isLanguage` 严格判定，非法值 400
 *   `INVALID_LANGUAGE`，不猜、不纠正；
 * - **注册入参**与**读库出口**用 `normalizeLanguage` 回退默认 `zh`——注册不能被一个
 *   坏入参拦下（§4），库里的历史/人工脏值也不能让前端或邮件拿到未知语言码。
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
