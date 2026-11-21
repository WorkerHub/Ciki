/**
 * 行内字号的唯一形态 —— 与后端冻结契约（docs/api-contract.md「服务端消毒规则」）逐字对齐。
 *
 * 全链路只认 7 档固定刻度（小写 px 字符串）：
 * TipTap JSON 里存它，contentHtml 的 data 载具（data-font-size）也存它。
 * 非法值或未知单位一律丢弃（归一返回 null），不猜。
 */

export const ALLOWED_FONT_SIZES = [
  "12px",
  "14px",
  "16px",
  "18px",
  "20px",
  "24px",
  "32px"
] as const

export type AllowedFontSize = (typeof ALLOWED_FONT_SIZES)[number]

const FONT_SIZE_SET = new Set<string>(ALLOWED_FONT_SIZES)

/**
 * 校验并归一化字号：严格仅限 7 档固定刻度（统一小写）；非法返回 null。
 */
export function normalizeFontSize(
  raw: string | null | undefined
): AllowedFontSize | null {
  if (!raw) return null
  const value = raw.trim().toLowerCase()
  return FONT_SIZE_SET.has(value) ? (value as AllowedFontSize) : null
}
