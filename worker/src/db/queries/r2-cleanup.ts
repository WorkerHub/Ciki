/**
 * 月度 R2 孤儿清理（规格 §3）用到的查询：
 *   - 引用集扫描：头像 key、页面正文（当前版本 + 历史版本）；
 *   - 运行日志：`{prefix}r2_cleanup_runs` 的写入与「最近一轮」读取；
 *   - 并发互斥：`{prefix}system_settings` 里的清理锁行（见下方清理锁说明）。
 *
 * 正文一律 keyset 分页（`id > ?`）并先用 `instr` 预筛：单页正文上限 2MB，
 * 一次把整张表读进 Worker 内存会顶到 isolate 的内存上限。
 */
import {
  pagesTable,
  r2CleanupRunsTable,
  revisionsTable,
  settingsTable,
  usersTable
} from "../../lib/tables"

/** 一轮运行的触发来源：两个自动入口 + 管理员手工验收。 */
export type CleanupTrigger = "cron" | "waker" | "manual"
/** `ok` = 跑完；`skipped` = 20 天幂等兜底命中；`failed` = 扫描期异常。 */
export type CleanupStatus = "ok" | "skipped" | "failed"

export interface CleanupRunRow {
  id: string
  started_at: string
  finished_at: string
  trigger: CleanupTrigger
  status: CleanupStatus
  dry_run: number
  scanned: number
  referenced: number
  deleted: number
  young_skipped: number
  failed: number
  truncated: number
}

/** 正文里出现图片引用的页面/版本行；`LIMIT` 由调用方给定。 */
export interface BodyRow {
  id: string
  content_json: string
  content_html: string
  /** 历史版本的新形态：gzip 的 `content_json`（页面行没有这一列）。 */
  content_gzip?: ArrayBuffer | ArrayBufferView | null
}

/** 每批正文行数：单行正文上限 2MB，5 行一批远低于 isolate 的内存上限。 */
export const BODY_BATCH_SIZE = 5
/**
 * 历史版本每批行数：gzip 化以后单行只有正文的 0.2–0.3 倍，可以多读几行；
 * 10 行即使碰上尚未转换的 2MB 旧行（20MB）也仍在 isolate 内存范围内。
 */
export const REVISION_BATCH_SIZE = 10

/** 正文里含 `/api/files/` 的过滤条件（`instr` 不做 LIKE 通配符转义）。 */
const HAS_FILE_REF = `(instr(content_json, '/api/files/') > 0
   OR instr(content_html, '/api/files/') > 0)`

/** 全部用户的头像 key（空串 = 无头像，不入集）。 */
export async function listAvatarKeys(
  db: D1Database,
  prefix: string
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT avatar_key FROM ${usersTable(prefix)} WHERE avatar_key <> ''`
    )
    .all<{ avatar_key: string }>()
  return rows.results.map((row) => row.avatar_key)
}

/**
 * 所有页面正文（含回收站页面：`deleted_at` 非空的行仍在表里，图一律保留）。
 * 按 `id` keyset 分页，`afterId` 传空串取第一页。
 */
export async function listPageBodiesBatch(
  db: D1Database,
  prefix: string,
  afterId: string
): Promise<BodyRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, content_json, content_html
         FROM ${pagesTable(prefix)}
        WHERE id > ? AND ${HAS_FILE_REF}
        ORDER BY id
        LIMIT ?`
    )
    .bind(afterId, BODY_BATCH_SIZE)
    .all<BodyRow>()
  return rows.results
}

/**
 * 所有历史版本正文（`page_revisions`），分页口径同上。
 *
 * 版本行有两种形态，过滤条件跟着走：
 * - 已 gzip 化（`content_gzip` 列存在）：压缩字节没法用 SQL 字符串函数预筛，只能把
 *   版本行全取出来、解压后再扫（见 core/r2-cleanup.ts）；同时保留旧形态的 `instr`
 *   预筛，升级前写入、尚未转换的行照样扫得到。
 * - 升级前的库（列不存在）：语意与改前完全一致，先用 `instr` 预筛。
 *
 * 列不一定存在，所以 SQL 只能按情况拼：引用不存在的列会让整轮扫描报错。
 */
export async function listRevisionBodiesBatch(
  db: D1Database,
  prefix: string,
  afterId: string,
  gzipReady: boolean
): Promise<BodyRow[]> {
  const select = gzipReady
    ? "id, content_json, content_html, content_gzip"
    : "id, content_json, content_html"
  const filter = gzipReady
    ? `content_gzip IS NOT NULL OR ${HAS_FILE_REF}`
    : `${HAS_FILE_REF}`
  const rows = await db
    .prepare(
      `SELECT ${select}
         FROM ${revisionsTable(prefix)}
        WHERE id > ? AND (${filter})
        ORDER BY id
        LIMIT ?`
    )
    .bind(afterId, REVISION_BATCH_SIZE)
    .all<BodyRow>()
  return rows.results
}

