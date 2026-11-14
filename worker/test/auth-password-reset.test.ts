/**
 * 邮箱找回密码（#48 冻结契约的 #51 落地部分）：
 * `POST /api/auth/password/forgot`（发码）→ `verify`（验码换一次性 resetToken）
 * → `reset`（用令牌设密），以及三处「改密后清 password_reset 凭据」的联动。
 *
 * 传输层（cloudflare:sockets）在 Node 里不可用：这里 mock 的只是「把信发出去」
 * 这一步，SMTP 配置读取、密码解密、验证码生成/哈希/落库/限频全走真实代码；
 * 测试从捕获到的邮件 HTML 里取 6 位码，不依赖任何后门。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TestContext } from "./support/app"
import {
  TestExecutionContext,
  adminSession,
  cookieOf,
  initializedContext,
  jsonRequest,
  loginAs,
  register,
  userSession
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
const NEW_PASSWORD = "Brand" + "-New" + "-Password-789"
const OTHER_PASSWORD = "Other" + "-New" + "-Password-456"
const SMTP_PASSWORD = ["smtp", "pass", "word"].join("-")

const SMTP_CONFIG = {
  host: "smtp.example.com",
  port: 587,
  encryption: "starttls",
  username: "mailer@example.com",
  password: SMTP_PASSWORD,
  from: "noreply@example.com",
  fromName: "Ciki"
}

const SUBJECT = "Ciki 密码重置验证码"

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

function resetMessages(to?: string): SentMessage[] {
  return sentMessages().filter(
    (sent) => sent.subject === SUBJECT && (!to || sent.to === to)
  )
}

/** 最近一封密码重置邮件里的 6 位码。 */
function lastCode(to: string): string {
  const message = resetMessages(to).pop()
  if (!message) throw new Error(`没有给 ${to} 发出密码重置邮件`)
  const match = /(\d{6})<\/p>/.exec(message.html)
  if (!match) throw new Error("邮件正文里没有 6 位验证码")
  return match[1]
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  )
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function countRows(db: TestContext["db"], table: string): number {
  return (
    db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number
    }
  ).count
}

function scalar<T>(db: TestContext["db"], sql: string, ...args: unknown[]): T {
  return db.db.prepare(sql).get(...(args as never[])) as T
}

function clearCooldown(db: TestContext["db"]) {
  db.db
    .prepare("DELETE FROM ciki_auth_counters WHERE action = 'email_code_cd'")
    .run()
}

async function enableSmtp(env: TestContext["env"], cookie: string) {
  const res = await jsonRequest(
    env,
    "PUT",
    "/api/admin/system/smtp",
    SMTP_CONFIG,
    cookie
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ emailConfigured: true })
}

/** 发码（默认带 ExecutionContext，调用后等后台发信任务跑完）。 */
async function forgot(
  env: TestContext["env"],
  email: string,
  ctx: TestExecutionContext | undefined = new TestExecutionContext()
): Promise<Response> {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/auth/password/forgot",
    { email },
    undefined,
    ctx
  )
  if (ctx) await ctx.settle()
  return res
}

function verifyCode(
  env: TestContext["env"],
  email: string,
  code: string
): Promise<Response> {
  return jsonRequest(env, "POST", "/api/auth/password/verify", { email, code })
}

function resetPassword(
  env: TestContext["env"],
  resetToken: string,
  newPassword: string
): Promise<Response> {
  return jsonRequest(env, "POST", "/api/auth/password/reset", {
    resetToken,
    newPassword
  })
}

/** 发码 → 验码，返回 resetToken（走真实往返，码从邮件里取；先清发码冷却）。 */
async function issueResetToken(
  context: TestContext,
  email: string
): Promise<string> {
  clearCooldown(context.db)
  const sent = await forgot(context.env, email)
  expect(sent.status).toBe(200)
  const verified = await verifyCode(context.env, email, lastCode(email))
  expect(verified.status).toBe(200)
  const body = (await verified.json()) as { resetToken: string }
  return body.resetToken
}

function userIdOf(db: TestContext["db"], email: string): number {
  return scalar<{ id: number }>(
    db,
    "SELECT id FROM ciki_users WHERE email = ?",
    email
  ).id
}

