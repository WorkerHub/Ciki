/**
 * 路由层共用的小工具：客户端 IP、建会话并下发 Cookie、安全读 JSON。
 */
import type { Context } from "hono"
import { getTablePrefix } from "./table-prefix"
import { createSession, setSessionCookie } from "../core/session"
import type { HonoEnv } from "../types"

export function clientIp(c: Context<HonoEnv>): string {
  const forwarded = c.req.header("x-forwarded-for")
  return (
    c.req.header("cf-connecting-ip") ||
    (forwarded ? forwarded.split(",")[0].trim() : "") ||
    "unknown"
  )
}

/** 新建会话并把不透明令牌写进 HttpOnly Cookie。 */
export async function issueSession(
  c: Context<HonoEnv>,
  userId: string,
  restricted = false
): Promise<void> {
  const prefix = getTablePrefix(c.env)
  const { token } = await createSession(c.env.DB, prefix, {
    userId,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? "",
    needs2faSetup: restricted
  })
  setSessionCookie(c, token)
}

export async function readJsonBody<T>(c: Context<HonoEnv>): Promise<T | null> {
  try {
    return await c.req.json<T>()
  } catch {
    return null
  }
}