export async function insertCleanupRun(
  db: D1Database,
  prefix: string,
  run: CleanupRunRow
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ${r2CleanupRunsTable(prefix)}
        (id, started_at, finished_at, trigger, status, dry_run,
         scanned, referenced, deleted, young_skipped, failed, truncated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      run.id,
      run.started_at,
      run.finished_at,
      run.trigger,
      run.status,
      run.dry_run,
      run.scanned,
      run.referenced,
      run.deleted,
      run.young_skipped,
      run.failed,
      run.truncated
    )
    .run()
}

/**
 * 清理互斥锁的键名与读写（全程只有三句 SQL，语义在 core/r2-cleanup.ts）。
 *
 * 为什么落在 `system_settings` 而不是 `r2_cleanup_runs`：日志表是「每轮一行」的
 * 语义，塞一行锁记录会逼着 `lastSuccessfulCleanupRun` 与 `lastCleanupRun` 这两条
 * 口径查询都加过滤；KV 表则让「最近一轮」摘要与 20 天幂等闸一行不改。
 *
 * 抢占全凭 `meta.changes`：插入语句成功（= 原本没有锁行）即抢到；读到过期锁时
 * 用 CAS 改写（`WHERE value = <读到的原值>`，并发接管只有一个赢）；释放按原值比对，
 * 只删自己那行——被别人接管后就不会误删别人的锁。
 */
export const CLEANUP_LOCK_KEY = "r2_cleanup_lock"

/** 锁行 `value` 的形状（JSON 序列化后落库）。 */
export interface CleanupLockRecord {
  /** 本轮持有者的随机令牌（仅用于日志与排障）。 */
  token: string
  /** 持锁那一轮的开始时刻：TTL 从这里算，过期即可被接管。 */
  startedAt: string
  trigger: CleanupTrigger
  dryRun: boolean
}

/** 读回的锁行：`value` 是原样字符串（CAS / 释放都按它比对）。 */
export interface CleanupLockRow {
  value: string
  /** 解析结果；写坏了为 `null`（调用方按「已过期」处理）。 */
  record: CleanupLockRecord | null
}

/** 读锁行；没有锁行返回 `null`。 */
export async function readCleanupLock(
  db: D1Database,
  prefix: string
): Promise<CleanupLockRow | null> {
  const row = await db
    .prepare(`SELECT value FROM ${settingsTable(prefix)} WHERE key = ?`)
    .bind(CLEANUP_LOCK_KEY)
    .first<{ value: string }>()
  if (row === null) return null
  let record: CleanupLockRecord | null = null
  try {
    record = JSON.parse(row.value) as CleanupLockRecord
  } catch {
    record = null
  }
  return { value: row.value, record }
}

/** 插入锁行：原本没有锁行时 `meta.changes === 1`（= 抢到）。 */
export async function insertCleanupLock(
  db: D1Database,
  prefix: string,
  value: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO ${settingsTable(prefix)} (key, value, updated_at)
       VALUES (?, ?, ?)`
    )
    .bind(CLEANUP_LOCK_KEY, value, new Date().toISOString())
    .run()
  return result.meta.changes === 1
}

/**
 * 接管过期锁：只有库里那行仍是 `previousValue` 时才改写成功。
 * 两个 Worker 同时发现锁过期时，只有一个的 `UPDATE` 会命中（`meta.changes === 1`）。
 */
export async function takeoverCleanupLock(
  db: D1Database,
  prefix: string,
  previousValue: string,
  nextValue: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE ${settingsTable(prefix)} SET value = ?, updated_at = ?
        WHERE key = ? AND value = ?`
    )
    .bind(nextValue, new Date().toISOString(), CLEANUP_LOCK_KEY, previousValue)
    .run()
  return result.meta.changes === 1
}

/** 释放自己那把锁：`value` 已被别人改写就什么也不删。 */
export async function releaseCleanupLock(
  db: D1Database,
  prefix: string,
  value: string
): Promise<void> {
  await db
    .prepare(`DELETE FROM ${settingsTable(prefix)} WHERE key = ? AND value = ?`)
    .bind(CLEANUP_LOCK_KEY, value)
    .run()
}

/**
 * 上一次**真实成功**的运行（20 天幂等兜底的判定依据）。
 * dry_run 不删任何东西，不算「成功运行」。
 */
export async function lastSuccessfulCleanupRun(
  db: D1Database,
  prefix: string
): Promise<CleanupRunRow | null> {
  return db
    .prepare(
      `SELECT * FROM ${r2CleanupRunsTable(prefix)}
        WHERE status = 'ok' AND dry_run = 0
        ORDER BY started_at DESC, rowid DESC
        LIMIT 1`
    )
    .first<CleanupRunRow>()
}

/**
 * 「最近一轮」——管理面那一行摘要的数据源：最近一条真实（非 dry_run）运行，
 * 跳过兜底命中的 skipped 行（那轮什么也没做，不代表清理结果）。
 */
export async function lastCleanupRun(
  db: D1Database,
  prefix: string
): Promise<CleanupRunRow | null> {
  return db
    .prepare(
      `SELECT * FROM ${r2CleanupRunsTable(prefix)}
        WHERE dry_run = 0 AND status <> 'skipped'
        ORDER BY started_at DESC, rowid DESC
        LIMIT 1`
    )
    .first<CleanupRunRow>()
}
