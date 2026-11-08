/**
 * 图片地址白名单 —— 与后端冻结契约（docs/api-contract.md「服务端消毒规则」）逐字对齐。
 *
 * 前端清洗不是安全边界，但这里必须和后端认同同一套地址，否则会出现
 * 「编辑态能显示、保存后被改写」的不一致；更重要的是 data-original-src
 * 会被渲染成可点击链接，任何可编辑页面的用户都能写入它。
 */

/**
 * 本站图床：`/api/files/<uuid>.<png|jpg|jpeg|gif|webp>`（存量平铺）或
 * `/api/files/(pages|imports)/<uuid>.<ext>`（新前缀，与 worker 的
 * lib/sanitize.ts 同义）。头像的 avatars/ 不进正文，所以不在白名单里。
 */
const HOSTED_FILE_SRC =
  /^\/api\/files\/(?:(?:pages|imports)\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|gif|webp)$/i

/** 内联图片：只允许这四种栅格格式的 base64（不收 svg） */
const HOSTED_DATA_SRC =
  /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i

/** 可以直接作为 <img src> 保留的地址。 */
export function isHostedImageSrc(src: string): boolean {
  if (!src) return false
  return HOSTED_FILE_SRC.test(src) || HOSTED_DATA_SRC.test(src)
}

/** 可以放进 data-original-src、并渲染成链接的外部地址：http(s) 或根相对路径。 */
export function isSafeExternalUrl(url: string): boolean {
  if (!url) return false
  if (/^https?:\/\//i.test(url)) return true
  return url.startsWith("/") && !url.startsWith("//")
}

/** 不安全就返回空串，调用方据此决定展示纯文本还是链接。 */
export function safeExternalUrl(url: string): string {
  return isSafeExternalUrl(url) ? url : ""
}
