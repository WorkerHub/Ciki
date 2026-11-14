/**
 * 邮箱找回密码的 resetToken 流转（#48 冻结契约的第 2 步 → 第 3 步）。
 *
 * 流程：`password_reset` 验证码校验通过 → 签发一次性 resetToken → 用令牌设新密码。
 * resetToken 复用 `auth_challenges`：key = `SHA-256(令牌)`、purpose = `password_reset`、
 * payload = userId、TTL 600 秒；明文只在 verify 的响应里出现一次，库内只有哈希。
 *
 * 设密成功后的会话口径（用户已确认「维持冻结：仅找回密码全失效」）：
 * 该用户**全部会话**（含发起重置前已登录的）立即失效，不自动登录、不下发 Cookie；
 * 同时删掉该用户全部 `auth_challenges` 与 `email_codes`，避免旧重置凭据与 2FA 挑战残留。
 * 主动改密（/api/me/password）与管理员改密的会话口径不变，只清 password_reset 凭据。
 */
import { deleteUserEmailCodes } from "../db/queries/email-codes"
import {
  challengesTable,
  emailCodesTable,
  sessionsTable,
  usersTable
} from "../lib/tables"
import { parseId } from "../lib/http"
import { randomToken } from "./auth"
import {
  challengeKeyForToken,
  deleteUserChallenges,
  putChallenge,
  readChallenge
} from "./challenges"

/** resetToken 有效期（#48 契约：600 秒，一次性）。 */
export const PASSWORD_RESET_TOKEN_TTL_SECONDS = 600

/**
 * 签发一枚 resetToken，返回明文（只给本次响应）。
 * 同一用户先前的令牌不主动删除——每个令牌都来自一次成功的验证码校验，各自一次性有效；
 * 设密成功时会把该用户全部挑战行清掉。
 */
export async function issuePasswordResetToken(
  db: D1Database,
  prefix: string,
  userId: number
): Promise<string> {
  const token = randomToken()
  await putChallenge(db, prefix, {
    key: await challengeKeyForToken(token),
    userId,
    purpose: "password_reset",
    payload: String(userId),
    ttlSeconds: PASSWORD_RESET_TOKEN_TTL_SECONDS
  })
  return token
}

/**
 * 解析 resetToken → userId。不存在、已过期、用途不符一律 null（调用方不再区分原因）。
 */
export async function readPasswordResetToken(
  db: D1Database,
  prefix: string,
  token: string
): Promise<number | null> {
  if (!token) return null
  const challenge = await readChallenge(
    db,
    prefix,
    await challengeKeyForToken(token)
  )
  if (challenge?.purpose !== "password_reset") return null
  const raw = challenge.payload || String(challenge.userId)
  return parseId(raw)
}

/**
 * 原子设密：消费 resetToken → 写新密码 → 删除该用户全部会话 → 删除该用户
 * 全部 auth_challenges 与 email_codes。返回 true 表示本次请求真正消费了令牌。
 *
 * 一条 `db.batch()` 即一个事务，语义与「并发/重放只能成功一次」的契约一致：
 * - 写密码的 UPDATE 带 `EXISTS(令牌行未过期)` 守卫，所以**没拿到令牌的那一次
 *   不会把密码改成自己的值**（否则第二个请求回 400 却改掉了密码）；
 * - 令牌 DELETE 的 `meta.changes` 是唯一成功判据：并发下只有一条能删到行；
 * - 事务失败整体回滚（含令牌删除），用户可以拿同一枚令牌重试到成功为止。
 *
 * 这里的四条删除/更新必须共享同一个事务，因此直接写 SQL、不走 `sessions` /
 * `challenges` / `email_codes` 的单表 helper（那些 helper 无法拼进一个 batch）。
 */
export async function applyPasswordReset(
  db: D1Database,
  prefix: string,
  options: { token: string; userId: number; passwordHash: string }
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const key = await challengeKeyForToken(options.token)
  const challenges = challengesTable(prefix)
  const results = await db.batch([
    db
      .prepare(
        `UPDATE ${usersTable(prefix)} SET password_hash = ?, updated_at = ?
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM ${challenges}
               WHERE key = ? AND purpose = 'password_reset' AND expires_at > ?
            )`
      )
      .bind(
        options.passwordHash,
        new Date().toISOString(),
        options.userId,
        key,
        now
      ),
    db
      .prepare(
        `DELETE FROM ${challenges}
          WHERE key = ? AND purpose = 'password_reset' AND expires_at > ?`
      )
      .bind(key, now),
    db
      .prepare(`DELETE FROM ${sessionsTable(prefix)} WHERE user_id = ?`)
      .bind(options.userId),
    db
      .prepare(`DELETE FROM ${challenges} WHERE user_id = ?`)
      .bind(options.userId),
    db
      .prepare(`DELETE FROM ${emailCodesTable(prefix)} WHERE user_id = ?`)
      .bind(options.userId)
  ])
  return results[1]?.meta.changes === 1
}

/**
 * 清除该用户未使用的找回密码凭据（`password_reset` 验证码 + resetToken）。
 * 主动改密与管理员改密复用这一份口径；找回密码设密成功则连同其它凭据一起清空。
 */
export async function clearPasswordResetCredentials(
  db: D1Database,
  prefix: string,
  userId: number
): Promise<void> {
  await deleteUserEmailCodes(db, prefix, userId, "password_reset")
  await deleteUserChallenges(db, prefix, userId, "password_reset")
}
