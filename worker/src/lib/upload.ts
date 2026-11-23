/**
 * 文件上传的单一入口：类型白名单（图片按魔数、场景 JSON 按白名单预检消毒）、
 * 图片 ≤10MB / 场景 JSON ≤2MB、落 R2。
 *
 * `/api/files`、`/api/import/files` 与 `/api/me/avatar` 共用同一份实现（规格
 * §12.1 / §1：头像专用口与导入都不复刻一套校验，口径与 /api/files 完全一致）；
 * 上传者 id 与类别由调用方传入，两者一起写进 R2 的 customMetadata。
 */
import type { Context } from "hono"
import type { HonoEnv } from "../types"
import { sanitizeExcalidrawSceneJson } from "./excalidraw-sanitize"

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_SCENE_BYTES = 2 * 1024 * 1024
export const MAX_EMBED_BYTES = 1024 * 1024

/** embed 下发的 Content-Type（含字符集，规格 §2 要求逐字带上）。 */
export const EMBED_CONTENT_TYPE = "text/html; charset=utf-8"

/** embed 文件 key 形状：`embeds/<uuid>.html`，与原文件名无关、永不迁移。 */
export const EMBED_KEY_RE =
  /^embeds\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.html$/

/**
 * embed 下发的 CSP（规格 §2 安全硬要求）：`sandbox` 指令让文件即使被顶层打开也是
 * opaque origin——读不到站内 localStorage、发不出带凭据的请求；`default-src 'none'`
 * 再封死一切外链资源，只放行内联脚本/样式与 data:/blob: 媒体。动画必须是单文件
 * 自包含，外链一律由 CSP 阻断，没有白名单。
 */
export const EMBED_CONTENT_SECURITY_POLICY =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"

/**
 * embed 下发注入的高度上报脚本。
 *
 * 协议约定（规格 §1/§2/§5）：
 * 1. 独立作用域（IIFE）+ 异常自吞，绝不影响原文件自身脚本执行；
 * 2. 在沙箱内量取内容实际高度（Math.max(documentElement.scrollHeight, body.scrollHeight)）；
 * 3. 页面就绪后（立即执行 + DOMContentLoaded / load）上报一次；
 * 4. 用 ResizeObserver 持续监听 documentElement 与 body 的尺寸变化持续上报；
 * 5. 经 window.parent.postMessage 发给父页，消息体形如 `{ type: "ciki-embed-height", height: <number> }`；
 * 6. 走既有 CSP（script-src 'unsafe-inline'），不新增任何权限。
 */
export const EMBED_HEIGHT_REPORTER_SCRIPT = `<script>
(function() {
  try {
    var send = function() {
      try {
        var de = document.documentElement;
        var b = document.body;
        var h = Math.max(de ? de.scrollHeight : 0, b ? b.scrollHeight : 0);
        if (window.parent) {
          window.parent.postMessage({ type: "ciki-embed-height", height: h }, "*");
        }
      } catch (_) {}
    };
    send();
    var ro = null;
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(function() {
        send();
      });
      if (document.documentElement) ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    }
    var onReady = function() {
      send();
      if (ro && document.body) {
        try {
          ro.observe(document.body);
        } catch (_) {}
      }
    };
    window.addEventListener("DOMContentLoaded", onReady);
    window.addEventListener("load", onReady);
  } catch (_) {}
})();
</script>`

/**
 * 在 embed HTML 响应内容中注入高度上报脚本：
 * - 优先在最后一个 \`</body>\` 前注入（在原字符串上使用大小写不敏感正则匹配，避免 toLowerCase() 改变 Unicode 码元长度导致索引错位）；
 * - 无 body 标签时追加在文件末尾；
 * - 注入只发生在下发响应里，R2 存储的原文件不改，导出 zip 仍保持原文件逐字字节。
 * - 已知限制（规格定版口径）：字符串层级匹配最后一个 \`</body>\` 标签，若原文件内联 JS 字符串或注释中包含 \`</body>\`，注入将落在该字符串前。
 */
export function injectEmbedHeightScript(html: string): string {
  if (
    html.includes('type: "ciki-embed-height"') ||
    html.includes('type:"ciki-embed-height"')
  ) {
    return html
  }
  let lastIndex = -1
  for (const match of html.matchAll(/<\/body>/gi)) {
    lastIndex = match.index
  }
  if (lastIndex !== -1) {
    return (
      html.slice(0, lastIndex) +
      EMBED_HEIGHT_REPORTER_SCRIPT +
      html.slice(lastIndex)
    )
  }
  return html + EMBED_HEIGHT_REPORTER_SCRIPT
}

/** 新上传 key 的来源类别（规格 §1）：只决定 key 的前缀目录。 */
export type UploadCategory = "avatars" | "pages" | "imports"

/**
 * 对外暴露的 key 形状：`<类别>/<UUID>.<扩展名>`，或存量的平铺
 * `<UUID>.<扩展名>`。读接口与头像校验按它挡掉随便拼的路径。
 * 存量平铺 key 永不迁移（规格 §2），所以两种形状都认；未知前缀与形状不符
 * （多级前缀、大写 hex、svg 等）一律不匹配。
 */
export const UPLOAD_KEY_RE =
  /^(?:(?:avatars|pages|imports)\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|gif|webp|json)$/

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
 * `file` 字段存在 → 大小上限（图片 10MB、场景 JSON 2MB） → 魔数或 JSON 消毒预检。
 * 失败时把可直接返回的响应带出来，调用方不必重复这套口径。
 */
