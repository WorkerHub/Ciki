/**
 * 图片上传的单一入口：类型白名单（按魔数，不收 svg）、单张 ≤10MB、落 R2。
 *
 * `/api/files`、`/api/import/files` 与 `/api/me/avatar` 共用同一份实现（规格
 * §12.1 / §1：头像专用口与导入都不复刻一套校验，口径与 /api/files 完全一致）；
 * 上传者 id 与类别由调用方传入，两者一起写进 R2 的 customMetadata。
 */
import type { Context } from "hono"
import type { HonoEnv } from "../types"

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** 新上传 key 的来源类别（规格 §1）：只决定 key 的前缀目录。 */
export type UploadCategory = "avatars" | "pages" | "imports"

/**
 * 对外暴露的 key 形状：`<类别>/<UUID>.<图片扩展名>`，或存量的平铺
 * `<UUID>.<图片扩展名>`。读接口与头像校验按它挡掉随便拼的路径。
 * 存量平铺 key 永不迁移（规格 §2），所以两种形状都认；未知前缀与形状不符
 * （多级前缀、大写 hex、svg 等）一律不匹配。
 */
export const UPLOAD_KEY_RE =
  /^(?:(?:avatars|pages|imports)\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|gif|webp)$/

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

type UploadRejected = { ok: false; response: Response }

export type UploadRead =
  | { ok: true; bytes: Uint8Array; type: ImageType }
  | UploadRejected

/**
 * 读取并校验 `multipart/form-data` 单文件：content-length 预检 → 解析表单 →
 * `file` 字段存在 → 10MB 上限 → 魔数判定。失败时把可直接返回的响应带出来，
 * 调用方不必重复这套口径。
 */
export async function readImageUpload(
  c: Context<HonoEnv>
): Promise<UploadRead> {
  const declared = Number.parseInt(c.req.header("content-length") ?? "0", 10)
  if (declared > MAX_UPLOAD_BYTES + 1024 * 1024) {
    return {
      ok: false,
      response: c.json({ error: "File too large", code: "FILE_TOO_LARGE" }, 413)
    }
  }

  let form: Record<string, string | File>
  try {
    form = await c.req.parseBody()
  } catch {
    return {
      ok: false,
      response: c.json({ error: "Expected multipart/form-data" }, 400)
    }
  }

  const file = form.file
  if (!(file instanceof File)) {
    return { ok: false, response: c.json({ error: "Missing file field" }, 400) }
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      response: c.json({ error: "File too large", code: "FILE_TOO_LARGE" }, 413)
    }
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const type = sniffImage(bytes)
  if (!type) {
    return {
      ok: false,
      response: c.json(
        { error: "Only png/jpg/jpeg/gif/webp images are accepted" },
        400
      )
    }
  }
  return { ok: true, bytes, type }
}

/** 落盘后的元数据：普通上传的响应体就是这个形状。 */
export interface StoredImage {
  key: string
  url: string
  contentType: string
  size: number
}

export type UploadStored = { ok: true; image: StoredImage } | UploadRejected

/**
 * 校验 + 落 R2：key 带类别前缀（规格 §1），customMetadata 记 uploaderId 与
 * category。普通上传与头像专用口共用，避免两套落盘口径。
 */
export async function storeImageUpload(
  c: Context<HonoEnv>,
  uploaderId: number,
  category: UploadCategory
): Promise<UploadStored> {
  const read = await readImageUpload(c)
  if (!read.ok) return read

  const { bytes, type } = read
  const key = `${category}/${crypto.randomUUID()}.${type.ext}`
  await c.env.R2.put(key, bytes, {
    httpMetadata: { contentType: type.mime },
    // R2 的 customMetadata 只收字符串：整数用户 id 在这里转成十进制文本。
    customMetadata: { uploaderId: String(uploaderId), category }
  })

  return {
    ok: true,
    image: {
      key,
      url: `/api/files/${key}`,
      contentType: type.mime,
      size: bytes.length
    }
  }
}

/**
 * 处理 `multipart/form-data` 单文件上传：成功 201，响应形状与 /api/files 一致
 * （`key` / `url` / `contentType` / `size`）。
 */
export async function handleImageUpload(
  c: Context<HonoEnv>,
  uploaderId: number,
  category: UploadCategory
): Promise<Response> {
  const stored = await storeImageUpload(c, uploaderId, category)
  if (!stored.ok) return stored.response
  return c.json(stored.image, 201)
}
