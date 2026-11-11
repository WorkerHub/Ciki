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
  userId: number,
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
 * 路径/查询参数里的整数 id：只认规范形态的十进制正整数（安全整数）。
 *
 * 「一个实体只露一种 ID」：前导零与前后空白都不算（`/p/01`、`/p/%201` 一律 404，
 * 不跟 `/p/1` 指向同一页）。旧 UUID 地址同样不再识别。
 */
export function parseId(raw: string | undefined | null): number | null {
  if (typeof raw !== "string") return null
  if (!/^[1-9]\d*$/.test(raw)) return null
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * 入参里的整数 id：接受 JSON 数字，也接受纯数字字符串（插件把 id 当不透明值透传，
 * 某些客户端会先 stringify）。空串 / 空白 / null 视为「没给」。
 */
export function readIdInput(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  }
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed === "") return null
    return parseId(trimmed) ?? undefined
  }
  return undefined
}

/**
 * parentId 入参的统一归一：根页的数据库语义是 `parent_id IS NULL`。
 *
 * 只接受整数 id 或「null / 缺省 / 空串」；其它类型（对象、非数字串、0、负数）按非法
 * 处理，由调用方回 400。
 */
export type ParentIdInput = { ok: true; value: number | null } | { ok: false }

export function readParentId(value: unknown): ParentIdInput {
  const parsed = readIdInput(value)
  if (parsed === undefined) return { ok: false }
  return { ok: true, value: parsed }
}

/**
 * spaceId / space_id 的统一归一：缺省、null、空串与原口径一致表示「用默认空间」，
 * 与 parentId 同一套整数解析；其它类型按非法处理。
 */
export type SpaceIdInput = { ok: true; value: number | null } | { ok: false }

export function readSpaceId(value: unknown): SpaceIdInput {
  const parsed = readIdInput(value)
  if (parsed === undefined) return { ok: false }
  return { ok: true, value: parsed }
}
