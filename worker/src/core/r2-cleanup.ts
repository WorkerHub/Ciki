/**
 * 月度 R2 孤儿清理（规格 §3）：唯一实现，两个自动入口（Cron / waker 回调）与
 * 管理员的验收接口都调这里，绝不各写一套。
 *
 * 判定口径：
 *   - **引用集**（命中即保留）= 全部 `users.avatar_key` ∪ 全部页面正文 ∪ 全部历史
 *     版本正文里出现的 `/api/files/<key>`。回收站页面（`deleted_at` 非空、行还在）
 *     同样计入——页面彻底删除前它的图一律保留。历史版本自 gzip 化之后正文只有一份
 *     压缩的 JSON，扫之前先解压（无压缩字节的存量行按原三列扫）。
 *   - **删除条件**：同时满足「不在引用集内」且「R2 对象的 uploaded 距今 > 30 天」。
 *   - **防双跑**：两个入口各自先查 `WAKER_SIGNING_KEY` 有没有（不是本入口就不跑），
 *     另有日志表兜底——距上次真实成功运行 < 20 天的触发一律跳过并记一行日志。
 *     `dryRun` 只算不删，不构成双跑，因此不受这条兜底限制。
 *   - **执行安全**：分页列全 bucket；单次最多真删 {@link DELETE_LIMIT_PER_RUN} 个，
 *     触顶即标 truncated 并停止删除（扫描继续，计数保持完整）；删除逐个执行、
 *     单个失败不中断整轮，失败数单独计入日志。
 */
import {
  insertCleanupRun,
  lastSuccessfulCleanupRun,
  listAvatarKeys,
  listPageBodiesBatch,
  listRevisionBodiesBatch,
  type CleanupRunRow,
  type CleanupStatus,
  type CleanupTrigger
} from "../db/queries/r2-cleanup"
import { hasGzipColumn } from "../db/queries/revisions"
import { gunzipText } from "../lib/gzip"
import { getTablePrefix } from "../lib/table-prefix"
import type { Env } from "../types"

/** 删除门槛：R2 对象 uploaded 距今超过 30 天才可能被删（30 天内一律不动）。 */
export const CLEANUP_MIN_AGE_DAYS = 30
/** 幂等兜底：距上次真实成功运行不足 20 天的一律跳过（dry_run 不受此限）。 */
export const CLEANUP_RERUN_GUARD_DAYS = 20
/** 单次运行真删上限；触顶即停止删除并标 truncated（日志与摘要都带该标志）。 */
export const DELETE_LIMIT_PER_RUN = 200
/**
 * waker 管理面里注册的任务名（舰队侧一次性静态注册）。必须与平台里建的任务名
 * 逐字一致：receiver 按名字分发，不一致会回 404 `unknown_job`。
 * 注册信息：回调 URL `<站点域名>/_waker/execute`、cron `0 1 1 * *`、
 * 时区 `Asia/Shanghai`（= 每月 1 日 01:00）。
 */
export const R2_CLEANUP_JOB_NAME = "monthly-r2-orphan-cleanup"

/** R2 list 的单页条数（Cloudflare 上限 1000）。 */
const LIST_PAGE_SIZE = 1000

/**
 * 正文里的图片引用：`/api/files/<key>`。key 的字符集按上传 key 的可能形状取，
 * 前缀 key（`pages/…`）与存量平铺 key 同一套匹配、不做区分。
 */
const FILE_REF_RE = /\/api\/files\/([A-Za-z0-9._%/-]+)/g

/** 一轮清理的结果（日志行 + 接口响应用同一份口径）。 */
export interface R2CleanupSummary {
  startedAt: string
  finishedAt: string
  trigger: CleanupTrigger
  status: CleanupStatus
  dryRun: boolean
  scanned: number
  referenced: number
  deleted: number
  youngSkipped: number
  failed: number
  truncated: boolean
}

/** 日志行 → 接口 DTO（DB 列 snake_case，对外一律 camelCase）。 */
export function cleanupRunDto(row: CleanupRunRow): R2CleanupSummary {
  return {
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    trigger: row.trigger,
    status: row.status,
    dryRun: row.dry_run === 1,
    scanned: row.scanned,
    referenced: row.referenced,
    deleted: row.deleted,
    youngSkipped: row.young_skipped,
    failed: row.failed,
    truncated: row.truncated === 1
  }
}

/** 从一段正文（Tiptap JSON 或 HTML）里取出所有被引用的 key。 */
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
 * 版本行 → 可扫描的正文文本。
 *
 * 已 gzip 化：解压出 JSON 再扫（扫描口径与改前一致——HTML 里的 key 本来就全部来自
 * JSON）。旧形态：`content_json` 与 `content_html` 都扫，与改前这行代码逐字相同。
 * 解压失败不捕：整轮记 `status:"failed"`、一个对象都不删（删除发生在引用集算完之后）。
 */
async function revisionTexts(row: {
  content_json: string
  content_html: string
  content_gzip?: ArrayBuffer | ArrayBufferView | null
}): Promise<string[]> {
  if (row.content_gzip) return [await gunzipText(row.content_gzip)]
  return [row.content_json, row.content_html]
}

/**
 * 建引用集。页面与版本按 keyset 分批读正文。
 *
 * 页面行：只扫包含 `/api/files/` 的行（`instr` 预筛）。
 * 版本行：gzip 化以后压缩字节无法预筛，改成一页页取出来解压再扫；升级前的库仍沿
 * 用 `instr` 预筛（见 db/queries/r2-cleanup.ts）。
 * 返回集合的大小就是日志里的「引用数」。
 */
