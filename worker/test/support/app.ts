import { app } from "../../src/index"
import { getTablePrefix } from "../../src/lib/table-prefix"
import {
  emailCodesTable,
  settingsTable,
  usersTable
} from "../../src/lib/tables"
import { runSetup } from "../../src/lib/setup"
import { SMTP_CONFIG_KEY } from "../../src/services/email"
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

export type ApiTokenKind = "read" | "write"

export interface IssuedApiToken {
  id: number
  name: string
  kind: ApiTokenKind
  spaceIds: number[] | null
  token: string
}

/**
 * 建一枚接口令牌（`POST /api/me/tokens`）：返回行 id 与明文。
 * `name` 缺省不带键（服务端自动命名）；`spaceIds` 缺省不带键（= 不限范围）。
 */
export async function createApiToken(
  env: Env,
  cookie: string,
  kind: ApiTokenKind,
  options: { name?: string; spaceIds?: number[] | null } = {}
): Promise<IssuedApiToken> {
  const body: Record<string, unknown> = { kind }
  if (options.name !== undefined) body.name = options.name
  if (options.spaceIds !== undefined) body.spaceIds = options.spaceIds
  const res = await jsonRequest(env, "POST", "/api/me/tokens", body, cookie)
  if (res.status !== 201) {
    throw new Error(
      `create api token failed: ${res.status} ${await res.text()}`
    )
  }
  return (await res.json()) as IssuedApiToken
}

export interface IssuedImportToken {
  id: number
  name: string
  token: string
}

/** 建一枚浏览器插件凭证（`POST /api/me/import-tokens`）。 */
export async function createImportToken(
  env: Env,
  cookie: string,
  name?: string
): Promise<IssuedImportToken> {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/me/import-tokens",
    name === undefined ? {} : { name },
    cookie
  )
  if (res.status !== 201) {
    throw new Error(
      `create import token failed: ${res.status} ${await res.text()}`
    )
  }
  return (await res.json()) as IssuedImportToken
}

/**
 * 测试替身：写入一份「非密字段合法」的 SMTP 配置。
 *
 * 只为了让 `POST /api/auth/register` 的站点可发信判定通过；真实投递在 Node 下必然
 * 失败（`cloudflare:sockets` 不可用），`sendSmtpMessage` 只返回失败并打一行日志，
 * 不影响用例。需要断言邮件内容的用例自己 mock 传输层并从捕获的 HTML 里取码。
 */
export async function enableSmtpConfig(env: Env): Promise<void> {
  const prefix = getTablePrefix(env)
  const config = {
    host: "smtp.example.com",
    port: 587,
    encryption: "starttls",
    username: "mailer@example.com",
    password: "",
    from: "noreply@example.com",
    fromName: "Ciki"
  }
  await env.DB.prepare(
    `INSERT INTO ${settingsTable(prefix)} (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(SMTP_CONFIG_KEY, JSON.stringify(config), new Date().toISOString())
    .run()
}

/**
 * 测试替身：直接把账号标成已验证（等价于走完注册邮箱验证流程）。
 * 顺带删掉注册时发出的 `register_verify` 码——真实验码成功后该码会被消费，
 * 这样「验证码行数」类断言与走真实流程时一致。
 */
export async function markEmailVerified(
  env: Env,
  email: string
): Promise<void> {
  const prefix = getTablePrefix(env)
  const user = await env.DB.prepare(
    `SELECT id FROM ${usersTable(prefix)} WHERE email = ?`
  )
    .bind(email)
    .first<{ id: number }>()
  if (!user) return
  await env.DB.prepare(
    `UPDATE ${usersTable(prefix)} SET email_verified = 1 WHERE id = ?`
  )
    .bind(user.id)
    .run()
  await env.DB.prepare(
    `DELETE FROM ${emailCodesTable(prefix)} WHERE user_id = ? AND purpose = 'register_verify'`
  )
    .bind(user.id)
    .run()
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

/**
 * 建一个已登录的普通用户：自助注册（因此先让站点可发信）→ 管理员批准 →
 * 标记邮箱已验证 → 登录。验证流程本身由 auth-email-verify.test.ts 单独覆盖。
 */
export async function userSession(
  env: Env,
  adminCookie: string,
  email = "user@example.com"
): Promise<string> {
  await enableSmtpConfig(env)
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
  await markEmailVerified(env, email)
  return loginAs(env, email)
}
