/**
 * 限流 / 登录失败锁定的唯一权威（规格补遗：D1 计数表，按动作+账号+IP 原子自增）。
 *
 * key = `<action>:<account>:<ip>`；单条 UPSERT 一次完成“窗口判断 + 自增”，
 * 并发请求不会丢计数。setup 限流在数据库初始化前就要生效，因此这里也负责用
 * 共享 DDL 先建表（不依赖迁移是否跑过）。
 */
import {
  AUTH_COUNTERS_INDEX_DDL,
  AUTH_COUNTERS_TABLE_DDL
} from "../lib/migrations"
import { countersTable } from "../lib/tables"

export interface CounterKey {
  action: string
  account?: string
  ip?: string
}

function keyOf({ action, account = "", ip = "" }: CounterKey) {
  return `${action}:${account}:${ip}`
}

/** 建计数表（幂等）；迁移前也能用。 */
export async function ensureCountersTable(
  db: D1Database,
  prefix: string
): Promise<void> {
  const sql =
    `${AUTH_COUNTERS_TABLE_DDL};\n${AUTH_COUNTERS_INDEX_DDL}`.replaceAll(
      "{prefix}",
      prefix
    )
  for (const statement of sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await db.prepare(statement).run()
  }
}

export interface CounterState {
  count: number
  windowStart: number
  lockedUntil: number | null
}

/**
 * 消费一次额度：返回自增后的计数与锁定时间。
 * 窗口过期（window_start <= now - windowSeconds）时重新从 1 计。
 */
export async function consumeCounter(
  db: D1Database,
  prefix: string,
  key: CounterKey & { windowSeconds: number }
): Promise<CounterState> {
  const table = countersTable(prefix)
  const now = Math.floor(Date.now() / 1000)
  const threshold = now - key.windowSeconds
  const composite = keyOf(key)
  await db
    .prepare(
      `INSERT INTO ${table} (key, action, account, ip, count, window_start, locked_until, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END,
         updated_at = excluded.updated_at`
    )
    .bind(
      composite,
      key.action,
      key.account ?? "",
      key.ip ?? "",
      now,
      now,
      threshold,
      threshold,
      now
    )
    .run()

  const row = await db
    .prepare(
      `SELECT count, window_start AS windowStart, locked_until AS lockedUntil
         FROM ${table} WHERE key = ?`
    )
    .bind(composite)
    .first<CounterState>()
  return row ?? { count: 1, windowStart: now, lockedUntil: null }
}

/** 只读窗口内计数（窗口过期视为 0）：用于「先拒后验」的限流。 */
export async function readCounterWindow(
  db: D1Database,
  prefix: string,
  key: CounterKey,
  windowSeconds: number
): Promise<{ count: number; retryAfter: number }> {
  const row = await db
    .prepare(
      `SELECT count, window_start AS windowStart FROM ${countersTable(prefix)} WHERE key = ?`
    )
    .bind(keyOf(key))
    .first<{ count: number; windowStart: number }>()
  const now = Math.floor(Date.now() / 1000)
  if (!row || row.windowStart <= now - windowSeconds) {
    return { count: 0, retryAfter: 0 }
  }
  return {
    count: row.count,
    retryAfter: Math.max(1, row.windowStart + windowSeconds - now)
  }
}

/** 精确重置一个计数键（鉴权成功后清掉该 IP 的失败计数）。 */
export async function resetCounter(
  db: D1Database,
  prefix: string,
  key: CounterKey
): Promise<void> {
  await db
    .prepare(`DELETE FROM ${countersTable(prefix)} WHERE key = ?`)
    .bind(keyOf(key))
    .run()
}

/** 未过期的锁定时间（Unix 秒）；未锁定返回 null。 */
export async function lockedUntil(
  db: D1Database,
  prefix: string,
  key: CounterKey
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT locked_until AS lockedUntil FROM ${countersTable(prefix)} WHERE key = ?`
    )
    .bind(keyOf(key))
    .first<{ lockedUntil: number | null }>()
  const until = row?.lockedUntil ?? null
  if (!until) return null
  return until > Math.floor(Date.now() / 1000) ? until : null
}

/** 给某个计数键上锁。 */
export async function setLock(
  db: D1Database,
  prefix: string,
  key: CounterKey,
  until: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await db
    .prepare(
      `INSERT INTO ${countersTable(prefix)}
        (key, action, account, ip, count, window_start, locked_until, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET locked_until = excluded.locked_until, updated_at = excluded.updated_at`
    )
    .bind(
      keyOf(key),
      key.action,
      key.account ?? "",
      key.ip ?? "",
      now,
      until,
      now
    )
    .run()
}

/** 登录成功：清掉该账号在全部 IP 上的失败与锁定行。 */
export async function clearAccountCounters(
  db: D1Database,
  prefix: string,
  action: string,
  account: string
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM ${countersTable(prefix)} WHERE action = ? AND account = ?`
    )
    .bind(action, account)
    .run()
}
