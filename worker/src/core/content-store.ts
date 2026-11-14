/**
 * 页面正文的 R2 内容寻址存储（规格「内容上 R2」）：唯读写入口。
 *
 * 口径：
 * - 对象 key = `content/<sha256>`，哈希对象是 **gzip 之前**的原始 JSON UTF-8 字节；
 * - 本体存 gzip 字节（压缩复用 `lib/gzip.ts`，哈希复用 `core/auth.ts` 的 `sha256Hex`，
 *   不引第三方库、不手写压缩/摘要）；
 * - 相同内容天然共用同一对象；对象不可变，同 key 永不覆写不同内容（同哈希 PUT 同字节
 *   幂等，所以写路径不需要先 HEAD）；
 * - 桶 `ciki-content` 与图片桶 `ciki-assets` 完全隔离，两边清理互不影响。
 *
 * 写路径的顺序由调用方保证（先 R2 后 D1）：这里只负责「上传并拿回哈希」，失败只留孤儿
 * 对象，由月度内容 GC 收。
 */
import { sha256Hex } from "./auth"
import { gzipText, gunzipText } from "../lib/gzip"
import type { Env } from "../types"

/** 对象 key 前缀：内容桶里只有这一类对象，与图片桶的 `pages/…`、`avatars/…` 无关。 */
export const CONTENT_KEY_PREFIX = "content/"

/** 哈希 hex 的长度（sha256）。 */
const SHA256_HEX_LENGTH = 64

/** 纯函数：哈希 → 对象 key。 */
export function contentObjectKey(hash: string): string {
  return `${CONTENT_KEY_PREFIX}${hash}`
}

/** 纯函数：key → 哈希（形状不符返回 null）。 */
export function hashFromContentKey(key: string): string | null {
  if (!key.startsWith(CONTENT_KEY_PREFIX)) return null
  const hash = key.slice(CONTENT_KEY_PREFIX.length)
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null
}

/** 正文 JSON → sha256 hex（哈希对象是未压缩的 UTF-8 字节）。 */
export async function hashContent(json: string): Promise<string> {
  return sha256Hex(json)
}

/** 内容对象不存在（被误删、迁移未完成）：调用方转成明确的 5xx，不吞成空正文。 */
export class ContentObjectMissingError extends Error {
  readonly hash: string

  constructor(hash: string) {
    super(`Content object ${contentObjectKey(hash)} is missing`)
    this.name = "ContentObjectMissingError"
    this.hash = hash
  }
}

/** 上传一份正文，返回它的内容哈希。同哈希重复上传是幂等的。 */
export async function putContent(env: Env, json: string): Promise<string> {
  const hash = await hashContent(json)
  await putContentHashed(env, hash, json)
  return hash
}

/**
 * 已知哈希时直接上传（写路径先算哈希做「无改动」判定，改动了才付上传这一步）。
 * 调用方必须保证 `hash === await hashContent(json)`，否则对象会被存到错误的 key 上。
 */
export async function putContentHashed(
  env: Env,
  hash: string,
  json: string
): Promise<void> {
  const compressed = await gzipText(json)
  await env.CONTENT.put(contentObjectKey(hash), compressed, {
    httpMetadata: { contentType: "application/gzip" },
    // 便于排障时确认对象身份：哈希本身不是机密。
    customMetadata: { sha256: hash, encoding: "gzip" }
  })
}

/** 按哈希取回正文 JSON（解压后）。对象缺失抛 {@link ContentObjectMissingError}。 */
export async function readContent(env: Env, hash: string): Promise<string> {
  if (!new RegExp(`^[0-9a-f]{${SHA256_HEX_LENGTH}}$`).test(hash)) {
    // 库里的指针不是哈希形状（脏数据）：按缺对象处理，不拿它去猜 key。
    throw new ContentObjectMissingError(hash)
  }
  const object = await env.CONTENT.get(contentObjectKey(hash))
  if (!object) throw new ContentObjectMissingError(hash)
  return gunzipText(await object.arrayBuffer())
}