export async function collectReferencedKeys(env: Env): Promise<Set<string>> {
  const prefix = getTablePrefix(env)
  const referenced = new Set<string>()

  for (const key of await listAvatarKeys(env.DB, prefix)) {
    const trimmed = key.trim()
    if (trimmed.length > 0) referenced.add(trimmed)
  }

  let afterPageId = ""
  for (;;) {
    const rows = await listPageBodiesBatch(env.DB, prefix, afterPageId)
    if (rows.length === 0) break
    for (const row of rows) {
      collectKeysInto(referenced, row.content_json)
      collectKeysInto(referenced, row.content_html)
    }
    afterPageId = rows[rows.length - 1].id
  }

  const gzipReady = await hasGzipColumn(env.DB, prefix)
  let afterRevisionId = ""
  for (;;) {
    const rows = await listRevisionBodiesBatch(
      env.DB,
      prefix,
      afterRevisionId,
      gzipReady
    )
    if (rows.length === 0) break
    for (const row of rows) {
      for (const text of await revisionTexts(row)) {
        collectKeysInto(referenced, text)
      }
    }
    afterRevisionId = rows[rows.length - 1].id
  }

  return referenced
}

interface CleanupCounters {
  scanned: number
  referenced: number
  deleted: number
  youngSkipped: number
  failed: number
  truncated: boolean
}

function emptyCounters(): CleanupCounters {
  return {
    scanned: 0,
    referenced: 0,
    deleted: 0,
    youngSkipped: 0,
    failed: 0,
    truncated: false
  }
}

async function writeRun(
  env: Env,
  run: {
    startedAt: Date
    trigger: CleanupTrigger
    status: CleanupStatus
    dryRun: boolean
    counters: CleanupCounters
  }
): Promise<R2CleanupSummary> {
  const prefix = getTablePrefix(env)
  const finishedAt = new Date()
  const row: CleanupRunRow = {
    id: crypto.randomUUID(),
    started_at: run.startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    trigger: run.trigger,
    status: run.status,
    dry_run: run.dryRun ? 1 : 0,
    scanned: run.counters.scanned,
    referenced: run.counters.referenced,
    deleted: run.counters.deleted,
    young_skipped: run.counters.youngSkipped,
    failed: run.counters.failed,
    truncated: run.counters.truncated ? 1 : 0
  }
  await insertCleanupRun(env.DB, prefix, row)
  return cleanupRunDto(row)
}

export interface RunCleanupOptions {
  trigger: CleanupTrigger
  /** 只算不删（管理员验收用）：R2 不做任何删除，日志里 dry_run=1。 */
  dryRun: boolean
}

/**
 * 跑一轮清理。参数只有触发来源与 dry_run——调用方（Cron / waker / 管理接口）
 * 必须先按 `WAKER_SIGNING_KEY` 判定自己是不是本入口。
 *
 * 扫描期异常会先落一行 `status: "failed"`（保留已扫到的计数）再抛出：
 * waker 入口让它冒出去好让平台按 executionId 重试，Cron/管理接口各自捕获。
 */
export async function runR2Cleanup(
  env: Env,
  options: RunCleanupOptions
): Promise<R2CleanupSummary> {
  const prefix = getTablePrefix(env)
  const startedAt = new Date()
  const counters = emptyCounters()

  if (!options.dryRun) {
    const last = await lastSuccessfulCleanupRun(env.DB, prefix)
    if (last !== null) {
      const elapsedMs = startedAt.getTime() - Date.parse(last.started_at)
      const guardMs = CLEANUP_RERUN_GUARD_DAYS * 24 * 60 * 60 * 1000
      if (Number.isFinite(elapsedMs) && elapsedMs < guardMs) {
        // 幂等兜底：距上次真实成功运行不到 20 天，这一轮什么也不做，只留一行日志。
        return writeRun(env, {
          startedAt,
          trigger: options.trigger,
          status: "skipped",
          dryRun: options.dryRun,
          counters
        })
      }
    }
  }

  const ageCutoff =
    startedAt.getTime() - CLEANUP_MIN_AGE_DAYS * 24 * 60 * 60 * 1000

  try {
    const referenced = await collectReferencedKeys(env)
    counters.referenced = referenced.size

    let cursor: string | undefined
    do {
      const page = await env.R2.list({ limit: LIST_PAGE_SIZE, cursor })
      for (const object of page.objects) {
        counters.scanned += 1
        if (referenced.has(object.key)) continue

        const uploadedMs =
          object.uploaded instanceof Date
            ? object.uploaded.getTime()
            : Date.parse(String(object.uploaded))
        // 30 天内一律不动；时间读不出来同样按「太新」处理，绝不错删。
        if (!Number.isFinite(uploadedMs) || uploadedMs > ageCutoff) {
          counters.youngSkipped += 1
          continue
        }

        if (counters.truncated || counters.deleted >= DELETE_LIMIT_PER_RUN) {
          counters.truncated = true
          continue
        }
        if (options.dryRun) {
          counters.deleted += 1
          continue
        }
        try {
          await env.R2.delete(object.key)
          counters.deleted += 1
        } catch {
          // 单个对象删不掉不影响整轮，失败单独计数（下一轮还会再遇到它）。
          counters.failed += 1
        }
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  } catch (err) {
    try {
      await writeRun(env, {
        startedAt,
        trigger: options.trigger,
        status: "failed",
        dryRun: options.dryRun,
        counters
      })
    } catch (logError) {
      // 写日志本身失败（例如迁移还没跑）不能盖掉真正的错误。
      console.error(
        "r2 cleanup: failed to record the failed run:",
        logError instanceof Error ? logError.message : String(logError)
      )
    }
    throw err
  }

  return writeRun(env, {
    startedAt,
    trigger: options.trigger,
    status: "ok",
    dryRun: options.dryRun,
    counters
  })
}
