/**
 * 月度 R2 **图片桶**孤儿清理（规格 §3）：唯一实现，两个自动入口（Cron / waker 回调）
 * 与管理员的验收接口都调这里，绝不各写一套。
 *
 * 引用集 = 全部 `users.avatar_key` ∪ 全部页面 `content_html` / `content_md` 里出现的
 * `/api/files/<key>` ∪ 全部历史版本正文（版本正文只在内容桶里，必须按内容哈希去重后
 * 解压再扫）。回收站页面（`deleted_at` 非空、行还在）同样计入——页面彻底删除前它的
 * 图一律保留。
 *
 * 只扫 `ciki-assets`：锁、幂等闸、30 天龄、分页、上限与日志行全在
 * `core/bucket-cleanup.ts`（内容桶清理共用同一套）。
 */
import {
  listAvatarKeys,
  listContentRefScansBatch,
  listDistinctRevisionHashes,
  listPageImageBodiesBatch,
  upsertContentRefScans,
  MAX_UNCACHED_IMAGE_SCAN_OBJECTS
} from "../db/queries/r2-cleanup"
import {
  BucketCleanupBusyError,
  runBucketCleanup,
  type BucketCleanupResult,
  type BucketCleanupSummary,
  type CleanupKindSpec,
  type RunCleanupOptions
} from "./bucket-cleanup"
import { runContentCleanup } from "./content-cleanup"
import { readContent } from "./content-store"
import { getTablePrefix } from "../lib/table-prefix"
import type { Env } from "../types"

export {
  CLEANUP_LOCK_TTL_MS,
  CLEANUP_MIN_AGE_DAYS,
  CLEANUP_RERUN_GUARD_DAYS,
  DELETE_LIMIT_PER_RUN,
  cleanupLockRemainingSeconds,
  cleanupRunDto,
  BucketCleanupBusyError as R2CleanupBusyError
} from "./bucket-cleanup"
export {
  MAX_UNCACHED_IMAGE_SCAN_OBJECTS,
  MAX_IMAGE_SCAN_OBJECTS
} from "../db/queries/r2-cleanup"

export type R2CleanupSummary = BucketCleanupSummary
export type R2CleanupResult = BucketCleanupResult

/**
 * waker 管理面里注册的任务名（舰队侧一次性静态注册）。必须与平台里建的任务名
 * 逐字一致：receiver 按名字分发，不一致会回 404 `unknown_job`。
 * 注册信息：回调 URL `<站点域名>/_waker/execute`、cron `0 1 1 * *`、
 * 时区 `Asia/Shanghai`（= 每月 1 日 01:00）。两个种类在同一次回调里依次跑。
 */
export const R2_CLEANUP_JOB_NAME = "monthly-r2-orphan-cleanup"

/**
 * 正文里的资产引用：`/api/files/<key>`，或 Excalidraw 画布块的
 * `data-scene-key="<key>"` / `data-preview-key="<key>"` / JSON 中的 `sceneKey`，
 * 或 Embed 内容块的 `data-key="<key>"` / JSON 中的 `key`（`embeds/<uuid>.html`）。
 * key 的字符集按上传 key 的可能形状取，前缀 key（`pages/…`、`embeds/…`）与存量平铺
 * key 同一套匹配、不做区分。
 */
const FILE_REF_RE =
  /(?:\/api\/files\/|data-(?:scene-key|preview-key|key)="|"(?:sceneKey|previewKey|key)":\s*")([A-Za-z0-9._%/-]+)/g

/** 从一段正文（HTML / Markdown / JSON）里取出所有被引用的图片 key。 */
export function extractFileKeys(text: string): string[] {
  const keys: string[] = []
  for (const match of text.matchAll(FILE_REF_RE)) {
    const raw = match[1]
    if (!raw) continue
    // 前缀 key 可能以 %2F 编码出现；解码失败就按原样入集（宁可多留，不可误删）。
    let key = raw
    try {
      key = decodeURIComponent(raw)
    } catch {
      key = raw
    }
    if (key.length > 0) keys.push(key)
  }
  return keys
}

function collectKeysInto(target: Set<string>, text: string): void {
  for (const key of extractFileKeys(text)) target.add(key)
}

/**
 * 建图片引用集。
 *
 * 页面正文按 keyset 分批读 `content_html` / `content_md`（图片引用一定在这两列里，
 * 不必读内容桶）；版本正文改走扫描缓存（`content_ref_scan`）：分批查缓存（每批 ≤100 个），
 * 命中则解析 key 入集；损坏或未命中则按未命中收集。未命中数超过
 * {@link MAX_UNCACHED_IMAGE_SCAN_OBJECTS} 时抛错中止本轮（fail closed，不删任何对象）。
 * 随后逐个读桶解压扫引用，并回填缓存表（INSERT OR REPLACE）。
 */