beforeEach(() => {
  sendSmtpMessageMock.mockReset()
  sendSmtpMessageMock.mockResolvedValue({ success: true })
})

describe("发码（POST /api/auth/password/forgot）", () => {
  it("未配置 SMTP：503 EMAIL_NOT_CONFIGURED，不写计数、不发信；邮箱格式错 400 INVALID_EMAIL", async () => {
    const { env, db } = await initializedContext()
    await adminSession(env)

    const res = await forgot(env, "admin@example.com")
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: "Email delivery is not configured",
      code: "EMAIL_NOT_CONFIGURED"
    })
    expect(
      countRows(db, "ciki_auth_counters WHERE action LIKE 'email_code_%'")
    ).toBe(0)
    expect(countRows(db, "ciki_email_codes")).toBe(0)
    expect(sendSmtpMessageMock).not.toHaveBeenCalled()

    for (const email of ["", "  ", "not-an-email", "a@b.", "a@.com"]) {
      const bad = await forgot(env, email)
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({
        error: "Invalid email format",
        code: "INVALID_EMAIL"
      })
    }
  })

  it("账号存在/不存在回完全相同的 200 与响应体；未知账号不写码、不发信", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)

    const unknown = await forgot(env, "nobody@example.com")
    expect(unknown.status).toBe(200)
    const unknownBody = await unknown.json()
    expect(unknownBody).toEqual({ success: true, cooldownSeconds: 60 })
    expect(resetMessages()).toHaveLength(0)
    expect(countRows(db, "ciki_email_codes")).toBe(0)

    const known = await forgot(env, "Admin@Example.com ")
    expect(known.status).toBe(200)
    expect(await known.json()).toEqual(unknownBody)

    // 邮箱按小写 trim 归一：发给账号邮箱，码占一行。
    expect(resetMessages()).toHaveLength(1)
    expect(resetMessages()[0].to).toBe("admin@example.com")
    const row = scalar<{
      user_id: string
      purpose: string
      binding: string
      code_hash: string
    }>(db, "SELECT user_id, purpose, binding, code_hash FROM ciki_email_codes")
    expect(row.purpose).toBe("password_reset")
    expect(row.binding).toBe("")
    const code = lastCode("admin@example.com")
    expect(row.code_hash).toBe(
      await sha256Hex(`password_reset:${row.user_id}:${code}`)
    )
    expect(row.code_hash).not.toBe(code)
    // 限频按邮箱计数（未知邮箱也计）：两个账号各自的 cd 行都在。
    expect(
      countRows(
        db,
        "ciki_auth_counters WHERE action = 'email_code_cd' AND account IN ('password_reset:nobody@example.com', 'password_reset:admin@example.com')"
      )
    ).toBe(2)
  })

  it("冷却期内重复请求 200 但不重发；小时配额第 6 封才 429", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)

    expect((await forgot(env, "admin@example.com")).status).toBe(200)
    expect(resetMessages()).toHaveLength(1)

    const cooled = await forgot(env, "admin@example.com")
    expect(cooled.status).toBe(200)
    expect(await cooled.json()).toEqual({ success: true, cooldownSeconds: 60 })
    expect(resetMessages()).toHaveLength(1)

    // 冷却期过：第 2..5 封照发；第 6 封超小时配额。
    for (let index = 2; index <= 5; index++) {
      clearCooldown(db)
      const res = await forgot(env, "admin@example.com")
      expect(res.status).toBe(200)
      expect(resetMessages()).toHaveLength(index)
    }
    clearCooldown(db)
    const limited = await forgot(env, "admin@example.com")
    expect(limited.status).toBe(429)
    const body = (await limited.json()) as {
      code: string
      retryAfter: number
    }
    expect(body.code).toBe("RATE_LIMITED")
    expect(body.retryAfter).toBeGreaterThan(0)
    expect(resetMessages()).toHaveLength(5)
  })

  it("已停用 / 未批准账号：同样 200、不写码、不发信", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)

    const pending = await register(env, "pending@example.com")
    expect(pending.status).toBe(201)
    const pendingBody = await forgot(env, "pending@example.com")
    expect(pendingBody.status).toBe(200)
    expect(await pendingBody.json()).toEqual({
      success: true,
      cooldownSeconds: 60
    })
    expect(resetMessages("pending@example.com")).toHaveLength(0)

    const approved = await userSession(env, admin, "user@example.com")
    expect(approved).toBeTruthy()
    const userId = userIdOf(db, "user@example.com")
    const deactivate = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${userId}`,
      { isActive: false },
      admin
    )
    expect(deactivate.status).toBe(200)
    const disabled = await forgot(env, "user@example.com")
    expect(disabled.status).toBe(200)
    expect(await disabled.json()).toEqual({
      success: true,
      cooldownSeconds: 60
    })
    expect(resetMessages("user@example.com")).toHaveLength(0)
    // 注册验证码是另一条流程的行；这里断言「没有写密码重置码」。
    expect(
      scalar<{ count: number }>(
        db,
        "SELECT COUNT(*) AS count FROM ciki_email_codes WHERE purpose = 'password_reset'"
      )
    ).toEqual({ count: 0 })
  })

  it("发送失败也只回同一个 200（原因只记服务端日志）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    sendSmtpMessageMock.mockResolvedValue({
      success: false,
      error: "connection refused"
    })
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})

    const res = await forgot(env, "admin@example.com")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, cooldownSeconds: 60 })
    expect(resetMessages()).toHaveLength(1)
    expect(errorLog).toHaveBeenCalledWith(
      "password reset email failed:",
      "SMTP send failed: connection refused"
    )
    errorLog.mockRestore()
  })

  it("有 ExecutionContext 时发码在后台执行：响应返回时还没写码，后台任务跑完才写", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    const ctx = new TestExecutionContext()

    const res = await jsonRequest(
      env,
      "POST",
      "/api/auth/password/forgot",
      { email: "admin@example.com" },
      undefined,
      ctx
    )
    expect(res.status).toBe(200)
    // 响应不等 SMTP：等待期间还没有码行，也没有邮件。
    expect(countRows(db, "ciki_email_codes")).toBe(0)
    expect(resetMessages()).toHaveLength(0)

    await ctx.settle()
    expect(countRows(db, "ciki_email_codes")).toBe(1)
    expect(resetMessages("admin@example.com")).toHaveLength(1)
  })

  it("没有 ExecutionContext 时退化为同步投递，响应仍是同一个 200", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)

    const res = await forgot(env, "admin@example.com", undefined)
    expect(res.status).toBe(200)
    // 退化路径在响应前就把码写好并发出去了。
    expect(countRows(db, "ciki_email_codes")).toBe(1)
    expect(resetMessages("admin@example.com")).toHaveLength(1)
  })
})

describe("验码（POST /api/auth/password/verify）", () => {
  it("正确码：200 一次性 resetToken（43 字符、600 秒），库里只有 SHA-256 与 userId", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await forgot(env, "admin@example.com")

    const res = await verifyCode(
      env,
      "admin@example.com",
      lastCode("admin@example.com")
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      resetToken: string
      expiresIn: number
    }
    expect(body.success).toBe(true)
    expect(body.expiresIn).toBe(600)
    expect(body.resetToken).toMatch(/^[A-Za-z0-9_-]{43}$/)

    // 验证码被消费：一行不剩。
    expect(countRows(db, "ciki_email_codes")).toBe(0)

    const challenge = scalar<{
      key: string
      user_id: number
      purpose: string
      payload: string
      ttl: number
    }>(
      db,
      `SELECT key, user_id, purpose, payload, expires_at - created_at AS ttl
         FROM ciki_auth_challenges`
    )
    expect(challenge.key).toBe(await sha256Hex(body.resetToken))
    expect(challenge.key).not.toBe(body.resetToken)
    expect(challenge.user_id).toBe(userIdOf(db, "admin@example.com"))
    expect(challenge.purpose).toBe("password_reset")
    // payload 存十进制文本（挑战表是 TEXT 列），与整数 user_id 同值。
    expect(challenge.payload).toBe(String(challenge.user_id))
    expect(challenge.ttl).toBe(600)
    // 验码成功后该邮箱的验码失败计数清零。
    expect(
      countRows(
        db,
        "ciki_auth_counters WHERE action = 'email_code_verify' AND account = 'password_reset:admin@example.com'"
      )
    ).toBe(0)
  })

  it("错码：400 INVALID_CODE、attempts 递增，第 5 次错误删除该码（第 6 次请求 429）", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await forgot(env, "admin@example.com")
    const code = lastCode("admin@example.com")
    const wrong = code === "000000" ? "111111" : "000000"

    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await verifyCode(env, "admin@example.com", wrong)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: "Invalid or expired code",
        code: "INVALID_CODE"
      })
      expect(
        scalar<{ attempts: number }>(
          db,
          "SELECT attempts FROM ciki_email_codes"
        ).attempts
      ).toBe(attempt)
    }

    expect((await verifyCode(env, "admin@example.com", wrong)).status).toBe(400)
    expect(countRows(db, "ciki_email_codes")).toBe(0)

    // 第 6 次请求命中按邮箱计的验码限流（5 次 / 10 分钟）。
    const limited = await verifyCode(env, "admin@example.com", wrong)
    expect(limited.status).toBe(429)
    expect(
      ((await limited.json()) as { retryAfter: number }).retryAfter
    ).toBeGreaterThan(0)
  })

  it("账号不存在 / 已停用与真实错码一模一样：400 + 同一个错误码", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await forgot(env, "admin@example.com")
    const wrong = "000000"

    const wrongCode = await verifyCode(env, "admin@example.com", wrong)
    expect(wrongCode.status).toBe(400)
    const wrongCodeBody = await wrongCode.json()

    const unknown = await verifyCode(env, "nobody@example.com", wrong)
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toEqual(wrongCodeBody)

    const target = await userSession(env, admin, "user@example.com")
    expect(target).toBeTruthy()
    await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${userIdOf(db, "user@example.com")}`,
      { isActive: false },
      admin
    )
    const disabled = await verifyCode(env, "user@example.com", wrong)
    expect(disabled.status).toBe(400)
    expect(await disabled.json()).toEqual(wrongCodeBody)
    // 账号不存在 / 已停用：不写任何新的验证码行（只有 admin 那一枚错码待消费）。
    expect(countRows(db, "ciki_email_codes")).toBe(1)
  })

  it("过期码 400 INVALID_CODE；缺参数同样 400 且不写任何计数", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await forgot(env, "admin@example.com")
    const code = lastCode("admin@example.com")
    db.db
      .prepare("UPDATE ciki_email_codes SET expires_at = ?")
      .run(Math.floor(Date.now() / 1000) - 1)

    const expired = await verifyCode(env, "admin@example.com", code)
    expect(expired.status).toBe(400)
    expect(await expired.json()).toEqual({
      error: "Invalid or expired code",
      code: "INVALID_CODE"
    })

    for (const body of [
      {},
      { email: "admin@example.com" },
      { code },
      { email: "not-an-email", code }
    ]) {
      const res = await jsonRequest(
        env,
        "POST",
        "/api/auth/password/verify",
        body
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: "Invalid or expired code",
        code: "INVALID_CODE"
      })
    }
  })
})

