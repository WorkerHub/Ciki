import { app } from "../../src/index"
import { runSetup } from "../../src/lib/setup"
import type { Env } from "../../src/types"
import { MemoryR2 } from "./memory-r2"
import { SqliteD1 } from "./sqlite-d1"

/** 测试用 ENCRYPTION_KEY：32 字节 0x07 的 base64（与线上密钥无关）。 */
export const TEST_ENCRYPTION_KEY = btoa(
  String.fromCharCode(...new Uint8Array(32).fill(7))
)
export const TEST_SETUP_SECRET = "test-setup-secret"

function assets() {
  return {
    fetch: async (req: Request) => {
      const { pathname } = new URL(req.url)
      if (pathname === "/") {
        return new Response("<html>ciki</html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        })
      }
      return new Response("not found", { status: 404 })
    }
  }
}

export interface TestContext {
  env: Env
  db: SqliteD1
  /** 图片桶（ciki-assets）。 */
  r2: MemoryR2
  /** 正文桶（ciki-content）：与图片桶完全隔离，清理测试要能分别断言。 */
  content: MemoryR2
}

/** 新环境：空库 + 内存 R2 + 假静态资源。 */
export function makeContext(overrides: Partial<Env> = {}): TestContext {
  const db = new SqliteD1()
  const r2 = new MemoryR2()
  const content = new MemoryR2()
  const env = {
    DB: db as unknown as D1Database,
    R2: r2 as unknown as R2Bucket,
    CONTENT: content as unknown as R2Bucket,
    ASSETS: assets() as unknown as Fetcher,
    SETUP_SECRET: TEST_SETUP_SECRET,
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    TABLE_PREFIX: "ciki_",
    // 库体积走 Cloudflare D1 REST API：测试默认给一套可用配置，用例要验证
    // 「未配置」时自己用 `{ CLOUDFLARE_API_TOKEN: undefined }` 覆盖。
    CLOUDFLARE_API_TOKEN: "test-value",
    CLOUDFLARE_ACCOUNT_ID: "acct-test",
    D1_DATABASE_ID: "db-test",
    ...overrides
  } as Env
  return { env, db, r2, content }
}

/** 跑一次 setup（建表 + 默认设置），返回上下文。 */
export async function initializedContext(
  overrides: Partial<Env> = {}
): Promise<TestContext> {
  const context = makeContext(overrides)
  const result = await runSetup(context.env)
  if (!result.success) throw new Error(result.error)
  return context
}

export async function request(
  env: Env,
  path: string,
  init: RequestInit = {},
  executionCtx?: TestExecutionContext
): Promise<Response> {
  return app.request(
    path,
    init,
    env,
    executionCtx as unknown as ExecutionContext | undefined
  )
}

/**
 * 测试用 ExecutionContext：把 `waitUntil` 的任务收集起来，供用例在断言前
 * 显式等待（等价于运行时把响应发出去后继续跑的那段代码）。
 */
export class TestExecutionContext {
  private pending: Array<Promise<unknown>> = []

  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise)
  }

  passThroughOnException(): void {}

  /** 等所有后台任务跑完（含它们内部再登记的任务）。 */
  async settle(): Promise<void> {
    while (this.pending.length > 0) {
      await Promise.all(this.pending.splice(0))
    }
  }
}

export function jsonRequest(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
  executionCtx?: TestExecutionContext
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers["content-type"] = "application/json"
  if (cookie) headers.cookie = cookie
  return request(
    env,
    path,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    },
    executionCtx
  )
}

/** 从响应里取第一枚 Set-Cookie 的 `name=value`。 */
export function cookieOf(res: Response): string | null {
  const cookies = res.headers.getSetCookie()
  if (!cookies || cookies.length === 0) return null
  return cookies[0].split(";")[0]
}

export async function register(
  env: Env,
  email: string,
  password = "Test-Password-123"
): Promise<Response> {
  return jsonRequest(env, "POST", "/api/auth/register", { email, password })
}

/** 登录并返回 Cookie；需要 2FA 时抛错（调用方改用 2FA 流程）。 */
export async function loginAs(
  env: Env,
  email: string,
  password = "Test-Password-123"
): Promise<string> {
  const res = await jsonRequest(env, "POST", "/api/auth/login", {
    email,
    password
  })
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as { requires2fa?: boolean }
  if (body.requires2fa) throw new Error("login requires 2FA")
  const cookie = cookieOf(res)
  if (!cookie) throw new Error("login set no cookie")
  return cookie
}

/** 建一个已登录的管理员（首个用户）。 */
export async function adminSession(
  env: Env,
  email = "admin@example.com"
): Promise<string> {
  const res = await register(env, email)
  if (res.status !== 201) throw new Error(`register failed: ${res.status}`)
  return loginAs(env, email)
}

/** 建一个已登录的普通用户（由管理员批准）。 */
export async function userSession(
  env: Env,
  adminCookie: string,
  email = "user@example.com"
): Promise<string> {
  const res = await register(env, email)
  if (res.status !== 201) throw new Error(`register failed: ${res.status}`)
  const users = (await (
    await jsonRequest(
      env,
      "GET",
      "/api/admin/users?status=pending",
      undefined,
      adminCookie
    )
  ).json()) as Array<{ id: string; email: string }>
  const target = users.find((user) => user.email === email)
  if (!target) throw new Error("pending user not found")
  await jsonRequest(
    env,
    "POST",
    `/api/admin/users/${target.id}/approve`,
    undefined,
    adminCookie
  )
  return loginAs(env, email)
}
