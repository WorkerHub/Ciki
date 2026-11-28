/**
 * 「图片上传单张上限」的设置口径与读写 helper（规格「图片上传上限配置化」）。
 *
 * 口径（全站唯一）：
 * - 存储：`system_settings.max_image_upload_mb`；值是十进制整数（1–100）。
 * - 默认值：10 MB（缺行、空串、非法存量值一律回落 10，行为零漂移）。
 * - 范围：1–100 MB（整数）。
 * - 写入：null / 空串 = 重置为默认（落库为空串，与保留上限约定一致）。
 */
import { getSetting, setSetting } from "../db/queries/settings"

export const MAX_IMAGE_UPLOAD_KEY = "max_image_upload_mb"
export const DEFAULT_MAX_IMAGE_UPLOAD_MB = 10
export const MIN_IMAGE_UPLOAD_MB = 1
export const MAX_IMAGE_UPLOAD_MB = 100

/** 设置的原始值 → 上限 MB 数；缺行 / 空串 / 非法值一律按默认 10 处理。 */
export function parseMaxImageUploadMb(raw: string | null): number {
  if (raw === null) return DEFAULT_MAX_IMAGE_UPLOAD_MB
  const trimmed = raw.trim()
  if (trimmed === "") return DEFAULT_MAX_IMAGE_UPLOAD_MB
  if (!/^\d+$/.test(trimmed)) return DEFAULT_MAX_IMAGE_UPLOAD_MB
  const value = Number(trimmed)
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_IMAGE_UPLOAD_MB ||
    value > MAX_IMAGE_UPLOAD_MB
  ) {
    return DEFAULT_MAX_IMAGE_UPLOAD_MB
  }
  return value
}

/** 读取当前生效的上限 MB 数（每次调用现读，不做 isolate 缓存）。 */
export async function readMaxImageUploadMb(
  db: D1Database,
  prefix: string
): Promise<number> {
  return parseMaxImageUploadMb(
    await getSetting(db, prefix, MAX_IMAGE_UPLOAD_KEY)
  )
}

/** 读取当前生效的上限字节数（每次调用现读，不做 isolate 缓存）。 */
export async function readMaxImageUploadBytes(
  db: D1Database,
  prefix: string
): Promise<number> {
  const mb = await readMaxImageUploadMb(db, prefix)
  return mb * 1024 * 1024
}

export type MaxImageUploadInputResult =
  | { ok: true; mb: number | null }
  | { ok: false }

/** 管理接口入参 → 校验：1–100 整数（数字或数字字符串）、null / 空串（= 重置为默认），其余非法。 */
export function normalizeMaxImageUploadInput(
  value: unknown
): MaxImageUploadInputResult {
  if (value === null) return { ok: true, mb: null }
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed === "") return { ok: true, mb: null }
    if (!/^\d+$/.test(trimmed)) return { ok: false }
    const parsed = Number(trimmed)
    if (
      Number.isSafeInteger(parsed) &&
      parsed >= MIN_IMAGE_UPLOAD_MB &&
      parsed <= MAX_IMAGE_UPLOAD_MB
    ) {
      return { ok: true, mb: parsed }
    }
    return { ok: false }
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false }
  }
  if (value >= MIN_IMAGE_UPLOAD_MB && value <= MAX_IMAGE_UPLOAD_MB) {
    return { ok: true, mb: value }
  }
  return { ok: false }
}

/** 写设置：重置为默认落空串，便于管理面回显与回退。 */
export async function writeMaxImageUploadMb(
  db: D1Database,
  prefix: string,
  mb: number | null
): Promise<void> {
  await setSetting(
    db,
    prefix,
    MAX_IMAGE_UPLOAD_KEY,
    mb === null ? "" : String(mb)
  )
}
