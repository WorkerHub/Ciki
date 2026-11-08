/**
 * 图片上传的单一入口：类型白名单（按魔数，不收 svg）、单张 ≤10MB、落 R2。
 *
 * `/api/files` 与 `/api/import/files` 共用同一份实现（规格 §12.1：导入不复刻
 * 一套校验，口径与 /api/files 完全一致）；上传者 id 由调用方传入（会话用户或
 * 导入令牌对应的用户），用于 R2 的 customMetadata。
 */
import type { Context } from "hono"
import type { HonoEnv } from "../types"

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** 对外暴露的 key 形状：UUID + 图片扩展名（读接口按它挡掉随便拼的路径）。 */
export const UPLOAD_KEY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|gif|webp)$/

export interface ImageType {
  mime: string
  ext: string
}

/** 魔数判定：文件头说了算，声明类型只做一致性提示。 */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 8) {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    if (png.every((byte, index) => bytes[index] === byte)) {
      return { mime: "image/png", ext: "png" }
    }
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { mime: "image/jpeg", ext: "jpg" }
  }
  if (
    bytes.length >= 6 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "GIF8" &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return { mime: "image/gif", ext: "gif" }
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" }
  }
  return null
}

/**
 * 处理 `multipart/form-data` 单文件上传：成功 201，响应形状与 /api/files 一致
 * （`key` / `url` / `contentType` / `size`）。
 */
export async function handleImageUpload(
  c: Context<HonoEnv>,
  uploaderId: string
): Promise<Response> {
  const declared = Number.parseInt(c.req.header("content-length") ?? "0", 10)
  if (declared > MAX_UPLOAD_BYTES + 1024 * 1024) {
    return c.json({ error: "File too large", code: "FILE_TOO_LARGE" }, 413)
  }

  let form: Record<string, string | File>
  try {
    form = await c.req.parseBody()
  } catch {
    return c.json({ error: "Expected multipart/form-data" }, 400)
  }

  const file = form.file
  if (!(file instanceof File)) {
    return c.json({ error: "Missing file field" }, 400)
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: "File too large", code: "FILE_TOO_LARGE" }, 413)
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const type = sniffImage(bytes)
  if (!type) {
    return c.json(
      { error: "Only png/jpg/jpeg/gif/webp images are accepted" },
      400
    )
  }

  const key = `${crypto.randomUUID()}.${type.ext}`
  await c.env.R2.put(key, bytes, {
    httpMetadata: { contentType: type.mime },
    customMetadata: { uploaderId }
  })

  return c.json(
    {
      key,
      url: `/api/files/${key}`,
      contentType: type.mime,
      size: bytes.length
    },
    201
  )
}
