/**
 * 注册邮箱验证门禁（本单冻结契约的后端部分）。
 *
 * 覆盖：注册后 `email_verified=0` 且立刻发 6 位码（10 分钟）；未配置 SMTP 时普通
 * 自助注册 503 且不建号；未验证不能登录（403 `EMAIL_NOT_VERIFIED`）；验码置位、
 * 码单次消费；错码累计 5 次删码；重发冷却/小时配额/未知邮箱同形；验证后可登录；
 * 首个管理员与管理员后台建号直接已验证且不发注册邮件。
 *
 * 传输层在 Node 里不可用，所以只 mock「把信发出去」这一步；配置读取、发码、哈希、
 * 落库、限频、验码全走真实代码，码从捕获的邮件 HTML 里取。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../src/types"
import type { TestContext } from "./support/app"
import {
  TestExecutionContext,
  adminSession,
  enableSmtpConfig,
  initializedContext,
  jsonRequest,
  loginAs
} from "./support/app"

const { sendSmtpMessageMock } = vi.hoisted(() => ({
  sendSmtpMessageMock: vi.fn()
}))

vi.mock("../src/services/smtp-transport", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/smtp-transport")>()
  return { ...actual, sendSmtpMessage: sendSmtpMessageMock }
})

const PASSWORD = "Test" + "-Password" + "-123"
const ADMIN = "admin@example.com"
const USER = "user@example.com"
const SUBJECT = "Ciki 注册验证码"

interface SentMessage {
  to: string
  subject: string
  html: string
}

function sentMessages(): SentMessage[] {
  return sendSmtpMessageMock.mock.calls.map(
    (call) => (call as [unknown, SentMessage])[1]
  )
}

function registerMessages(to?: string): SentMessage[] {
  return sentMessages().filter(
    (sent) => sent.subject === SUBJECT && (!to || sent.to === to)
  )
}

/** 最近一封指定主题邮件里的 6 位码。 */
function lastCode(to: string, subject = SUBJECT): string {
  const message = sentMessages()
    .filter((sent) => sent.subject === subject && sent.to === to)
    .pop()
  if (!message) throw new Error(`没有给 ${to} 发出注册验证邮件`)
  const match = /(\d{6})<\/p>/.exec(message.html)
  if (!match) throw new Error("邮件正文里没有 6 位验证码")
  return match[1]
}

