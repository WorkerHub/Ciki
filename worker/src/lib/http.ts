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

/**
 * 让一段副作用在响应之后继续跑（如找回密码的后台发信）。
 *
 * 有 ExecutionContext 时交给 `waitUntil`：响应不等它，因此耗时与账号是否存在无关；
 * 没有 ExecutionContext 时（Node 测试环境）退化为同步等待，行为与响应体保持一致。
 * 任务自身的异常在这里吞掉并只记脱敏日志，绝不影响已经返回的响应。
 */
export async function runInBackground(
  c: Context<HonoEnv>,
  task: () => Promise<void>
): Promise<void> {
  const guarded = (async () => {
    try {
      await task()
    } catch (err) {
      console.error(
        "Background task failed:",
        err instanceof Error ? err.message : String(err)
      )
    }
  })()
  try {
    c.executionCtx.waitUntil(guarded)
  } catch {
    await guarded
  }
}

/**
 * parentId 入参的统一归一：根页的数据库语义是 `parent_id IS NULL`。
 *
 * 只接受「非空字符串 id」或「null / 缺省」；空串与纯空白按根页（null）处理，
 * 免得把 `""` 写进 parent_id——那样写出来的页面在 `parent_id IS NULL` 的树/子列表
 * 查询里会漏掉，成了游离页。其它类型（数字、对象等）按非法处理，由调用方回 400。
 */
export type ParentIdInput = { ok: true; value: string | null } | { ok: false }

export function readParentId(value: unknown): ParentIdInput {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== "string") return { ok: false }
  const trimmed = value.trim()
  return { ok: true, value: trimmed === "" ? null : trimmed }
}

/**
 * spaceId / space_id 的统一归一：缺省、null、空串与纯空白都表示「用默认空间」，
 * 与 parentId 的口径一致；其它类型按非法处理。
 */
export type SpaceIdInput = { ok: true; value: string | null } | { ok: false }

export function readSpaceId(value: unknown): SpaceIdInput {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== "string") return { ok: false }
  const trimmed = value.trim()
  return { ok: true, value: trimmed === "" ? null : trimmed }
}
