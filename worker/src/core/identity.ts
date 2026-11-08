/**
 * 身份模型（规格「Ciki UI/身份优化批」）：public_id、显示名与站点名的生成/校验。
 *
 * public_id 是用户对外可展示的 ID：8 位、唯一、生成后不可改。字符表去掉易混的
 * 0/O/1/I/L，只留 31 个；生成时逐字节拒绝采样，避免取模偏差。
 */

export const PUBLIC_ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

/** 31 × 8 = 248：字节 ≥ 248 时重采样，保证每个字符等概率。 */
const PUBLIC_ID_ACCEPT_BYTES = 248
const PUBLIC_ID_LENGTH = 8

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

/** 8 位、无易混字符的公开用户 ID（由系统生成，客户端不可写入）。 */
export function generatePublicId(): string {
  let id = ""
  const buffer = new Uint8Array(PUBLIC_ID_LENGTH * 2)
  while (id.length < PUBLIC_ID_LENGTH) {
    crypto.getRandomValues(buffer)
    for (const byte of buffer) {
      if (byte >= PUBLIC_ID_ACCEPT_BYTES) continue
      id += PUBLIC_ID_ALPHABET[byte % PUBLIC_ID_ALPHABET.length]
      if (id.length === PUBLIC_ID_LENGTH) break
    }
  }
  return id
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

/** public_id 唯一键冲突：换一枚重试即可。 */
export function isPublicIdConflict(err: unknown): boolean {
  return /\.public_id\b/i.test(uniqueViolationMessage(err) ?? "")
}

/**
 * 生成 public_id 并调用一次插入：撞 public_id 唯一键就换一枚重试，
 * 其它错误原样抛出（邮箱冲突由调用方映射成 409）。
 */
export async function insertWithFreshPublicId(
  insert: (publicId: string) => Promise<void>
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await insert(generatePublicId())
      return
    } catch (err) {
      if (!isPublicIdConflict(err)) throw err
    }
  }
  throw new Error("Failed to allocate a unique public_id")
}
