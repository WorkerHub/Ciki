/**
 * 身份模型（新基线）：显示名与站点名的生成/校验。
 *
 * 用户的对外身份就是 `username`（整数主键只在内部引用），原来的 8 位 `public_id`
 * 已随 ID 重构删除——一个实体只露一种 ID，不再有第二个随机标识。
 */

export const DEFAULT_SITE_NAME = "Ciki"
export const MAX_USERNAME_LENGTH = 40
export const MAX_SITE_NAME_LENGTH = 32

/**
 * 新建号的兜底显示名：邮箱前缀为空（或全是控制字符）时用。迁移消解存量重名时
 * 不用它——历史用户名一律原样保留，空串既不参与唯一约束、也不改写。
 */
export const FALLBACK_USERNAME = "用户"

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
 * 把任意来源的字符串收成合法显示名：去控制字符、trim、按码点截断到上限，
 * 空则用兜底名。新建号、迁移消解存量重名共用这一口径，保证两边长得一样。
 */
export function cleanUsername(value: string): string {
  const cleaned = stripControlChars(value).trim()
  const capped = Array.from(cleaned).slice(0, MAX_USERNAME_LENGTH).join("")
  return capped || FALLBACK_USERNAME
}

/** 显示名默认值：邮箱前缀，按码点截断到上限（重名后缀由调用方按需追加）。 */
export function defaultUsernameFromEmail(email: string): string {
  return cleanUsername(email.split("@")[0] ?? "")
}

/**
 * 重名候选名：`n <= 1` 返回原名，否则追加 `-2`、`-3`…；后缀算在 40 码点之内，
 * 基础名过长时截短腾位，所以结果恒为 1–40 个码点。
 */
export function usernameWithSuffix(base: string, n: number): string {
  if (n <= 1) return base
  const suffix = `-${n}`
  const room = MAX_USERNAME_LENGTH - Array.from(suffix).length
  const head = Array.from(base).slice(0, Math.max(room, 0)).join("")
  return `${head}${suffix}`
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

/**
 * 用户名唯一键冲突（`users_username` 索引的并发兜底）。
 *
 * SQLite 对**列**唯一索引报 `UNIQUE constraint failed: <表>.username`（带表前缀时
 * 是 `<前缀>users.username`；多列唯一索引用逗号分隔）；只有表达式索引才报
 * `UNIQUE constraint failed: index '<索引名>'`。D1 还会在末尾追加
 * `: SQLITE_CONSTRAINT`，先剔掉再按列名 / 索引名精确匹配——不用子串猜，
 * 否则邮箱冲突会被误当成用户名冲突，把注册重试烧在错的分支上。
 */
export function isUsernameConflict(err: unknown): boolean {
  const message = uniqueViolationMessage(err)
  if (!message) return false
  const detail = message
    .replace(/^.*?UNIQUE constraint failed:\s*/i, "")
    .replace(/\s*:\s*[A-Z_0-9]+$/, "")
    .trim()
    .toLowerCase()
  const columns = detail.split(",").map((part) => part.trim())
  if (
    columns.some(
      (column) => column === "username" || column.endsWith(".username")
    )
  ) {
    return true
  }
  // 表达式索引的报法：我们的列索引不会走到这里，留着兜住将来改写成 lower(username) 的情况。
  return /^index\s+'[^']*_username'$/.test(detail)
}
