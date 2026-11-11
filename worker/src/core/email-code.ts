/**
 * 邮箱验证码的领域逻辑（#48 契约第 1/4 条）：生成、哈希、下发、校验与限频。
 *
 * 三个用途固定为 `password_reset` / `2fa_login` / `2fa_enable`；验证码是 6 位
 * 数字（`crypto.getRandomValues`，100000–999999）、10 分钟有效、单次消费。
 * 库内只存 `SHA-256("<purpose>:<userId>:<code>")`，与 `session.ts` 同一 SHA-256
 * 原语；不含明文码。
 *
 * 限频一律复用 `core/counters.ts`（D1 计数表），不新建限流机制：
 * | action                | account                  | 窗口  | 上限 |
 * | --------------------- | ------------------------ | ----- | ---- |
 * | email_code_cd         | `${purpose}:${account}`  | 60s   | 1    |
 * | email_code_send       | `${purpose}:${account}`  | 3600s | 5    |
 * | email_code_send_ip    | 空（按 IP）              | 3600s | 20   |
 * | email_code_verify     | `${purpose}:${account}`  | 600s  | 5    |
 * | email_code_verify_ip  | 空（按 IP）              | 600s  | 20   |
 *
 * 另一个 action 属于找回密码的设密端点（POST /api/auth/password/reset）：
 * | password_reset_submit | 有效 token 的 userId（无效时为空） | 300s | 5 |
 *
 * `account` 由调用方给：找回密码用**小写 trim 后的邮箱**（未知邮箱也计数，防枚举），
 * 2FA 用 userId。发码顺序固定 cd → send → send_ip，全部通过才写码/发信。
 */

import {
  deleteEmailCodeIfMatches,
  type EmailCodePurpose,
  getEmailCode,
  incrementEmailCodeAttempts,
  putEmailCode
} from "../db/queries/email-codes"
import { safeEqual, sha256Hex } from "./auth"
import { consumeCounter, resetCounter } from "./counters"

export type { EmailCodePurpose }

export const EMAIL_CODE_TTL_SECONDS = 600
export const EMAIL_CODE_MAX_ATTEMPTS = 5

export const EMAIL_CODE_COOLDOWN_SECONDS = 60
export const EMAIL_CODE_SEND_WINDOW_SECONDS = 3600
export const EMAIL_CODE_SEND_LIMIT = 5
export const EMAIL_CODE_SEND_IP_LIMIT = 20
export const EMAIL_CODE_VERIFY_WINDOW_SECONDS = 600
export const EMAIL_CODE_VERIFY_LIMIT = 5
export const EMAIL_CODE_VERIFY_IP_LIMIT = 20

export const PASSWORD_RESET_SUBMIT_WINDOW_SECONDS = 300
export const PASSWORD_RESET_SUBMIT_LIMIT = 5

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** 6 位数字验证码（100000–999999，无前导零；拒绝采样避免取模偏好）。 */
export function generateEmailCode(): string {
  const buffer = new Uint32Array(1)
  const range = 900_000
  const limit = Math.floor(0x1_0000_0000 / range) * range
  let value = 0
  do {
    crypto.getRandomValues(buffer)
    value = buffer[0]
  } while (value >= limit)
  return String(100_000 + (value % range))
}

/** `code_hash = SHA-256("<purpose>:<userId>:<code>")`（64 位 hex）。 */
export function hashEmailCode(
  purpose: EmailCodePurpose,
  userId: number,
  code: string
): Promise<string> {
  return sha256Hex(`${purpose}:${userId}:${code}`)
}

/** 登录第二步的 binding：`SHA-256(tempToken)`。 */
export function bindingForTempToken(tempToken: string): Promise<string> {
  return sha256Hex(tempToken)
}

export interface IssuedEmailCode {
  code: string
  expiresAt: number
}

/**
 * 生成并写入一枚验证码（覆盖同键旧码、顺带清过期行）。
 * 限频与「是否真的发信」由调用方在此之前决定——本函数不做限频。
 */
