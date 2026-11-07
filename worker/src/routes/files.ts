/**
 * 图片：仅 png/jpg/jpeg/gif/webp（按魔数校验，不收 svg），单张 ≤10MB，
 * 存 R2 bucket ciki-assets；读取必须带会话，不给公开直链（规格 §2.4）。
 */
import { Hono } from "hono"
import type { HonoEnv } from "../types"

export const fileRoutes = new Hono<HonoEnv>()

const MAX_BYTES = 10 * 1024 * 1024
const KEY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|gif|webp)$/

interface ImageType {
  mime: string
  ext: string
}

/** 魔数判定：文件头说了算，声明类型只做一致性提示。 */
function sniffImage(bytes: Uint8Array): ImageType | null {
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

fileRoutes.post("/", async (c) => {
  const declared = Number.parseInt(c.req.header("content-length") ?? "0", 10)
  if (declared > MAX_BYTES + 1024 * 1024) {
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
  if (file.size > MAX_BYTES) {
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
    customMetadata: { uploaderId: c.get("userId") }
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
})

fileRoutes.get("/:key", async (c) => {
  const key = c.req.param("key")
  if (!KEY_RE.test(key)) {
    return c.json({ error: "File not found" }, 404)
  }

  const object = await c.env.R2.get(key)
  if (!object) {
    return c.json({ error: "File not found" }, 404)
  }

  const headers = new Headers()
  headers.set(
    "Content-Type",
    object.httpMetadata?.contentType ?? "application/octet-stream"
  )
  headers.set("Content-Length", String(object.size))
  if (object.httpEtag) headers.set("ETag", object.httpEtag)
  headers.set("Cache-Control", "private, max-age=3600")
  return new Response(object.body, { headers })
})