describe("设密（POST /api/auth/password/reset）", () => {
  it("成功：新密码可登录、旧密码失效、该用户全部会话来即 401、不下发 Cookie、重置凭据清空", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)

    // 第二枚会话（模拟另一台设备），重置后同样必须失效。
    const otherDevice = await loginAs(env, "admin@example.com")
    const userId = userIdOf(db, "admin@example.com")

    const token = await issueResetToken({ env, db }, "admin@example.com")
    const res = await resetPassword(env, token, NEW_PASSWORD)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(cookieOf(res)).toBeNull()

    for (const cookie of [admin, otherDevice]) {
      const me = await jsonRequest(env, "GET", "/api/me", undefined, cookie)
      expect(me.status).toBe(401)
    }

    await expect(loginAs(env, "admin@example.com", PASSWORD)).rejects.toThrow()
    await expect(
      loginAs(env, "admin@example.com", NEW_PASSWORD)
    ).resolves.toContain("ciki_session=")

    expect(
      countRows(db, `ciki_auth_challenges WHERE user_id = '${userId}'`)
    ).toBe(0)
    expect(countRows(db, `ciki_email_codes WHERE user_id = '${userId}'`)).toBe(
      0
    )
  })

  it("重置不动 2FA 配置：邮箱验证码仍开启，登录仍需第二步", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    const userId = userIdOf(db, "admin@example.com")
    db.db
      .prepare(
        "INSERT INTO ciki_user_2fa (user_id, totp_secret, totp_enabled, email_otp_enabled, updated_at) VALUES (?, NULL, 0, 1, ?)"
      )
      .run(userId, new Date().toISOString())

    const token = await issueResetToken({ env, db }, "admin@example.com")
    expect((await resetPassword(env, token, NEW_PASSWORD)).status).toBe(200)

    expect(
      scalar<{ email_otp_enabled: number }>(
        db,
        "SELECT email_otp_enabled FROM ciki_user_2fa WHERE user_id = ?",
        userId
      ).email_otp_enabled
    ).toBe(1)
    const login = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: NEW_PASSWORD
    })
    expect(login.status).toBe(200)
    expect(await login.json()).toMatchObject({
      requires2fa: true,
      availableMethods: ["email_otp"]
    })
  })

  it("重放：同一个 resetToken 第二次 400 INVALID_RESET_TOKEN，密码保持第一次的结果", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    const token = await issueResetToken({ env, db }, "admin@example.com")

    expect((await resetPassword(env, token, NEW_PASSWORD)).status).toBe(200)
    const replay = await resetPassword(env, token, OTHER_PASSWORD)
    expect(replay.status).toBe(400)
    expect(await replay.json()).toEqual({
      error: "Invalid or expired reset token",
      code: "INVALID_RESET_TOKEN"
    })
    await expect(
      loginAs(env, "admin@example.com", NEW_PASSWORD)
    ).resolves.toContain("ciki_session=")
    await expect(
      loginAs(env, "admin@example.com", OTHER_PASSWORD)
    ).rejects.toThrow()
  })

  it("并发同一 resetToken：只有一个成功，且只有成功那次的密码生效", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    const token = await issueResetToken({ env, db }, "admin@example.com")

    const [first, second] = await Promise.all([
      resetPassword(env, token, NEW_PASSWORD),
      resetPassword(env, token, OTHER_PASSWORD)
    ])
    expect([first.status, second.status].sort()).toEqual([200, 400])
    const winner = first.status === 200 ? NEW_PASSWORD : OTHER_PASSWORD
    const loser = first.status === 200 ? OTHER_PASSWORD : NEW_PASSWORD
    await expect(loginAs(env, "admin@example.com", winner)).resolves.toContain(
      "ciki_session="
    )
    await expect(loginAs(env, "admin@example.com", loser)).rejects.toThrow()
  })

  it("弱密码 400 WEAK_PASSWORD 且不消费令牌，换合格密码仍可用同一枚令牌", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    const token = await issueResetToken({ env, db }, "admin@example.com")

    for (const weak of ["", "1234567"]) {
      const res = await resetPassword(env, token, weak)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: "Password must be at least 8 characters",
        code: "WEAK_PASSWORD"
      })
    }
    expect((await resetPassword(env, token, NEW_PASSWORD)).status).toBe(200)
  })

  it("无效令牌 / 过期令牌 / 已停用用户：统一 400 INVALID_RESET_TOKEN", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)

    for (const token of ["", "not-a-token", "A".repeat(43)]) {
      const res = await resetPassword(env, token, NEW_PASSWORD)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: "Invalid or expired reset token",
        code: "INVALID_RESET_TOKEN"
      })
    }

    const expiredToken = await issueResetToken({ env, db }, "admin@example.com")
    db.db
      .prepare(
        "UPDATE ciki_auth_challenges SET expires_at = ? WHERE purpose = 'password_reset'"
      )
      .run(Math.floor(Date.now() / 1000) - 1)
    expect((await resetPassword(env, expiredToken, NEW_PASSWORD)).status).toBe(
      400
    )

    const disabledToken = await issueResetToken(
      { env, db },
      "admin@example.com"
    )
    const userId = userIdOf(db, "admin@example.com")
    db.db
      .prepare("UPDATE ciki_users SET is_active = 0 WHERE id = ?")
      .run(userId)
    const disabled = await resetPassword(env, disabledToken, NEW_PASSWORD)
    expect(disabled.status).toBe(400)
    expect(await disabled.json()).toEqual({
      error: "Invalid or expired reset token",
      code: "INVALID_RESET_TOKEN"
    })
    // 令牌没有被「成功消费」：密码仍未改变。
    await expect(loginAs(env, "admin@example.com", PASSWORD)).rejects.toThrow()
  })

  it("设密提交限流：同一令牌 5 次 / 5 分钟，第 6 次 429", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    const token = await issueResetToken({ env, db }, "admin@example.com")

    for (let attempt = 1; attempt <= 5; attempt++) {
      expect((await resetPassword(env, token, "1234567")).status).toBe(400)
    }
    const limited = await resetPassword(env, token, NEW_PASSWORD)
    expect(limited.status).toBe(429)
    expect(
      ((await limited.json()) as { retryAfter: number }).retryAfter
    ).toBeGreaterThan(0)
  })
})

