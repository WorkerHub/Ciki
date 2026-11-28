/**
 * 图片：仅 png/jpg/jpeg/gif/webp（按魔数校验，不收 svg），单张默认 ≤10MB（可在系统管理配置 1–100MB），
 * 存 R2 bucket ciki-assets；读取必须带会话，不给公开直链（规格 §2.4）。
 *
 * 上传的校验与落盘在 lib/upload.ts（导入接口共用同一份实现）。
 */
import { Hono } from "hono"
import {
  EMBED_CONTENT_SECURITY_POLICY,
  EMBED_CONTENT_TYPE,
  EMBED_KEY_RE,
  UPLOAD_KEY_RE,
  handleEmbedUpload,
  handleImageUpload,
  injectEmbedHeightScript
} from "../lib/upload"
import type { HonoEnv } from "../types"

export const fileRoutes = new Hono<HonoEnv>()

fileRoutes.post("/", (c) => handleImageUpload(c, c.get("userId"), "pages"))

// embed 上传（规格 §2）：会话路径，与图片上传同一权限面（页面写权限，见上层中间件）。
fileRoutes.post("/embeds", (c) => handleEmbedUpload(c, c.get("userId")))

// key 带类别前缀（`pages/<uuid>.png`、`embeds/<uuid>.html`），所以用正则参数而非
// 单段参数；解码后的值仍要过 UPLOAD_KEY_RE / EMBED_KEY_RE，非法形状与未知前缀一律 404。
fileRoutes.get("/:key{.+}", async (c) => {
  const key = c.req.param("key")
  const isEmbed = EMBED_KEY_RE.test(key)
  if (!isEmbed && !UPLOAD_KEY_RE.test(key)) {
    return c.json({ error: "File not found" }, 404)
  }

  const object = await c.env.R2.get(key)
  if (!object) {
    return c.json({ error: "File not found" }, 404)
  }

  const headers = new Headers()
  if (isEmbed) {
    // embed 下发（规格 §3 安全硬要求）：CSP sandbox 逼成 opaque origin，
    // nosniff 防止 MIME 嗅探，Content-Type 带字符集逐字下发。
    // 高度自适应（规格 §1/§2）：仅在下发响应末尾（</body> 前，无 body 时追加到末尾）
    // 注入高度上报脚本，R2 存储的原文件不改，导出 zip 仍保持原文件逐字字节。
    headers.set("Content-Type", EMBED_CONTENT_TYPE)
    headers.set("X-Content-Type-Options", "nosniff")
    headers.set("Content-Security-Policy", EMBED_CONTENT_SECURITY_POLICY)
    const rawHtml = await object.text()
    const injectedHtml = injectEmbedHeightScript(rawHtml)
    const encoded = new TextEncoder().encode(injectedHtml)
    headers.set("Content-Length", String(encoded.byteLength))
    // embed 下发内容已被动态注入脚本，与 R2 底层原文件字节不再一致；
    // 不透传原文件的 httpEtag，避免客户端以原文件标识缓存动态注入内容。
    headers.set("Cache-Control", "private, max-age=3600")
    return new Response(encoded, { headers })
  } else {
    headers.set(
      "Content-Type",
      object.httpMetadata?.contentType ?? "application/octet-stream"
    )
  }
  headers.set("Content-Length", String(object.size))
  if (object.httpEtag) headers.set("ETag", object.httpEtag)
  headers.set("Cache-Control", "private, max-age=3600")
  return new Response(object.body, { headers })
})