export async function readUpload(
  c: Context<HonoEnv>,
  allowJson = true
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

  const isJson =
    allowJson &&
    (file.type === "application/json" ||
      file.name.toLowerCase().endsWith(".json"))

  if (isJson) {
    if (file.size > MAX_SCENE_BYTES) {
      return {
        ok: false,
        response: c.json(
          { error: "File too large", code: "FILE_TOO_LARGE" },
          413
        )
      }
    }

    const text = await file.text()
    const sanitized = sanitizeExcalidrawSceneJson(text)
    if (!sanitized) {
      return {
        ok: false,
        response: c.json({ error: "Invalid Excalidraw scene JSON" }, 400)
      }
    }

    const sanitizedBytes = new TextEncoder().encode(JSON.stringify(sanitized))
    if (sanitizedBytes.length > MAX_SCENE_BYTES) {
      return {
        ok: false,
        response: c.json(
          { error: "File too large", code: "FILE_TOO_LARGE" },
          413
        )
      }
    }

    return {
      ok: true,
      bytes: sanitizedBytes,
      type: { mime: "application/json", ext: "json" }
    }
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      response: c.json({ error: "File too large", code: "FILE_TOO_LARGE" }, 413)
    }
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const type = sniffImage(bytes)
  if (type) {
    return { ok: true, bytes, type }
  }

  if (allowJson) {
    if (file.size <= MAX_SCENE_BYTES) {
      const text = new TextDecoder().decode(bytes)
      const sanitized = sanitizeExcalidrawSceneJson(text)
      if (sanitized) {
        const sanitizedBytes = new TextEncoder().encode(
          JSON.stringify(sanitized)
        )
        if (sanitizedBytes.length > MAX_SCENE_BYTES) {
          return {
            ok: false,
            response: c.json(
              { error: "File too large", code: "FILE_TOO_LARGE" },
              413
            )
          }
        }
        return {
          ok: true,
          bytes: sanitizedBytes,
          type: { mime: "application/json", ext: "json" }
        }
      }
    }
  }

  return {
    ok: false,
    response: c.json(
      {
        error: allowJson
          ? "Only png/jpg/jpeg/gif/webp images or excalidraw json are accepted"
          : "Only png/jpg/jpeg/gif/webp images are accepted"
      },
      400
    )
  }
}

export async function readImageUpload(
  c: Context<HonoEnv>,
  allowJson = true
): Promise<UploadRead> {
  return readUpload(c, allowJson)
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
  const allowJson = category !== "avatars"
  const read = await readUpload(c, allowJson)
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

/**
 * embed 上传（规格 §2）：只收 `.html`、≤1MB、不做任何消毒。
 *
 * 安全完全落在「下发 + 渲染隔离」两层（规格 §3/§4）：下发带 CSP `sandbox` 与
 * `nosniff`，读态 iframe 再叠 `sandbox="allow-scripts"`。因此这里只做类型与体积
 * 校验，key 用随机 UUID、绝不落原文件名。
 */

export type EmbedUploadRead = { ok: true; bytes: Uint8Array } | UploadRejected

/**
 * 读取并校验 `multipart/form-data` 单文件：content-length 预检 → 解析表单 →
 * `file` 字段存在 → 扩展名必须是 `.html` → 大小 ≤1MB。失败时把可直接返回的响应
 * 带出来，调用方不必重复这套口径。
 */
export async function readEmbedUpload(
  c: Context<HonoEnv>
): Promise<EmbedUploadRead> {
  const declared = Number.parseInt(c.req.header("content-length") ?? "0", 10)
  if (declared > MAX_EMBED_BYTES + 1024) {
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

  if (!file.name.toLowerCase().endsWith(".html")) {
    return {
      ok: false,
      response: c.json({ error: "Only .html files are accepted" }, 400)
    }
  }

  if (file.size > MAX_EMBED_BYTES) {
    return {
      ok: false,
      response: c.json({ error: "File too large", code: "FILE_TOO_LARGE" }, 413)
    }
  }

  return { ok: true, bytes: new Uint8Array(await file.arrayBuffer()) }
}

/** 落盘后的元数据：与图片上传同一响应形状（key / url / contentType / size）。 */
export interface StoredEmbed {
  key: string
  url: string
  contentType: string
  size: number
}

export type EmbedStored = { ok: true; embed: StoredEmbed } | UploadRejected

/**
 * 校验 + 落 R2：key 固定 `embeds/<uuid>.html`，customMetadata 记 uploaderId 与
 * category。与图片落盘分开一支实现——embed 没有魔数/消毒预检，也不走 `sniffImage`。
 */
export async function storeEmbedUpload(
  c: Context<HonoEnv>,
  uploaderId: number
): Promise<EmbedStored> {
  const read = await readEmbedUpload(c)
  if (!read.ok) return read

  const { bytes } = read
  const key = `embeds/${crypto.randomUUID()}.html`
  await c.env.R2.put(key, bytes, {
    httpMetadata: { contentType: EMBED_CONTENT_TYPE },
    customMetadata: { uploaderId: String(uploaderId), category: "embeds" }
  })

  return {
    ok: true,
    embed: {
      key,
      url: `/api/files/${key}`,
      contentType: EMBED_CONTENT_TYPE,
      size: bytes.length
    }
  }
}

/**
 * 处理 `multipart/form-data` 单文件 embed 上传：成功 201，响应形状与图片上传一致。
 */
export async function handleEmbedUpload(
  c: Context<HonoEnv>,
  uploaderId: number
): Promise<Response> {
  const stored = await storeEmbedUpload(c, uploaderId)
  if (!stored.ok) return stored.response
  return c.json(stored.embed, 201)
}