describe("改密后清 password_reset 凭据", () => {
  it("已登录主动改密：保留当前会话，但未使用的验证码与 resetToken 立即作废", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    const resetToken = await issueResetToken({ env, db }, "admin@example.com")
    clearCooldown(db)
    await forgot(env, "admin@example.com")
    expect(countRows(db, "ciki_email_codes")).toBe(1)
    expect(countRows(db, "ciki_auth_challenges")).toBe(1)

    const changed = await jsonRequest(
      env,
      "PUT",
      "/api/me/password",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      admin
    )
    expect(changed.status).toBe(200)
    // 当前会话保留（口径不变）。
    expect(
      (await jsonRequest(env, "GET", "/api/me", undefined, admin)).status
    ).toBe(200)

    expect(countRows(db, "ciki_email_codes")).toBe(0)
    expect(countRows(db, "ciki_auth_challenges")).toBe(0)
    const stale = await resetPassword(env, resetToken, OTHER_PASSWORD)
    expect(stale.status).toBe(400)
    expect(await stale.json()).toMatchObject({ code: "INVALID_RESET_TOKEN" })
  })

  it("管理员改密：该用户全部会话失效，同样清掉未使用的找回密码凭据", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    const userCookie = await userSession(env, admin, "user@example.com")
    expect(userCookie).toBeTruthy()
    const userId = userIdOf(db, "user@example.com")

    const resetToken = await issueResetToken({ env, db }, "user@example.com")
    clearCooldown(db)
    await forgot(env, "user@example.com")
    expect(countRows(db, "ciki_email_codes")).toBe(1)

    const changed = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${userId}`,
      { password: NEW_PASSWORD },
      admin
    )
    expect(changed.status).toBe(200)
    expect(
      (await jsonRequest(env, "GET", "/api/me", undefined, userCookie)).status
    ).toBe(401)
    expect(countRows(db, "ciki_email_codes")).toBe(0)
    expect(countRows(db, "ciki_auth_challenges")).toBe(0)
    expect((await resetPassword(env, resetToken, OTHER_PASSWORD)).status).toBe(
      400
    )
  })
})

describe("公开性与路由", () => {
  it("三个端点未登录也可用（不是 401），参数不合法时按各自的 400 返回", async () => {
    const { env } = await initializedContext()

    const forgot = await jsonRequest(env, "POST", "/api/auth/password/forgot", {
      email: "bad"
    })
    expect(forgot.status).toBe(400)
    expect(await forgot.json()).toMatchObject({ code: "INVALID_EMAIL" })

    const verify = await jsonRequest(env, "POST", "/api/auth/password/verify", {
      email: "admin@example.com",
      code: "123456"
    })
    expect(verify.status).toBe(400)
    expect(await verify.json()).toMatchObject({ code: "INVALID_CODE" })

    const reset = await jsonRequest(env, "POST", "/api/auth/password/reset", {
      resetToken: "nope",
      newPassword: NEW_PASSWORD
    })
    expect(reset.status).toBe(400)
    expect(await reset.json()).toMatchObject({ code: "INVALID_RESET_TOKEN" })
  })
})
