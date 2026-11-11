/**
 * 月度 **内容桶**孤儿清理（规格「内容 GC」）：复用图片治理那套框架。
 *
 * 引用集 = 全部 `pages.content_hash` ∪ 全部 `page_revisions.content_hash`
 * （含回收站页面与它们的版本）。不在引用集、且上传超过 30 天的 `content/<sha256>`
 * 对象才会被删。
 *
 * 与图片清理的隔离是硬要求：本文件只碰 `CONTENT`（ciki-content），
 * 图片清理只碰 `R2`（ciki-assets）；两边共用同一套锁/幂等闸/日志框架（按 kind 分区），
 * 但扫描与删除各自只作用于自己的桶。
 */
import { listReferencedContentHashes } from "../db/queries/r2-cleanup"
import {
  runBucketCleanup,
  type BucketCleanupResult,
  type CleanupKindSpec,
  type RunCleanupOptions
} from "./bucket-cleanup"
import { contentObjectKey } from "./content-store"
import { getTablePrefix } from "../lib/table-prefix"
import type { Env } from "../types"

/** 内容桶的引用集：库里全部内容指针 → 对象 key。 */
export async function collectReferencedContentKeys(
  env: Env
): Promise<Set<string>> {
  const prefix = getTablePrefix(env)
  const hashes = await listReferencedContentHashes(env.DB, prefix)
  const keys = new Set<string>()
  for (const hash of hashes) {
    if (!hash) continue
    keys.add(contentObjectKey(hash))
  }
  return keys
}

/** 内容桶的清理 spec：只扫 `CONTENT`（ciki-content）。 */
export const contentCleanupSpec: CleanupKindSpec = {
  kind: "content",
  bucket: (env) => env.CONTENT,
  collectReferenced: collectReferencedContentKeys
}

/** 跑一轮内容 GC（自动入口与管理员接口共用）。 */
export function runContentCleanup(
  env: Env,
  options: RunCleanupOptions
): Promise<BucketCleanupResult> {
  return runBucketCleanup(env, contentCleanupSpec, options)
}