export async function issueEmailCode(
  db: D1Database,
  prefix: string,
  options: {
    userId: number
    purpose: EmailCodePurpose
    binding?: string
  }
): Promise<IssuedEmailCode> {
  const code = generateEmailCode()
  const codeHash = await hashEmailCode(options.purpose, options.userId, code)
  const createdAt = nowSeconds()
  const expiresAt = createdAt + EMAIL_CODE_TTL_SECONDS
  await putEmailCode(db, prefix, {
    userId: options.userId,
    purpose: options.purpose,
    binding: options.binding,
    codeHash,
    createdAt,
    expiresAt
  })
  return { code, expiresAt }
}

/**
 * 校验并消费一枚验证码；返回 true 表示本次请求成功拿到并作废了这枚码。
 *
 * 失败语义（对外统一是不通过，不区分原因）：
 * - 码不存在 / 已过期 / 已消费 / 次数用尽 → false，不写计数；
 * - 哈希不匹配 → `attempts + 1`，第 5 次错误删除该行。
 *
 * 并发重放：只有一条带全部条件的 DELETE 能删到行，第二次必然 false。
 */
export async function verifyEmailCode(
  db: D1Database,
  prefix: string,
  options: {
    userId: number
    purpose: EmailCodePurpose
    binding?: string
    code: string
  }
): Promise<boolean> {
  const key = {
    userId: options.userId,
    purpose: options.purpose,
    binding: options.binding
  }
  const row = await getEmailCode(db, prefix, key)
  if (!row) return false

  const codeHash = await hashEmailCode(
    options.purpose,
    options.userId,
    options.code
  )
  const matches = await safeEqual(row.code_hash, codeHash)
  if (!matches) {
    await incrementEmailCodeAttempts(db, prefix, {
      ...key,
      maxAttempts: EMAIL_CODE_MAX_ATTEMPTS
    })
    return false
  }

  return deleteEmailCodeIfMatches(db, prefix, {
    ...key,
    codeHash,
    now: nowSeconds(),
    maxAttempts: EMAIL_CODE_MAX_ATTEMPTS
  })
}

// ── 限频 ────────────────────────────────────────────────────────────────────

function accountOf(purpose: EmailCodePurpose, accountKey: string): string {
  return `${purpose}:${accountKey}`
}

function retryAfterOf(
  windowStart: number,
  windowSeconds: number,
  now: number
): number {
  return Math.max(1, windowStart + windowSeconds - now)
}

export type EmailCodeSendLimitResult =
  | { allowed: true }
  | {
      allowed: false
      /** cooldown = 60 秒内重复发码；其余两个是小时配额。 */
      scope: "cooldown" | "send" | "send_ip"
      retryAfter: number
    }

/**
 * 发码限流：cd（60 秒 1 次）→ send（账号+用途每小时 5 封）→ send_ip（每 IP
 * 每小时 20 封）。任何一步不通过就停在该步，不写码、不发信。
 *
 * 调用方按用途决定“冷却期内”的表现：2FA 端点回 429；找回密码回 200 但不重发
 * （防枚举），此时看 `scope === "cooldown"`。
 */