function countRows(ctx: TestContext, table: string, where = ""): number {
  return (
    ctx.db.db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`)
      .get() as { count: number }
  ).count
}

function row<T>(ctx: TestContext, sql: string, ...args: unknown[]): T {
  return ctx.db.db.prepare(sql).get(...(args as never[])) as T
}

function clearCooldown(ctx: TestContext) {
  ctx.db.db
    .prepare("DELETE FROM ciki_auth_counters WHERE action = 'email_code_cd'")
    .run()
}

/** 注册一个普通用户并等后台发信任务跑完（返回响应）。 */
async function registerUser(
  ctx: TestContext,
  email = USER,
  executionCtx: TestExecutionContext | undefined = new TestExecutionContext()
): Promise<Response> {
  const res = await jsonRequest(
    ctx.env,
    "POST",
    "/api/auth/register",
    { email, password: PASSWORD },
    undefined,
    executionCtx
  )
  if (executionCtx) await executionCtx.settle()
  return res
}

function verify(env: Env, email: string, code: string): Promise<Response> {
  return jsonRequest(env, "POST", "/api/auth/email/verify", { email, code })
}

function resend(env: Env, email: string): Promise<Response> {
  return jsonRequest(env, "POST", "/api/auth/email/resend", { email })
}

async function login(env: Env, email = USER): Promise<Response> {
  return jsonRequest(env, "POST", "/api/auth/login", {
    email,
    password: PASSWORD
  })
}

/** 已验证的普通用户（走真实注册 + 验码，供「验证后可登录」类用例）。 */
async function verifiedUser(ctx: TestContext, email = USER): Promise<void> {
  const res = await registerUser(ctx, email)
  expect(res.status).toBe(201)
  const code = lastCode(email)
  const verified = await verify(ctx.env, email, code)
  expect(verified.status).toBe(200)
}

beforeEach(() => {
  sendSmtpMessageMock.mockReset()
  sendSmtpMessageMock.mockResolvedValue({ success: true })
})

describe("注册：发首封验证码", () => {
  it("第二个用户：201 + emailVerificationRequired，库里未验证，邮件只有码与 10 分钟", async () => {
    const ctx = await initializedContext()
    const admin = await adminSession(ctx.env)
    expect(admin).toBeTruthy()
    sendSmtpMessageMock.mockClear()
    await enableSmtpConfig(ctx.env)

    const res = await registerUser(ctx)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      success: true,
      approvalRequired: true,
      emailVerificationRequired: true
    })

    expect(
      row<{ email_verified: number }>(
        ctx,
        "SELECT email_verified FROM ciki_users WHERE email = ?",
        USER
      )
    ).toEqual({ email_verified: 0 })

    const messages = registerMessages(USER)
    expect(messages).toHaveLength(1)
    expect(messages[0].html).toMatch(/\d{6}/)
    expect(messages[0].html).toContain("10 分钟")
    expect(messages[0].html).not.toContain("若非本人操作")

    // 码落库为 register_verify、10 分钟有效、单次消费。
    const code = row<{
      purpose: string
      expires_at: number
      created_at: number
    }>(
      ctx,
      "SELECT purpose, created_at, expires_at FROM ciki_email_codes WHERE user_id = (SELECT id FROM ciki_users WHERE email = ?)",
      USER
    )
    expect(code.purpose).toBe("register_verify")
    expect(code.expires_at - code.created_at).toBe(600)

    // 注册首封也算「刚发过」：冷却已 arm，避免立刻点重发把刚到的码作废。
    expect(
      countRows(ctx, "ciki_auth_counters", "WHERE action = 'email_code_cd'")
    ).toBe(1)
  })

  it("首个管理员直接已验证、不发注册邮件", async () => {
    const ctx = await initializedContext()
    sendSmtpMessageMock.mockClear()

    const res = await registerUser(ctx, ADMIN)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      success: true,
      approvalRequired: false,
      emailVerificationRequired: false
    })
    expect(
      row<{ email_verified: number }>(
        ctx,
        "SELECT email_verified FROM ciki_users WHERE email = ?",
        ADMIN
      )
    ).toEqual({ email_verified: 1 })
    expect(registerMessages()).toEqual([])
    expect(countRows(ctx, "ciki_email_codes")).toBe(0)
  })

  it("站点未配置 SMTP：第二个用户 503 且不建号", async () => {
    const ctx = await initializedContext()
    await adminSession(ctx.env)
    sendSmtpMessageMock.mockClear()

    const res = await registerUser(ctx, USER)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: "Email delivery is not configured",
      code: "EMAIL_NOT_CONFIGURED"
    })
    expect(countRows(ctx, "ciki_users")).toBe(1)
    expect(registerMessages()).toEqual([])
  })

  it("管理员后台建号：直接已验证、不发注册邮件", async () => {
    const ctx = await initializedContext()
    const admin = await adminSession(ctx.env)
    sendSmtpMessageMock.mockClear()

    const res = await jsonRequest(
      ctx.env,
      "POST",
      "/api/admin/users",
      { email: USER, password: PASSWORD },
      admin
    )
    expect(res.status).toBe(201)
    expect(
      row<{ email_verified: number; approval_status: string }>(
        ctx,
        "SELECT email_verified, approval_status FROM ciki_users WHERE email = ?",
        USER
      )
    ).toEqual({ email_verified: 1, approval_status: "approved" })
    expect(registerMessages()).toEqual([])
    // 管理员建号不需要站点发信能力。
    expect(await login(ctx.env)).toBeTruthy()
  })
})

/** 管理员批准某个已注册用户。 */
async function approve(ctx: TestContext, admin: string, email = USER) {
  const id = row<{ id: string }>(
    ctx,
    "SELECT id FROM ciki_users WHERE email = ?",
    email
  ).id
  const res = await jsonRequest(
    ctx.env,
    "POST",
    `/api/admin/users/${id}/approve`,
    undefined,
    admin
  )
  expect(res.status).toBe(200)
}

describe("登录门禁", () => {
  it("未验证 403 EMAIL_NOT_VERIFIED；验证并批准后可登录", async () => {
    const ctx = await initializedContext()
    const admin = await adminSession(ctx.env)
    await enableSmtpConfig(ctx.env)
    await registerUser(ctx)

    const blocked = await login(ctx.env)
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toEqual({
      error: "Email not verified",
      code: "EMAIL_NOT_VERIFIED"
    })

    await verify(ctx.env, USER, lastCode(USER))
    // 验证只是第一道；站点开了审批，还得管理员放行。
    const pending = await login(ctx.env)
    expect(pending.status).toBe(403)
    expect((await pending.json()) as { code: string }).toMatchObject({
      code: "ACCOUNT_PENDING_APPROVAL"
    })

    await approve(ctx, admin)
    const ok = await login(ctx.env)
    expect(ok.status).toBe(200)
  })

  it("未验证 + 待审批：先报未验证（验证完再报待审批）", async () => {
    const ctx = await initializedContext()
    await adminSession(ctx.env)
    await enableSmtpConfig(ctx.env)
    await registerUser(ctx)

    const blocked = await login(ctx.env)
    expect((await blocked.json()) as { code: string }).toMatchObject({
      code: "EMAIL_NOT_VERIFIED"
    })

    await verify(ctx.env, USER, lastCode(USER))
    const pending = await login(ctx.env)
    expect(pending.status).toBe(403)
    expect(await pending.json()).toEqual({
      error: "Account pending approval",
      code: "ACCOUNT_PENDING_APPROVAL"
    })
  })

  it("已批准但未验证也不能登录", async () => {
    const ctx = await initializedContext()
    const admin = await adminSession(ctx.env)
    await enableSmtpConfig(ctx.env)
    await registerUser(ctx)
    await approve(ctx, admin)

    const res = await login(ctx.env)
    expect(res.status).toBe(403)
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "EMAIL_NOT_VERIFIED"
    })
  })
})

describe("验码", () => {
  it("成功置位、码作废；同码第二次 INVALID_CODE", async () => {
    const ctx = await initializedContext()
    await adminSession(ctx.env)
    await enableSmtpConfig(ctx.env)
    await registerUser(ctx)
    const code = lastCode(USER)

    const ok = await verify(ctx.env, USER, code)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ success: true })
    expect(
      row<{ email_verified: number }>(
        ctx,
        "SELECT email_verified FROM ciki_users WHERE email = ?",
        USER
      )
    ).toEqual({ email_verified: 1 })
    expect(countRows(ctx, "ciki_email_codes")).toBe(0)

    const again = await verify(ctx.env, USER, code)
    expect(again.status).toBe(400)
    expect(await again.json()).toEqual({
      error: "Invalid or expired code",
      code: "INVALID_CODE"
    })
  })

  it("未知邮箱与错码同形 400，不暴露账号是否存在", async () => {
    const ctx = await initializedContext()
    await adminSession(ctx.env)
    await enableSmtpConfig(ctx.env)
    await registerUser(ctx)

    const unknown = await verify(ctx.env, "nobody@example.com", "123456")
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toEqual({
      error: "Invalid or expired code",
      code: "INVALID_CODE"
    })
    const wrong = await verify(ctx.env, USER, "000000")
    expect(wrong.status).toBe(400)
    expect((await wrong.json()) as { code: string }).toMatchObject({
      code: "INVALID_CODE"
    })
  })

  it("邮箱格式不对报 INVALID_EMAIL；空码不消耗验码配额", async () => {
    const ctx = await initializedContext()
    const bad = await verify(ctx.env, "not-an-email", "123456")
    expect(bad.status).toBe(400)
    expect((await bad.json()) as { code: string }).toMatchObject({
      code: "INVALID_EMAIL"
    })
    const empty = await verify(ctx.env, USER, "  ")
    expect(empty.status).toBe(400)
  })

  it("错码累计 5 次即删码，之后连对码也失效", async () => {
    const ctx = await initializedContext()
    await adminSession(ctx.env)
    await enableSmtpConfig(ctx.env)
    await registerUser(ctx)
    const code = lastCode(USER)

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await verify(ctx.env, USER, "000000")
      expect(res.status).toBe(400)
      // 每次都清掉验码计数，测的是「attempts 递增到 5 删码」而不是限频。
      ctx.db.db
        .prepare(
          "DELETE FROM ciki_auth_counters WHERE action LIKE 'email_code_verify%'"
        )
        .run()
    }
    expect(countRows(ctx, "ciki_email_codes")).toBe(0)

    const late = await verify(ctx.env, USER, code)
    expect(late.status).toBe(400)
    expect(
      row<{ email_verified: number }>(
        ctx,
        "SELECT email_verified FROM ciki_users WHERE email = ?",
        USER
      )
    ).toEqual({ email_verified: 0 })
  })

  it("验码失败超限 429 带 retryAfter", async () => {
    const ctx = await initializedContext()
    await adminSession(ctx.env)
    await enableSmtpConfig(ctx.env)
    await registerUser(ctx)

    let last: Response | undefined
    for (let attempt = 0; attempt < 6; attempt += 1) {
      last = await verify(ctx.env, USER, "000000")
    }
    expect(last?.status).toBe(429)
    const body = (await last?.json()) as { code: string; retryAfter: number }
    expect(body.code).toBe("RATE_LIMITED")
    expect(body.retryAfter).toBeGreaterThan(0)
  })
})

describe("重发", () => {
  it("冷却期内 200 不重发；清掉冷却后重发换新码、旧码作废", async () => {
    const ctx = await initializedContext()
    await adminSession(ctx.env)
    await enableSmtpConfig(ctx.env)
    await registerUser(ctx)
    const first = lastCode(USER)

    const cooling = await resend(ctx.env, USER)
    expect(cooling.status).toBe(200)
    expect(await cooling.json()).toEqual({
      success: true,
      cooldownSeconds: 60
    })
    expect(registerMessages(USER)).toHaveLength(1)

    clearCooldown(ctx)
    const again = await resend(ctx.env, USER)
    expect(again.status).toBe(200)
    expect(registerMessages(USER)).toHaveLength(2)
    const second = lastCode(USER)
    expect(second).not.toBe(first)

    // 旧码已被同一 (user, purpose, binding) 覆盖 → INVALID_CODE；新码可用。
    expect((await verify(ctx.env, USER, first)).status).toBe(400)
    expect((await verify(ctx.env, USER, second)).status).toBe(200)
  })

  it("未知邮箱、已验证账号、已拒绝账号一律 200 且不发信", async () => {
    const ctx = await initializedContext()
    await adminSession(ctx.env)
    await enableSmtpConfig(ctx.env)
    sendSmtpMessageMock.mockClear()

    const unknown = await resend(ctx.env, "nobody@example.com")
    expect(unknown.status).toBe(200)

    // 首个管理员本来就已验证。
    const verified = await resend(ctx.env, ADMIN)
    expect(verified.status).toBe(200)

    await registerUser(ctx)
    await verify(ctx.env, USER, lastCode(USER))
    sendSmtpMessageMock.mockClear()
    clearCooldown(ctx)
    const done = await resend(ctx.env, USER)
    expect(done.status).toBe(200)
    expect(registerMessages(USER)).toEqual([])
  })

  it("未配置 SMTP：503 EMAIL_NOT_CONFIGURED", async () => {
    const ctx = await initializedContext()
    const res = await resend(ctx.env, USER)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: "Email delivery is not configured",
      code: "EMAIL_NOT_CONFIGURED"
    })
  })

  it("小时配额用尽 429 带 retryAfter", async () => {
    const ctx = await initializedContext()
    await adminSession(ctx.env)
    await enableSmtpConfig(ctx.env)
    await registerUser(ctx)

    // 注册首封只 arm 冷却、不占小时配额；重发 5 次到顶（每次清冷却、清 IP 配额）。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      clearCooldown(ctx)
      ctx.db.db
        .prepare(
          "DELETE FROM ciki_auth_counters WHERE action = 'email_code_send_ip'"
        )
        .run()
      expect((await resend(ctx.env, USER)).status).toBe(200)
    }
    clearCooldown(ctx)
    ctx.db.db
      .prepare(
        "DELETE FROM ciki_auth_counters WHERE action = 'email_code_send_ip'"
      )
      .run()
    const blocked = await resend(ctx.env, USER)
    expect(blocked.status).toBe(429)
    const body = (await blocked.json()) as { code: string; retryAfter: number }
    expect(body.code).toBe("RATE_LIMITED")
    expect(body.retryAfter).toBeGreaterThan(0)
  })
})

describe("与找回密码互不影响", () => {
  it("注册验证码不能当密码重置码用，反之亦然", async () => {
    const ctx = await initializedContext()
    const admin = await adminSession(ctx.env)
    await enableSmtpConfig(ctx.env)
    await registerUser(ctx)
    // 找回密码只对可用账号发信（待审批账号 is_active=0）；先批准，聚焦用途隔离。
    await approve(ctx, admin)
    const registerCode = lastCode(USER)

    // 用途隔离：拿注册码走找回密码的验码端点不认。
    const wrong = await jsonRequest(
      ctx.env,
      "POST",
      "/api/auth/password/verify",
      { email: USER, code: registerCode }
    )
    expect(wrong.status).toBe(400)

    // 反向：找回密码的码也不能用来验证邮箱。
    clearCooldown(ctx)
    const forgotCtx = new TestExecutionContext()
    const forgot = await jsonRequest(
      ctx.env,
      "POST",
      "/api/auth/password/forgot",
      { email: USER },
      undefined,
      forgotCtx
    )
    await forgotCtx.settle()
    expect(forgot.status).toBe(200)
    const resetCode = lastCode(USER, "Ciki 密码重置验证码")
    expect((await verify(ctx.env, USER, resetCode)).status).toBe(400)

    // 注册码本身仍然有效——两条流程各用各的行。
    expect((await verify(ctx.env, USER, registerCode)).status).toBe(200)
  })
})

describe("已验证用户的会话", () => {
  it("走完注册 + 验证 + 批准后正常拿到会话 Cookie", async () => {
    const ctx = await initializedContext()
    const admin = await adminSession(ctx.env)
    await enableSmtpConfig(ctx.env)
    await verifiedUser(ctx)
    await approve(ctx, admin)
    const cookie = await loginAs(ctx.env, USER)
    expect(cookie).toContain("ciki_session=")
  })
})
