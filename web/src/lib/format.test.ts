import { describe, expect, it } from "vitest"
import { i18n } from "@/i18n"
import {
  formatDate,
  formatDateTime,
  formatIsoUtc,
  formatRelative
} from "@/lib/format"

/** 构建时间按 ISO 8601 UTC 直出（秒级、`Z` 后缀），不经本地时区换算。 */
describe("formatIsoUtc", () => {
  it("裁掉毫秒、以秒级 Z 后缀结尾", () => {
    expect(formatIsoUtc("2026-11-10T13:36:05.123Z")).toBe(
      "2026-11-10T13:36:05Z"
    )
  })

  it("已经是 UTC 串时原样保留时刻，不叠加本地时区偏移", () => {
    // 本地运行在 UTC+8 时，2026-11-10T23:36:05Z 会被 formatDateTime 推到次日；
    // 这里必须仍是同一个 UTC 瞬间、同一天。
    expect(formatIsoUtc("2026-11-10T23:36:05.000Z")).toBe(
      "2026-11-10T23:36:05Z"
    )
    expect(formatIsoUtc("2026-11-10T00:00:00.000Z")).toBe(
      "2026-11-10T00:00:00Z"
    )
  })

  it("值内不含汉字与括号", () => {
    const value = formatIsoUtc("2026-11-10T13:36:05.123Z")
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(value).not.toMatch(/[\u4e00-\u9fff（）()]/)
  })

  it("空值与非法值回退为占位符", () => {
    expect(formatIsoUtc(null)).toBe("—")
    expect(formatIsoUtc("")).toBe("—")
    expect(formatIsoUtc("not-a-date")).toBe("—")
  })
})

/** 日期 / 相对时间按当前界面语言展示（规格 §2.11），zh 口径逐字保持现网。 */
describe("日期与相对时间跟随语言", () => {
  const CREATED_AT = "2026-11-10T14:10:00.000Z"

  it("zh 保持现网口径：短横线分隔 + 中文相对时间", () => {
    expect(formatDateTime(CREATED_AT)).toBe("2026-11-10 22:10")
    expect(formatDate(CREATED_AT)).toBe("2026-11-10")
    expect(
      formatRelative(new Date(Date.now() - 5 * 60_000).toISOString())
    ).toBe("5 分钟前")
    expect(formatRelative(new Date().toISOString())).toBe("刚刚")
  })

  it("en 用英文文案与 en-US 原生日期格式", async () => {
    await i18n.changeLanguage("en")
    expect(formatDateTime(CREATED_AT)).toBe("11/10/2026, 22:10")
    expect(formatDate(CREATED_AT)).toBe("11/10/2026")
    expect(
      formatRelative(new Date(Date.now() - 5 * 60_000).toISOString())
    ).toBe("5 minutes ago")
    expect(formatRelative(new Date().toISOString())).toBe("Just now")
  })
})
