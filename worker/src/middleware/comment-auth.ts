/**
 * 评论写端点双轨鉴权中间件。
 *
 * 针对评论四个写操作端点（发表、预览、编辑、删除）：
 * - POST /api/pages/:id/comments/preview
 * - POST /api/pages/:id/comments
 * - PUT /api/pages/:id/comments/:commentId
 * - DELETE /api/pages/:id/comments/:commentId
 *
 * 鉴权逻辑：
 * 1. 若请求携带 Authorization 头，抽取 Bearer 令牌并复用 findApiToken(db, prefix, token, { kind: "write" })；
 *    - 校验通过：调用 touchApiToken 刷新最后使用时间，设置 c.set("userId", ...) 与 c.set("role", ...)；
 *    - 校验失败（令牌无效、已吊销、类型非 write、或所属 agent 停用/未批准）：直接 401 Unauthorized（Cache-Control: no-store），不回落会话。
 * 2. 若未携带 Authorization 头，调用现行 authMiddleware 走真人会话 Cookie 鉴权。
 *
 * 其它端点（如 GET /api/pages/:id/comments 列表）不走此中间件，保持严格的真人会话拦截。
 */
import type { Context, Next } from "hono"
import { findApiToken, touchApiToken } from "../core/api-token"
import { getTablePrefix } from "../lib/table-prefix"
import type { HonoEnv } from "../types"
import { authMiddleware } from "./auth"
import { readBearerToken } from "./import-token"

const COMMENT_POST_COLLECTION_RE = /^\/api\/pages\/[^/]+\/comments$/
const COMMENT_POST_PREVIEW_RE = /^\/api\/pages\/[^/]+\/comments\/preview$/
const COMMENT_ITEM_RE = /^\/api\/pages\/[^/]+\/comments\/(?!preview$)[^/]+$/

export function isCommentWriteRoute(method: string, path: string): boolean {
  const m = method.toUpperCase()
  if (m === "POST") {
    return (
      COMMENT_POST_COLLECTION_RE.test(path) ||
      COMMENT_POST_PREVIEW_RE.test(path)
    )
  }
  if (m === "PUT" || m === "DELETE") {
    return COMMENT_ITEM_RE.test(path)
  }
  return false
}

function unauthorized(c: Context<HonoEnv>) {
  c.header("Cache-Control", "no-store")
  return c.json({ error: "Unauthorized" }, 401)
}

export async function commentAuthMiddleware(c: Context<HonoEnv>, next: Next) {
  const authHeader = c.req.header("authorization")
  if (typeof authHeader === "string") {
    const token = readBearerToken(c)
    if (!token) return unauthorized(c)

    const prefix = getTablePrefix(c.env)
    const identity = await findApiToken(c.env.DB, prefix, token, {
      kind: "write"
    })
    if (!identity) return unauthorized(c)

    await touchApiToken(c.env.DB, prefix, identity.tokenId)
    c.set("userId", identity.userId)
    c.set("role", identity.role)
    await next()
    return
  }

  return authMiddleware(c, next)
}
