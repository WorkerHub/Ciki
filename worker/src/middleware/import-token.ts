/**
 * 导入接口鉴权：只认 `Authorization: Bearer <import token>`。
 *
 * - **不接受会话 Cookie**（也不看查询参数）：导入令牌与登录态职责分离，
 *   插件侧拿不到 HttpOnly Cookie，也就不存在借 Cookie 发起写操作的 CSRF 面。
 * - 令牌每次回表校验（吊销 / 重置 / 用户停用或未批准立即失效），
 *   哈希口径与 `sessions` 一致（core/import-token.ts）。
 * - 限流沿用 §8 的 auth_counters，不另设体系：
 *   `import_auth_fail` 按 IP 20 次 / 5 分钟（先拒后验，挡住令牌爆破），
 *   `import` 按用户 3000 次 / 5 分钟（挡住异常狂刷，正常导入远达不到）。
 */
import type { Context, Next } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import { clientIp } from "../lib/http"
import {
  consumeCounter,
  readCounterWindow,
  resetCounter
} from "../core/counters"
import { findImportToken, touchImportToken } from "../core/import-token"
import type { HonoEnv } from "../types"

const WINDOW_SECONDS = 300
const MAX_AUTH_FAILURES = 20
const MAX_IMPORT_CALLS = 3000

function unauthorized(c: Context<HonoEnv>) {
  c.header("Cache-Control", "no-store")
  return c.json({ error: "Unauthorized" }, 401)
}

function rateLimited(c: Context<HonoEnv>, retryAfter: number) {
  return c.json(
    {
      error: "Too many requests",
      code: "RATE_LIMITED",
      retryAfter: Math.max(1, Math.ceil(retryAfter))
    },
    429
  )
}

/** 取出 Bearer 令牌；`Bearer` 前缀之外的形式（含 Cookie）一律不认。 */
export function readBearerToken(c: Context<HonoEnv>): string | null {
  const header = c.req.header("authorization")
  if (!header) return null
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim())
  return match ? match[1] : null
}

export async function importTokenMiddleware(c: Context<HonoEnv>, next: Next) {
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const ip = clientIp(c)
  const failKey = { action: "import_auth_fail", ip }

  // 先拒后验：已超出失败额度的 IP 连校验都不做，避免把哈希/回表当成免费算力。
  const failures = await readCounterWindow(db, prefix, failKey, WINDOW_SECONDS)
  if (failures.count >= MAX_AUTH_FAILURES) {
    return rateLimited(c, failures.retryAfter)
  }

  const token = readBearerToken(c)
  const identity = token ? await findImportToken(db, prefix, token) : null
  if (!identity) {
    const state = await consumeCounter(db, prefix, {
      ...failKey,
      windowSeconds: WINDOW_SECONDS
    })
    if (state.count >= MAX_AUTH_FAILURES) {
      return rateLimited(c, WINDOW_SECONDS)
    }
    return unauthorized(c)
  }

  // 成功一次即清掉该 IP 的失败计数：正常用户偶发输错不会累积到锁定。
  await resetCounter(db, prefix, failKey)

  const usage = await consumeCounter(db, prefix, {
    action: "import",
    account: identity.userId,
    windowSeconds: WINDOW_SECONDS
  })
  if (usage.count > MAX_IMPORT_CALLS) {
    return rateLimited(c, WINDOW_SECONDS)
  }

  await touchImportToken(db, prefix, identity.userId)
  c.set("userId", identity.userId)
  c.set("role", identity.role)
  await next()
}
