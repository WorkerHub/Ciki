/**
 * 「每页保留历史版本数」的设置口径与两处修剪（规格「保留数设置」）。
 *
 * 口径（全站唯一）：
 * - 存储：`system_settings.revision_retention_limit`；值是十进制正整数（≥1）。
 * - **空串 / 缺行 = 不限**（=`null`）。`0` 只是写入时的宽容输入（老客户端可能这么表示），
 *   落库一律归一化成空串，读出来永远是 `null`，不存在「一个是 0 一个是不限」的歧义。
 * - 下限 1：最新一条版本是当前内容的快照，`keep` 不接受 0。
 *
 * 三处修剪共用同一套语句（db/queries/revisions.ts），彼此口径一致：
 * - 写入路径：`savePageContent` 在**插入新版本同一个事务里**修剪该页（懒修剪）；
 * - 手动全站修剪：`pruneAllPages`，一条 set-based DELETE；
 * - 按页只留最新一条：见 routes/pages.ts 的 `/revisions/prune`。
 */
import {
  countPrunableRevisions,
  countRevisions,
  pruneRevisionsStatement
} from "../db/queries/revisions"
import { getSetting, setSetting } from "../db/queries/settings"
import { getTablePrefix } from "../lib/table-prefix"
import type { Env } from "../types"

/** `system_settings` 里的键名（与既有设置同一张表、同一套 key 风格）。 */
export const REVISION_RETENTION_KEY = "revision_retention_limit"

export interface RevisionRetentionPreview {
  /** null = 不限。 */
  limit: number | null
  totalRevisions: number
  /** 按当前设置点一次「修剪全部页面」会删掉的条数。 */
  prunableRevisions: number
}

/** 设置的原始值 → 保留数；空串 / 0 / 非法值一律按「不限」处理。 */
export function parseRetentionLimit(raw: string | null): number | null {
  if (raw === null) return null
  const trimmed = raw.trim()
  if (trimmed === "") return null
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value < 1) return null
  return value
}

/** 读取当前生效的保留数（每次写入读一次，不做 isolate 缓存）。 */
export async function readRetentionLimit(
  db: D1Database,
  prefix: string
): Promise<number | null> {
  return parseRetentionLimit(
    await getSetting(db, prefix, REVISION_RETENTION_KEY)
  )
}

export type RetentionInputResult =
  | { ok: true; limit: number | null }
  | { ok: false }

/** 管理接口入参 → 保留数：正整数、`null` / `0` / 空串（= 不限），其余非法。 */
export function normalizeRetentionInput(value: unknown): RetentionInputResult {
  if (value === null) return { ok: true, limit: null }
  if (typeof value === "string") {
    if (value.trim() === "") return { ok: true, limit: null }
    if (!/^\d+$/.test(value.trim())) return { ok: false }
    const parsed = Number(value.trim())
    return Number.isSafeInteger(parsed) && parsed >= 1
      ? { ok: true, limit: parsed }
      : parsed === 0
        ? { ok: true, limit: null }
        : { ok: false }
  }
  if (typeof value !== "number" || !Number.isInteger(value))
    return { ok: false }
  if (value === 0) return { ok: true, limit: null }
  if (value < 0) return { ok: false }
  return { ok: true, limit: value }
}

/** 写设置：不限落空串（而不是删行），便于管理面回显。 */
export async function writeRetentionLimit(
  db: D1Database,
  prefix: string,
  limit: number | null
): Promise<void> {
  await setSetting(
    db,
    prefix,
    REVISION_RETENTION_KEY,
    limit === null ? "" : String(limit)
  )
}

/** 全站修剪的预告（只读）：当前设置 + 版本总数 + 将被删条数。 */
export async function revisionRetentionPreview(
  db: D1Database,
  prefix: string
): Promise<RevisionRetentionPreview> {
  const limit = await readRetentionLimit(db, prefix)
  const totalRevisions = await countRevisions(db, prefix)
  const prunableRevisions =
    limit === null ? 0 : await countPrunableRevisions(db, prefix, limit)
  return { limit, totalRevisions, prunableRevisions }
}

/**
 * 按给定保留数修剪全部页面，返回实际删除条数。
 *
 * 一条 DELETE 完成（原子、一次往返），所以 `deleted` 就是真删数——调用方拿它与预告数
 * 对比即可。复用回收站页面的版本行同样修剪（版本行还在表里，规格要「所有页收敛」）；
 * 只删 `page_revisions`，不碰 `pages` 当前内容、FTS、R2 对象。
 */
export async function pruneAllPages(env: Env, limit: number): Promise<number> {
  const prefix = getTablePrefix(env)
  const result = await pruneRevisionsStatement(env.DB, prefix, limit).run()
  return result.meta.changes
}
