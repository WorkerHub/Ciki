/**
 * 读接口鉴权：只认 `Authorization: Bearer <接口令牌（read 或 write）>`。
 *
 * - **不接受会话 Cookie**（也不看查询参数）：读接口的调用方是外部连接器，职责与登录态
 *   分离；反过来，令牌也登不上任何会话接口。
 * - **两种 kind 都认**：`api_tokens.kind` 为 `read` 与 `write` 的令牌都能调
 *   `/api/read/*`（二期 §3.1），命中行由 `findApiToken` 判定（core/api-token.ts）；
 *   空间范围与 `last_used_at` 都按**命中的那一行令牌**取，互不影响。
 * - **表隔离**：导入令牌在另一张表（`import_tokens`），所以导入令牌调
 *   `/api/read/*` 一律 401；反过来接口令牌也进不了 `/api/import/*`。互不通用是表与
 *   kind 隔离的结果，不靠前端约定。
 * - 令牌每次回表校验（吊销 / 重置 / 用户停用或未批准立即失效），哈希口径与 `sessions`
 *   一致（core/api-token.ts）。
 * - 限流沿用 §8 的 auth_counters，不另设体系，两种 kind 共用同一套桶：
 *   `read_auth_fail` 按 IP 20 次 / 5 分钟（先拒后验，挡住令牌爆破），
 *   `read` 按用户 3000 次 / 5 分钟（挡住异常狂刷，正常连接器远达不到）。
 *   读写令牌调读接口计入的正是 `read` 桶，不为它单开新桶。
 *
 * 结构与 middleware/import-token.ts 一一对应（规格要求导入令牌一侧原样不动，故不做
 * 抽取）；唯一复用的是已导出的 `readBearerToken`——那只是 Bearer 头的解析口径。
 */
import type { Context, Next } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import { clientIp } from "../lib/http"
import {
  consumeCounter,
  readCounterWindow,
  resetCounter
} from "../core/counters"
import { findApiToken, touchApiToken } from "../core/api-token"
import { getTokenScope } from "../core/token-scope"
import { readBearerToken } from "./import-token"
import type { HonoEnv } from "../types"

const WINDOW_SECONDS = 300
const MAX_AUTH_FAILURES = 20
const MAX_READ_CALLS = 3000

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

/** 当前计数的窗口还剩多少秒（与 readCounterWindow 的口径一致）。 */
function remainingSeconds(windowStart: number): number {
  return Math.max(
    1,
    windowStart + WINDOW_SECONDS - Math.floor(Date.now() / 1000)
  )
}

export async function readTokenMiddleware(c: Context<HonoEnv>, next: Next) {
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const ip = clientIp(c)
  const failKey = { action: "read_auth_fail", ip }

  // 先拒后验：已超出失败额度的 IP 连校验都不做，避免把哈希/回表当成免费算力。
  const failures = await readCounterWindow(db, prefix, failKey, WINDOW_SECONDS)
  if (failures.count >= MAX_AUTH_FAILURES) {
    return rateLimited(c, failures.retryAfter)
  }

  const token = readBearerToken(c)
  const identity = token ? await findApiToken(db, prefix, token) : null
  if (!identity) {
    const state = await consumeCounter(db, prefix, {
      ...failKey,
      windowSeconds: WINDOW_SECONDS
    })
    if (state.count >= MAX_AUTH_FAILURES) {
      return rateLimited(c, remainingSeconds(state.windowStart))
    }
    return unauthorized(c)
  }

  // 成功一次即清掉该 IP 的失败计数：正常调用方偶发输错不会累积到锁定。
  await resetCounter(db, prefix, failKey)

  const usage = await consumeCounter(db, prefix, {
    action: "read",
    account: String(identity.userId),
    windowSeconds: WINDOW_SECONDS
  })
  if (usage.count > MAX_READ_CALLS) {
    return rateLimited(c, remainingSeconds(usage.windowStart))
  }

  // 范围按命中的那一行令牌取（只读令牌与读写令牌各存各的）。
  const scope = await getTokenScope(db, prefix, identity.tokenId)

  await touchApiToken(db, prefix, identity.tokenId)
  c.set("userId", identity.userId)
  c.set("role", identity.role)
  c.set("tokenScope", scope)
  await next()
}
