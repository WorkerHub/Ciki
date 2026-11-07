/**
 * 一次性挑战（D1 行，5 分钟过期，消费即删）。
 *
 * key 一律是哈希：cookie/临时令牌类用 `SHA-256(令牌)`，用户维度类用
 * `SHA-256("<purpose>:<uid>")`，库里不出现可用于重放的原文。
 */
import { challengesTable } from "../lib/tables"
import { sha256Hex } from "./auth"

export type ChallengePurpose =
  | "2fa_login"
  | "totp_setup"
  | "passkey_register"
  | "passkey_auth"
  | "totp_used"

export const CHALLENGE_TTL_SECONDS = 300
export const TOTP_REPLAY_TTL_SECONDS = 90

export interface Challenge {
  key: string
  userId: string
  purpose: string
  payload: string
}

export async function challengeKeyForToken(token: string): Promise<string> {
  return sha256Hex(token)
}

export async function challengeKeyForUser(
  purpose: string,
  userId: string
): Promise<string> {
  return sha256Hex(`${purpose}:${userId}`)
}

async function cleanupExpired(db: D1Database, prefix: string): Promise<void> {
  await db
    .prepare(`DELETE FROM ${challengesTable(prefix)} WHERE expires_at < ?`)
    .bind(Math.floor(Date.now() / 1000))
    .run()
}

export async function putChallenge(
  db: D1Database,
  prefix: string,
  challenge: Challenge & { ttlSeconds?: number }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await cleanupExpired(db, prefix)
  await db
    .prepare(
      `INSERT INTO ${challengesTable(prefix)} (key, user_id, purpose, payload, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         user_id = excluded.user_id,
         purpose = excluded.purpose,
         payload = excluded.payload,
         expires_at = excluded.expires_at,
         created_at = excluded.created_at`
    )
    .bind(
      challenge.key,
      challenge.userId,
      challenge.purpose,
      challenge.payload,
      now + (challenge.ttlSeconds ?? CHALLENGE_TTL_SECONDS),
      now
    )
    .run()
}

/** 读取未过期的挑战；不存在/已过期返回 null。 */
export async function readChallenge(
  db: D1Database,
  prefix: string,
  key: string
): Promise<Challenge | null> {
  const row = await db
    .prepare(
      `SELECT key, user_id AS userId, purpose, payload
         FROM ${challengesTable(prefix)}
        WHERE key = ? AND expires_at > ?`
    )
    .bind(key, Math.floor(Date.now() / 1000))
    .first<Challenge>()
  return row ?? null
}

/**
 * 读取并删除（消费）。先读再删、以 `meta.changes` 判定是否由本次请求消费，
 * 重复消费并发时只有一方拿到 `changes=1`。
 */
export async function consumeChallenge(
  db: D1Database,
  prefix: string,
  key: string
): Promise<Challenge | null> {
  const now = Math.floor(Date.now() / 1000)
  const challenge = await readChallenge(db, prefix, key)
  if (!challenge) return null
  const result = await db
    .prepare(
      `DELETE FROM ${challengesTable(prefix)} WHERE key = ? AND expires_at > ?`
    )
    .bind(key, now)
    .run()
  return result.meta.changes === 1 ? challenge : null
}

/**
 * 标记一次性值已使用（TOTP 防重放）：插入成功才算首次使用。
 * 已存在返回 false，调用方按重放拒绝。
 */
export async function markChallengeUsed(
  db: D1Database,
  prefix: string,
  challenge: Challenge & { ttlSeconds?: number }
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  await cleanupExpired(db, prefix)
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO ${challengesTable(prefix)}
        (key, user_id, purpose, payload, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      challenge.key,
      challenge.userId,
      challenge.purpose,
      challenge.payload,
      now + (challenge.ttlSeconds ?? TOTP_REPLAY_TTL_SECONDS),
      now
    )
    .run()
  return result.meta.changes === 1
}

export async function deleteChallenge(
  db: D1Database,
  prefix: string,
  key: string
): Promise<void> {
  await db
    .prepare(`DELETE FROM ${challengesTable(prefix)} WHERE key = ?`)
    .bind(key)
    .run()
}
