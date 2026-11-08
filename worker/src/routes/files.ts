/**
 * 图片：仅 png/jpg/jpeg/gif/webp（按魔数校验，不收 svg），单张 ≤10MB，
 * 存 R2 bucket ciki-assets；读取必须带会话，不给公开直链（规格 §2.4）。
 *
 * 上传的校验与落盘在 lib/upload.ts（导入接口共用同一份实现）。
 */
import { Hono } from "hono"
import { UPLOAD_KEY_RE, handleImageUpload } from "../lib/upload"
import type { HonoEnv } from "../types"

export const fileRoutes = new Hono<HonoEnv>()

fileRoutes.post("/", (c) => handleImageUpload(c, c.get("userId"), "pages"))

// key 带类别前缀（`pages/<uuid>.png`），所以用正则参数而非单段参数；
// 解码后的值仍要过 UPLOAD_KEY_RE，非法形状与未知前缀一律 404。
fileRoutes.get("/:key{.+}", async (c) => {
  const key = c.req.param("key")
  if (!UPLOAD_KEY_RE.test(key)) {
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
