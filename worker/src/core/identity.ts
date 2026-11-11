/**
 * 身份模型（新基线）：显示名与站点名的生成/校验。
 *
 * 用户的对外身份就是 `username`（整数主键只在内部引用），原来的 8 位 `public_id`
 * 已随 ID 重构删除——一个实体只露一种 ID，不再有第二个随机标识。
 */

export const DEFAULT_SITE_NAME = "Ciki"
export const MAX_USERNAME_LENGTH = 40
export const MAX_SITE_NAME_LENGTH = 32

/** C0/C1 控制字符（含换行、制表）：显示名与站点名一律不收。 */
function isControlChar(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    if (isControlChar(char.codePointAt(0) ?? 0)) return true
  }
  return false
}

function stripControlChars(value: string): string {
  let cleaned = ""
  for (const char of value) {
    if (!isControlChar(char.codePointAt(0) ?? 0)) cleaned += char
  }
  return cleaned
}

/**
 * 显示名默认值：邮箱前缀，按码点截断到上限。迁移回填与新建号共用这一口径，
 * 保证存量用户与之后注册的用户长得一样。
 */
export function defaultUsernameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? ""
  const cleaned = stripControlChars(local).trim()
  const capped = Array.from(cleaned).slice(0, MAX_USERNAME_LENGTH).join("")
  return capped || "用户"
}

/** 合法的显示名：trim 后 1–40 个码点、不含控制字符；非法返回 null。 */
export function normalizeUsername(value: unknown): string | null {
  return normalizeLabel(value, MAX_USERNAME_LENGTH)
}

/** 合法的站点名：trim 后 1–32 个码点、不含控制字符；非法返回 null。 */
export function normalizeSiteName(value: unknown): string | null {
  return normalizeLabel(value, MAX_SITE_NAME_LENGTH)
}

function normalizeLabel(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || hasControlChars(value)) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (Array.from(trimmed).length > maxLength) return null
  return trimmed
}

function uniqueViolationMessage(err: unknown): string | null {
  if (!(err instanceof Error)) return null
  if (!/UNIQUE constraint failed/i.test(err.message)) return null
  return err.message
}

/** 邮箱唯一键冲突（注册 / 建号 / 管理员改邮箱的并发兜底）。 */
export function isEmailConflict(err: unknown): boolean {
  return /\.email\b/i.test(uniqueViolationMessage(err) ?? "")
}
