/**
 * 月度 R2 桶治理的通用执行器：图片桶与内容桶共用同一套锁、幂等闸、30 天龄、
 * 分页与日志口径，只有「扫哪个桶」和「引用集怎么算」不同（由调用方以 spec 传入）。
 *
 * 判定口径：
 *   - **引用集**（命中即保留）由 {@link CleanupKindSpec.collectReferenced} 给出；
 *   - **删除条件**：同时满足「不在引用集内」且「R2 对象的 uploaded 距今 > 30 天」；
 *   - **防双跑**：两个入口各自先查 `WAKER_SIGNING_KEY` 有没有（不是本入口就不跑）。
 *     20 天幂等闸（`rerunGuard: "enforce"`）距上次真实成功运行 < 20 天的触发一律跳过
 *     并记一行日志；`dryRun` 只算不删，不构成双跑，因此不受这条兜底限制。
 *     管理员手动实跑声明 `rerunGuard: "bypass"`：闸只约束自动入口，30 天龄规则照旧。
 *   - **并发互斥**：按 kind 各抢一行锁（`system_settings`，键名带 kind）；抢不到就抛
 *     {@link BucketCleanupBusyError}，一个对象都不扫、不写日志行。锁带 30 分钟 TTL。
 *   - **执行安全**：分页列全 bucket；单次最多真删 {@link DELETE_LIMIT_PER_RUN} 个，触顶
 *     即标 truncated 并停止删除（扫描继续，计数保持完整）；删除逐个执行、单个失败不
 *     中断整轮，失败数单独计入日志。
 *   - **桶隔离**：本执行器只 list/delete 传入的那一个桶，图片与内容两边各自只扫自己
 *     的桶，代码与测试断言都分开。
 */
import {
  insertCleanupLock,
  insertCleanupRun,
  lastSuccessfulCleanupRun,
  readCleanupLock,
  releaseCleanupLock,
  takeoverCleanupLock,
  type CleanupKind,
  type CleanupLockRecord,
  type CleanupRunRow,
  type CleanupStatus,
  type CleanupTrigger
} from "../db/queries/r2-cleanup"
import { getTablePrefix } from "../lib/table-prefix"
import type { Env } from "../types"

/** 删除门槛：R2 对象 uploaded 距今超过 30 天才可能被删（30 天内一律不动）。 */
export const CLEANUP_MIN_AGE_DAYS = 30
/** 幂等兜底：距上次真实成功运行不足 20 天的一律跳过（dry_run 不受此限）。 */
export const CLEANUP_RERUN_GUARD_DAYS = 20
/** 单次运行真删上限；触顶即停止删除并标 truncated（日志与摘要都带该标志）。 */
export const DELETE_LIMIT_PER_RUN = 200
/**
 * 清理锁的有效期：超时即可被下一轮接管，防 Worker 异常退出后永久占锁。
 * 30 分钟远大于单次 handler 的最长执行时间（约 15 分钟），活着的锁不会被误接管。
 */
export const CLEANUP_LOCK_TTL_MS = 30 * 60 * 1000

/** R2 list 的单页条数（Cloudflare 上限 1000）。 */
const LIST_PAGE_SIZE = 1000

/** 一种清理任务的描述（桶 + 引用集）。 */
export interface CleanupKindSpec {
  kind: CleanupKind
  /** 取这一种清理要扫的桶（图片 `R2` / 内容 `CONTENT`）。 */
  bucket: (env: Env) => R2Bucket
  /** 算出引用集（对象 key 形态）。 */
  collectReferenced: (env: Env) => Promise<Set<string>>
}

/** 一轮清理的结果（日志行 + 接口响应用同一份口径）。 */
export interface BucketCleanupSummary {
  kind: CleanupKind
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

/**
 * 一轮清理的接口响应：dry run 多两个只存在于响应里的字段。
 *
 * `prunable` / `prunableBytes` 是「不受单轮删除上限截断」的全量可清理数与总字节，
 * 只给 dry run（管理员第一步预览）用，**不入日志表**。
 */
export type BucketCleanupResult =
  | (BucketCleanupSummary & {
      dryRun: true
      prunable: number
      prunableBytes: number
    })
  | (BucketCleanupSummary & { dryRun: false })

/** 同一时刻已经有一轮同类清理在跑：谁都没扫、没删、也没写日志行。 */
export class BucketCleanupBusyError extends Error {
  readonly kind: CleanupKind
  /** 当前锁的剩余秒数（整数 ≥1），到点后同样的一次调用可以成功。 */
  readonly retryAfterSeconds: number

