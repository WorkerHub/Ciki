/**
 * 月度 R2 桶治理用到的查询：图片桶与内容桶共用同一套表（`r2_cleanup_runs` 用
 * `kind` 区分），锁行同表、按 kind 分键。
 *
 *   - 引用集扫描：头像 key、页面与版本正文（图片用）、内容哈希（内容 GC 用）；
 *   - 运行日志：`{prefix}r2_cleanup_runs` 的写入与「最近一轮」读取；
 *   - 并发互斥：`{prefix}system_settings` 里的清理锁行。
 *
 * 正文一律分页读（单页正文上限 2MB，一次把整张表读进 Worker 内存会顶到内存上限）。
 */
import {
  pagesTable,
  r2CleanupRunsTable,
  revisionsTable,
  settingsTable,
  usersTable
} from "../../lib/tables"

/** 一类清理：图片桶（头像/页面图）与内容桶（正文对象）。 */
export type CleanupKind = "images" | "content"
/** 一轮运行的触发来源：两个自动入口 + 管理员手工验收。 */
export type CleanupTrigger = "cron" | "waker" | "manual"
/** `ok` = 跑完；`skipped` = 20 天幂等兜底命中；`failed` = 扫描期异常。 */
export type CleanupStatus = "ok" | "skipped" | "failed"

export interface CleanupRunRow {
  id: number
  kind: CleanupKind
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

/** 页面正文行（图片引用扫描用）。 */
export interface PageBodyRow {
  id: number
  content_html: string
  content_md: string
}

/** 每批正文行数：单行正文上限 2MB，5 行一批远低于 isolate 的内存上限。 */
export const BODY_BATCH_SIZE = 5

/** 内容对象总数上限：超过它就先中止图片扫描（fail closed，不删任何对象）。 */
export const MAX_IMAGE_SCAN_OBJECTS = 800

/** 正文里含 `/api/files/` 的过滤条件（`instr` 不做 LIKE 通配符转义）。 */
const HAS_FILE_REF = `(instr(content_html, '/api/files/') > 0
   OR instr(content_md, '/api/files/') > 0)`

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
 * 页面正文里含图片引用的行（含回收站页面：`deleted_at` 非空的行仍在表里，图一律保留）。
 *
 * 正文 JSON 已不在 D1，但 HTML 与 MD 都是它的派生件——图片引用一定出现在这两列里，
 * 所以图片 GC 不必去读内容桶。按整数 id keyset 分页。
 */
export async function listPageImageBodiesBatch(
  db: D1Database,
  prefix: string,
  afterId: number
): Promise<PageBodyRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, content_html, content_md
         FROM ${pagesTable(prefix)}
        WHERE id > ? AND ${HAS_FILE_REF}
        ORDER BY id
        LIMIT ?`
    )
    .bind(afterId, BODY_BATCH_SIZE)
    .all<PageBodyRow>()
  return rows.results
}

/**
 * 全部历史版本引用到的不重复内容哈希。
 *
 * 版本正文只在内容桶里，图片引用只能解压后扫；先按哈希去重，避免同一份内容被反复
 * 读取。数量超过 {@link MAX_IMAGE_SCAN_OBJECTS} 时由调用方中止本轮（fail closed）。
 */
export async function listDistinctRevisionHashes(
  db: D1Database,
  prefix: string
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT content_hash FROM ${revisionsTable(prefix)} ORDER BY content_hash`
    )
    .all<{ content_hash: string }>()
  return rows.results.map((row) => row.content_hash)
}

/**
 * 内容 GC 的引用集：页面当前正文 ∪ 全部历史版本（含回收站页面与其版本）。
 * 返回去重后的哈希列表。
 */
export async function listReferencedContentHashes(
  db: D1Database,
  prefix: string
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT content_hash FROM ${pagesTable(prefix)}
        UNION
       SELECT content_hash FROM ${revisionsTable(prefix)}`
    )
    .all<{ content_hash: string }>()
  return rows.results.map((row) => row.content_hash)
}

export async function insertCleanupRun(
  db: D1Database,
  prefix: string,
  run: Omit<CleanupRunRow, "id">
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO ${r2CleanupRunsTable(prefix)}
        (kind, started_at, finished_at, trigger, status, dry_run,
         scanned, referenced, deleted, young_skipped, failed, truncated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      run.kind,
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
  return result.meta.last_row_id
}

/**
 * 清理互斥锁的键名与读写（全程只有三句 SQL，语义在 core/bucket-cleanup.ts）。
 *
 * 为什么落在 `system_settings` 而不是 `r2_cleanup_runs`：日志表是「每轮一行」的
 * 语义，塞一行锁记录会逼着「最近一轮」与 20 天幂等闸这两条口径查询都加过滤。
 * 图片与内容各占一行（键名带 kind），两类清理互不阻塞。
 */
export const CLEANUP_LOCK_KEY = "r2_cleanup_lock"

function lockKey(kind: CleanupKind): string {
  return `${CLEANUP_LOCK_KEY}:${kind}`
}

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
  prefix: string,
  kind: CleanupKind
): Promise<CleanupLockRow | null> {
  const row = await db
    .prepare(`SELECT value FROM ${settingsTable(prefix)} WHERE key = ?`)
    .bind(lockKey(kind))
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
  kind: CleanupKind,
  value: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO ${settingsTable(prefix)} (key, value, updated_at)
       VALUES (?, ?, ?)`
    )
    .bind(lockKey(kind), value, new Date().toISOString())
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
  kind: CleanupKind,
  previousValue: string,
  nextValue: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE ${settingsTable(prefix)} SET value = ?, updated_at = ?
        WHERE key = ? AND value = ?`
    )
    .bind(nextValue, new Date().toISOString(), lockKey(kind), previousValue)
    .run()
  return result.meta.changes === 1
}

/** 释放自己那把锁：`value` 已被别人改写就什么也不删。 */
export async function releaseCleanupLock(
  db: D1Database,
  prefix: string,
  kind: CleanupKind,
  value: string
): Promise<void> {
  await db
    .prepare(`DELETE FROM ${settingsTable(prefix)} WHERE key = ? AND value = ?`)
    .bind(lockKey(kind), value)
    .run()
}

/**
 * 上一次**真实成功**的运行（20 天幂等兜底的判定依据）。
 * dry_run 不删任何东西，不算「成功运行」。
 */
export async function lastSuccessfulCleanupRun(
  db: D1Database,
  prefix: string,
  kind: CleanupKind
): Promise<CleanupRunRow | null> {
  return db
    .prepare(
      `SELECT * FROM ${r2CleanupRunsTable(prefix)}
        WHERE kind = ? AND status = 'ok' AND dry_run = 0
        ORDER BY started_at DESC, id DESC
        LIMIT 1`
    )
    .bind(kind)
    .first<CleanupRunRow>()
}

/**
 * 「最近一轮」——管理面那一行摘要的数据源：最近一条真实（非 dry_run）运行，
 * 跳过兜底命中的 skipped 行（那轮什么也没做，不代表清理结果）。
 */
export async function lastCleanupRun(
  db: D1Database,
  prefix: string,
  kind: CleanupKind
): Promise<CleanupRunRow | null> {
  return db
    .prepare(
      `SELECT * FROM ${r2CleanupRunsTable(prefix)}
        WHERE kind = ? AND dry_run = 0 AND status <> 'skipped'
        ORDER BY started_at DESC, id DESC
        LIMIT 1`
    )
    .bind(kind)
    .first<CleanupRunRow>()
}