export async function consumeEmailCodeSendLimits(
  db: D1Database,
  prefix: string,
  options: {
    purpose: EmailCodePurpose
    accountKey: string
    ip: string
  }
): Promise<EmailCodeSendLimitResult> {
  const now = nowSeconds()
  const account = accountOf(options.purpose, options.accountKey)

  const cooldown = await consumeCounter(db, prefix, {
    action: "email_code_cd",
    account,
    windowSeconds: EMAIL_CODE_COOLDOWN_SECONDS
  })
  if (cooldown.count > 1) {
    return {
      allowed: false,
      scope: "cooldown",
      retryAfter: retryAfterOf(
        cooldown.windowStart,
        EMAIL_CODE_COOLDOWN_SECONDS,
        now
      )
    }
  }

  const perAccount = await consumeCounter(db, prefix, {
    action: "email_code_send",
    account,
    windowSeconds: EMAIL_CODE_SEND_WINDOW_SECONDS
  })
  if (perAccount.count > EMAIL_CODE_SEND_LIMIT) {
    return {
      allowed: false,
      scope: "send",
      retryAfter: retryAfterOf(
        perAccount.windowStart,
        EMAIL_CODE_SEND_WINDOW_SECONDS,
        now
      )
    }
  }

  const perIp = await consumeCounter(db, prefix, {
    action: "email_code_send_ip",
    ip: options.ip,
    windowSeconds: EMAIL_CODE_SEND_WINDOW_SECONDS
  })
  if (perIp.count > EMAIL_CODE_SEND_IP_LIMIT) {
    return {
      allowed: false,
      scope: "send_ip",
      retryAfter: retryAfterOf(
        perIp.windowStart,
        EMAIL_CODE_SEND_WINDOW_SECONDS,
        now
      )
    }
  }

  return { allowed: true }
}

/**
 * 校验限流：账号+用途 5 次 / 10 分钟、每个 IP 20 次 / 10 分钟。
 * 成功校验后调用方要调 `resetEmailCodeVerifyCounter` 清零账号计数（契约要求）。
 */
export async function consumeEmailCodeVerifyLimits(
  db: D1Database,
  prefix: string,
  options: {
    purpose: EmailCodePurpose
    accountKey: string
    ip: string
  }
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const now = nowSeconds()
  const account = accountOf(options.purpose, options.accountKey)

  const perAccount = await consumeCounter(db, prefix, {
    action: "email_code_verify",
    account,
    windowSeconds: EMAIL_CODE_VERIFY_WINDOW_SECONDS
  })
  if (perAccount.count > EMAIL_CODE_VERIFY_LIMIT) {
    return {
      allowed: false,
      retryAfter: retryAfterOf(
        perAccount.windowStart,
        EMAIL_CODE_VERIFY_WINDOW_SECONDS,
        now
      )
    }
  }

  const perIp = await consumeCounter(db, prefix, {
    action: "email_code_verify_ip",
    ip: options.ip,
    windowSeconds: EMAIL_CODE_VERIFY_WINDOW_SECONDS
  })
  if (perIp.count > EMAIL_CODE_VERIFY_IP_LIMIT) {
    return {
      allowed: false,
      retryAfter: retryAfterOf(
        perIp.windowStart,
        EMAIL_CODE_VERIFY_WINDOW_SECONDS,
        now
      )
    }
  }

  return { allowed: true }
}

/** 校验成功后清零该账号+用途的失败计数（不动 IP 计数）。 */
export async function resetEmailCodeVerifyCounter(
  db: D1Database,
  prefix: string,
  options: { purpose: EmailCodePurpose; accountKey: string }
): Promise<void> {
  await resetCounter(db, prefix, {
    action: "email_code_verify",
    account: accountOf(options.purpose, options.accountKey)
  })
}

/**
 * 找回密码“设新密码”提交限流（#48 契约第 1 条的最后一项；`POST /api/auth/password/reset` 调用）。
 *
 * account 能解析出用户时为 userId、否则空串；5 次 / 5 分钟，按 account+IP
 * 组合计数（与契约表一致）。
 */
export async function consumePasswordResetSubmitLimit(
  db: D1Database,
  prefix: string,
  options: { userId: number | null; ip: string }
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const now = nowSeconds()
  const state = await consumeCounter(db, prefix, {
    action: "password_reset_submit",
    account: options.userId === null ? "" : String(options.userId),
    ip: options.ip,
    windowSeconds: PASSWORD_RESET_SUBMIT_WINDOW_SECONDS
  })
  if (state.count > PASSWORD_RESET_SUBMIT_LIMIT) {
    return {
      allowed: false,
      retryAfter: retryAfterOf(
        state.windowStart,
        PASSWORD_RESET_SUBMIT_WINDOW_SECONDS,
        now
      )
    }
  }
  return { allowed: true }
}
