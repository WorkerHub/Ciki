import { describe, expect, it } from "vitest"
import { i18n } from "@/i18n"
import { ERROR_TEXT_CODES } from "@/lib/api"
import en from "@/locales/en.json"
import zh from "@/locales/zh.json"

/**
 * 资源文件自身的守卫（本单抽取的验收防线之一）：
 * - 两种语言的 key 集合一致（复数后缀 `_one`/`_other` 按语言不同，只比基底）；
 * - 没有空值，免得界面上出现空白；
 * - 英文资源里不允许残留中文（`common.languages.*` 是语言自称，本来就该是各自语言的写法）。
 *
 * 漏翻一个 key 时，i18next 会回落到中文，界面上就会冒出中文——这里是第一道拦截。
 */

type Bundle = { [key: string]: string | Bundle }

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

function flatten(bundle: Bundle, prefix = ""): Map<string, string> {
  const entries = new Map<string, string>()
  for (const [key, value] of Object.entries(bundle)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === "string") entries.set(path, value)
    else
      for (const [child, text] of flatten(value, path)) entries.set(child, text)
  }
  return entries
}

/** 复数类别按语言不同，比较 key 时先去掉后缀。 */
function baseKeys(bundle: Bundle): string[] {
  return [
    ...new Set(
      [...flatten(bundle).keys()].map((key) => key.replace(PLURAL_SUFFIX, ""))
    )
  ].sort()
}

const zhEntries = flatten(zh as Bundle)
const enEntries = flatten(en as Bundle)

describe("语言资源", () => {
  it("中英两份资源的 key 集合完全一致", () => {
    expect(baseKeys(en as Bundle)).toEqual(baseKeys(zh as Bundle))
  })

  it("每条都有非空文案", () => {
    for (const [key, value] of [...zhEntries, ...enEntries]) {
      expect(value.trim(), key).not.toBe("")
    }
  })

  it("英文资源没有漏翻的中文（语言自称除外）", () => {
    const leftovers = [...enEntries]
      .filter(([key]) => !key.startsWith("common.languages."))
      .filter(([, value]) => /[\u4e00-\u9fff]/.test(value))
      .map(([key]) => key)
    expect(leftovers).toEqual([])
  })
})

/**
 * 错误码文案的守卫（规格 §2.9）：`describeApiError` 按 code 查 `errors.<CODE>`。
 * 查表之外的显式分支（按 path 分流的 INVALID_CODE 变体、两类 SMTP 失败的带原因
 * 版本）与几条兜底文案单列，漏翻时这里直接报 missing 的 key。
 */
describe("错误码文案", () => {
  const SPECIAL_KEYS = [
    "errors.INVALID_CODE",
    "errors.INVALID_CODE_RESET",
    "errors.INVALID_CODE_VERIFY",
    "errors.SMTP_SEND_FAILED",
    "errors.SMTP_SEND_FAILED_REASON",
    "errors.INVALID_SMTP_CONFIG",
    "errors.INVALID_SMTP_CONFIG_REASON"
  ]

  const CREDENTIAL_KEYS = [
    "errors.credentials.invalidCredentials",
    "errors.credentials.invalidVerificationCode",
    "errors.credentials.invalidMfaCode",
    "errors.credentials.twoFactorSession",
    "errors.credentials.passkeyFailed"
  ]

  const FALLBACK_KEYS = [
    "errors.network",
    "errors.httpStatus",
    "errors.rateLimitedWait",
    "errors.passwordRequired",
    "errors.passwordIncorrect",
    "errors.authFailed",
    "errors.sessionExpired",
    "errors.forbidden",
    "errors.notFound",
    "errors.conflict",
    "errors.siteNameLength",
    "errors.retentionLimit",
    "errors.tooLarge",
    "errors.tooFrequent",
    "errors.cleanupFailed",
    "errors.requestFailed"
  ]

  function missing(keys: string[]) {
    return keys.flatMap((key) =>
      ["zh", "en"].flatMap((lng) =>
        i18n.exists(key, { lng }) ? [] : [`${lng}:${key}`]
      )
    )
  }

  it("describeApiError 查表的每个错误码都有中英两份文案", () => {
    expect(
      missing([...ERROR_TEXT_CODES].map((code) => `errors.${code}`))
    ).toEqual([])
  })

  it("查表之外的变体、凭据与兜底文案也都在", () => {
    expect(
      missing([...SPECIAL_KEYS, ...CREDENTIAL_KEYS, ...FALLBACK_KEYS])
    ).toEqual([])
  })
})