  constructor(kind: CleanupKind, retryAfterSeconds: number) {
    super(`${kind} cleanup is already running`)
    this.name = "BucketCleanupBusyError"
    this.kind = kind
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds))
  }
}

/**
 * 锁的剩余有效期（秒）。`null` = 无锁、解析不了或已过期（过期锁随时可被接管）。
 */
export function cleanupLockRemainingSeconds(
  record: CleanupLockRecord | null,
  nowMs: number
): number | null {
  if (record === null) return null
  const startedMs = Date.parse(record.startedAt)
  if (!Number.isFinite(startedMs)) return null
  const remainingMs = startedMs + CLEANUP_LOCK_TTL_MS - nowMs
  if (remainingMs <= 0) return null
  return Math.max(1, Math.ceil(remainingMs / 1000))
}

/** 日志行 → 接口 DTO（DB 列 snake_case，对外一律 camelCase）。 */
export function cleanupRunDto(row: CleanupRunRow): BucketCleanupSummary {
  return {
    kind: row.kind,
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

interface CleanupCounters {
  scanned: number
  referenced: number
  deleted: number
  youngSkipped: number
  failed: number
  truncated: boolean
  /** 满足删除条件的对象总数（不受单轮上限影响；只给 dry run 响应，不入库）。 */
  prunable: number
  /** 上述对象的 R2 size 之和（字节；同上，只给 dry run 响应）。 */
  prunableBytes: number
}

function emptyCounters(): CleanupCounters {
  return {
    scanned: 0,
    referenced: 0,
    deleted: 0,
    youngSkipped: 0,
    failed: 0,
    truncated: false,
    prunable: 0,
    prunableBytes: 0
  }
}

/**
 * 日志行 → 接口响应：dry run 才附加 `prunable` / `prunableBytes`。
 * 所有返回点（闸跳过 / 跑完）都经这里，两个出口形状不会分叉。
 */
function withResponseFields(
  summary: BucketCleanupSummary,
  options: RunCleanupOptions,
  counters: CleanupCounters
): BucketCleanupResult {
  if (!options.dryRun) return { ...summary, dryRun: false }
  return {
    ...summary,
    dryRun: true,
    prunable: counters.prunable,
    prunableBytes: counters.prunableBytes
  }
}

async function writeRun(
  env: Env,
  kind: CleanupKind,
  run: {
    startedAt: Date
    trigger: CleanupTrigger
    status: CleanupStatus
    dryRun: boolean
    counters: CleanupCounters
  }
): Promise<BucketCleanupSummary> {
  const prefix = getTablePrefix(env)
  const finishedAt = new Date()
  const row: Omit<CleanupRunRow, "id"> = {
    kind,
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
  const id = await insertCleanupRun(env.DB, prefix, row)
  return cleanupRunDto({ ...row, id })
}

export interface RunCleanupOptions {
  trigger: CleanupTrigger
  /** 只算不删（管理员验收用）：R2 不做任何删除，日志里 dry_run=1。 */
  dryRun: boolean
  /**
   * 20 天幂等闸策略，由调用方显式声明：
   * - `enforce` = 自动入口（Cron / waker）口径，距上次真实成功运行不足 20 天就跳过；
   * - `bypass` = 管理员手动实跑（闸只约束自动入口，30 天龄规则照旧）。
   * `dryRun` 永远不受这条闸约束，与策略无关。
   */
  rerunGuard: "enforce" | "bypass"
}

/** 抢锁；抢到返回锁行的原样 value（释放时拿它做 CAS 比对）。抢不到抛忙。 */
async function acquireCleanupLock(
  env: Env,
  spec: CleanupKindSpec,
  record: CleanupLockRecord,
  nowMs: number
): Promise<string> {
  const prefix = getTablePrefix(env)
  const value = JSON.stringify(record)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await insertCleanupLock(env.DB, prefix, spec.kind, value)) return value

    const current = await readCleanupLock(env.DB, prefix, spec.kind)
    // 插入失败却读不到行：对方刚好在这一刻释放，再插一次。
    if (current === null) continue

    const remaining = cleanupLockRemainingSeconds(current.record, nowMs)
    if (remaining !== null) {
      throw new BucketCleanupBusyError(spec.kind, remaining)
    }

    // 过期锁（或写坏的锁行）：CAS 接管，只有库里仍是我们读到的那个原值时才算赢。
    if (
      await takeoverCleanupLock(env.DB, prefix, spec.kind, current.value, value)
    ) {
      return value
    }
    const winner = await readCleanupLock(env.DB, prefix, spec.kind)
    throw new BucketCleanupBusyError(
      spec.kind,
      cleanupLockRemainingSeconds(winner?.record ?? null, nowMs) ?? 1
    )
  }
  throw new BucketCleanupBusyError(spec.kind, 1)
}

/** 释放锁：失败只记一句日志，绝不顶掉本轮真正的结果或错误。 */
async function releaseCleanupLockQuietly(
  env: Env,
  spec: CleanupKindSpec,
  value: string
): Promise<void> {
  try {
    await releaseCleanupLock(env.DB, getTablePrefix(env), spec.kind, value)
  } catch (err) {
    console.error(
      `${spec.kind} cleanup: failed to release the cleanup lock:`,
      err instanceof Error ? err.message : String(err)
    )
  }
}

/**
 * 跑一轮清理（图片或内容，由 spec 决定）。
 *
 * 并发互斥：不论哪个入口、真跑还是 dry run，都先抢该类清理的锁行；抢不到就抛
 * {@link BucketCleanupBusyError}（不扫、不删、不写日志行）。锁在 `finally` 里释放。
 *
 * 扫描期异常会先落一行 `status: "failed"`（保留已扫到的计数）再抛出：
 * waker 入口让它冒出去好让平台按 executionId 重试，Cron/管理接口各自捕获。
 */
export async function runBucketCleanup(
  env: Env,
  spec: CleanupKindSpec,
  options: RunCleanupOptions
): Promise<BucketCleanupResult> {
  const prefix = getTablePrefix(env)
  const startedAt = new Date()
  const counters = emptyCounters()
  const lockValue = await acquireCleanupLock(
    env,
    spec,
    {
      token: crypto.randomUUID(),
      startedAt: startedAt.toISOString(),
      trigger: options.trigger,
      dryRun: options.dryRun
    },
    startedAt.getTime()
  )

  try {
    if (!options.dryRun && options.rerunGuard === "enforce") {
      const last = await lastSuccessfulCleanupRun(env.DB, prefix, spec.kind)
      if (last !== null) {
        const elapsedMs = startedAt.getTime() - Date.parse(last.started_at)
        const guardMs = CLEANUP_RERUN_GUARD_DAYS * 24 * 60 * 60 * 1000
        if (Number.isFinite(elapsedMs) && elapsedMs < guardMs) {
          // 幂等兜底：距上次真实成功运行不到 20 天，这一轮什么也不做，只留一行日志。
          return withResponseFields(
            await writeRun(env, spec.kind, {
              startedAt,
              trigger: options.trigger,
              status: "skipped",
              dryRun: options.dryRun,
              counters
            }),
            options,
            counters
          )
        }
      }
    }

    const ageCutoff =
      startedAt.getTime() - CLEANUP_MIN_AGE_DAYS * 24 * 60 * 60 * 1000
    const bucket = spec.bucket(env)

    try {
      const referenced = await spec.collectReferenced(env)
      counters.referenced = referenced.size

      let cursor: string | undefined
      do {
        const page = await bucket.list({ limit: LIST_PAGE_SIZE, cursor })
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

          // 可清理数与总大小：在单轮上限**之前**累加，故 dry run 报的是全量，
          // `deleted` 仍按上限计数（两者的差就是「还要再跑几轮」）。
          counters.prunable += 1
          counters.prunableBytes += Number.isFinite(object.size)
            ? object.size
            : 0

          if (counters.truncated || counters.deleted >= DELETE_LIMIT_PER_RUN) {
            counters.truncated = true
            continue
          }
          if (options.dryRun) {
            counters.deleted += 1
            continue
          }
          try {
            await bucket.delete(object.key)
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
        await writeRun(env, spec.kind, {
          startedAt,
          trigger: options.trigger,
          status: "failed",
          dryRun: options.dryRun,
          counters
        })
      } catch (logError) {
        // 写日志本身失败（例如迁移还没跑）不能盖掉真正的错误。
        console.error(
          `${spec.kind} cleanup: failed to record the failed run:`,
          logError instanceof Error ? logError.message : String(logError)
        )
      }
      throw err
    }

    return withResponseFields(
      await writeRun(env, spec.kind, {
        startedAt,
        trigger: options.trigger,
        status: "ok",
        dryRun: options.dryRun,
        counters
      }),
      options,
      counters
    )
  } finally {
    await releaseCleanupLockQuietly(env, spec, lockValue)
  }
}