export async function collectReferencedKeys(env: Env): Promise<Set<string>> {
  const prefix = getTablePrefix(env)
  const referenced = new Set<string>()

  for (const key of await listAvatarKeys(env.DB, prefix)) {
    const trimmed = key.trim()
    if (trimmed.length > 0) referenced.add(trimmed)
  }

  let afterPageId = 0
  for (;;) {
    const rows = await listPageImageBodiesBatch(env.DB, prefix, afterPageId)
    if (rows.length === 0) break
    for (const row of rows) {
      collectKeysInto(referenced, row.content_html)
      collectKeysInto(referenced, row.content_md)
    }
    afterPageId = rows[rows.length - 1].id
  }

  const hashes = await listDistinctRevisionHashes(env.DB, prefix)
  const cachedRows = await listContentRefScansBatch(env.DB, prefix, hashes)
  const cacheMap = new Map<string, string>()
  for (const row of cachedRows) {
    cacheMap.set(row.content_hash, row.file_keys)
  }

  const missHashes: string[] = []
  for (const hash of hashes) {
    const rawJson = cacheMap.get(hash)
    if (rawJson !== undefined) {
      let parsed: unknown = null
      try {
        parsed = JSON.parse(rawJson)
      } catch {
        parsed = null
      }
      if (Array.isArray(parsed) && parsed.every((k) => typeof k === "string")) {
        for (const key of parsed) {
          referenced.add(key)
        }
        continue
      }
      // 缓存行损坏：按未命中处理（后续重读并覆写）
    }
    missHashes.push(hash)
  }

  if (missHashes.length > MAX_UNCACHED_IMAGE_SCAN_OBJECTS) {
    throw new Error(
      `too many uncached content objects to scan for image references ` +
        `(${missHashes.length} > ${MAX_UNCACHED_IMAGE_SCAN_OBJECTS}); nothing was deleted`
    )
  }

  const pendingScans: Array<{
    content_hash: string
    file_keys: string[]
    scanned_at: string
  }> = []

  for (const hash of missHashes) {
    const content = await readContent(env, hash)
    const keys = extractFileKeys(content)
    for (const key of keys) {
      referenced.add(key)
    }
    pendingScans.push({
      content_hash: hash,
      file_keys: keys,
      scanned_at: new Date().toISOString()
    })
    if (pendingScans.length >= 50) {
      await upsertContentRefScans(env.DB, prefix, pendingScans)
      pendingScans.length = 0
    }
  }

  if (pendingScans.length > 0) {
    await upsertContentRefScans(env.DB, prefix, pendingScans)
  }

  return referenced
}

/** 图片桶的清理 spec：只扫 `R2`（ciki-assets）。 */
export const imageCleanupSpec: CleanupKindSpec = {
  kind: "images",
  bucket: (env) => env.R2,
  collectReferenced: collectReferencedKeys
}

/** 跑一轮图片清理（自动入口与管理员接口共用）。 */
export function runR2Cleanup(
  env: Env,
  options: RunCleanupOptions
): Promise<BucketCleanupResult> {
  return runBucketCleanup(env, imageCleanupSpec, options)
}

/** 一轮清理的结局：跑完（带结果）或因同类清理持锁而跳过。 */
export type CleanupRunOutcome =
  | { kind: "images" | "content"; status: "ran"; result: BucketCleanupResult }
  | {
      kind: "images" | "content"
      status: "busy"
      retryAfterSeconds: number
    }

/**
 * 一次触发跑完两套清理：先图片、后内容。
 *
 * 共用这套编排的三个入口（内置 Cron、waker 回调、管理员的「全部跑一轮」）口径一致；
 * 某一类正在跑（`BucketCleanupBusyError`）只跳过那一类，另一类照跑。其它异常原样
 * 抛出，让调用方（waker 重试 / Cron 记日志）自行处置。
 */
export async function runAllBucketCleanups(
  env: Env,
  options: RunCleanupOptions
): Promise<CleanupRunOutcome[]> {
  const outcomes: CleanupRunOutcome[] = []
  const order = [
    ["images", () => runR2Cleanup(env, options)],
    ["content", () => runContentCleanup(env, options)]
  ] as const

  for (const [kind, run] of order) {
    try {
      outcomes.push({ kind, status: "ran", result: await run() })
    } catch (err) {
      if (err instanceof BucketCleanupBusyError) {
        outcomes.push({
          kind,
          status: "busy",
          retryAfterSeconds: err.retryAfterSeconds
        })
        continue
      }
      throw err
    }
  }
  return outcomes
}
