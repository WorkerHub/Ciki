/**
 * 邮箱验证码 2FA（#48 冻结契约的 #50 落地部分）：
 * 设置页的 send-verify / enable / disable、登录第二步的 send-login + verify
 * （method=email_otp）、登录第一步的 availableMethods 顺序与失败关闭，
 * 以及 /api/me 的 twofa.emailOtpEnabled。
 *
 * 传输层（cloudflare:sockets）在 Node 里不可用：这里 mock 的只是「把信发出去」
 * 这一步，配置读取、密码解密、验证码生成/哈希/落库/限频全走真实代码；测试从
 * 捕获到的邮件 HTML 里取 6 位码，因此不依赖任何后门。
 */
import * as OTPAuth from "otpauth"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SMTP_CONFIG_KEY } from "../src/services/email"
import type { TestContext } from "./support/app"
import {
  adminSession,
  cookieOf,
  initializedContext,
  jsonRequest,
  markEmailVerified,
  register
} from "./support/app"
import { createPasskey } from "./support/webauthn"

const { sendSmtpMessageMock } = vi.hoisted(() => ({
  sendSmtpMessageMock: vi.fn()
}))

vi.mock("../src/services/smtp-transport", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/smtp-transport")>()
  return { ...actual, sendSmtpMessage: sendSmtpMessageMock }
})

const PASSWORD = "Test" + "-Password" + "-123"
const WRONG_PASSWORD = ["Wrong", "Password", "456"].join("-")
const SMTP_PASSWORD = ["smtp", "pass", "word"].join("-")

const RP_ID = "localhost"
const ORIGIN = "http://localhost"

const SMTP_CONFIG = {
  host: "smtp.example.com",
  port: 587,
  encryption: "starttls",
  username: "mailer@example.com",
  password: SMTP_PASSWORD,
  from: "noreply@example.com",
  fromName: "Ciki"
}

interface SentMessage {
  to: string
  subject: string
  html: string
}

const SUBJECTS = {
  "2fa_login": "Ciki 登录验证码",
  "2fa_enable": "Ciki 邮箱验证码启用确认"
} as const

function sentMessages(): SentMessage[] {
  return sendSmtpMessageMock.mock.calls.map(
    (call) => (call as [unknown, SentMessage])[1]
  )
}

/** 最近一封该用途的邮件（同时校验收件人是账号邮箱）。 */
function lastMessage(purpose: keyof typeof SUBJECTS, to: string): SentMessage {
  const message = sentMessages()
    .filter((sent) => sent.subject === SUBJECTS[purpose])
    .pop()
  if (!message) throw new Error(`没有发出 ${purpose} 邮件`)
  expect(message.to).toBe(to)
  return message
}

/** 从邮件正文里取 6 位验证码（邮件模板把码单独放在一个 <p> 里）。 */
function codeOf(message: SentMessage): string {
  const match = /(\d{6})<\/p>/.exec(message.html)
  if (!match) throw new Error("邮件正文里没有 6 位验证码")
  return match[1]
}

function codeFor(purpose: keyof typeof SUBJECTS, to: string): string {
  return codeOf(lastMessage(purpose, to))
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

function clearCooldowns(db: TestContext["db"]) {
  db.db
    .prepare("DELETE FROM ciki_auth_counters WHERE action = 'email_code_cd'")
    .run()
}

/** `user_2fa.email_otp_enabled`：没有行（从未启用过）按 0 读，与后端判定一致。 */
function emailOtpFlag(db: TestContext["db"]): number {
  const row = db.db
    .prepare("SELECT email_otp_enabled FROM ciki_user_2fa")
    .get() as { email_otp_enabled: number } | undefined
  return row?.email_otp_enabled ?? 0
}

function countRows(db: TestContext["db"], table: string): number {
  return (
    db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number
    }
  ).count
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

function codeAt(secretBase32: string, offsetMs = 0): string {
  const totp = new OTPAuth.TOTP({
    issuer: "ciki",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32)
  })
  return totp.generate({ timestamp: Date.now() + offsetMs })
}

async function enableTotp(
  env: TestContext["env"],
  cookie: string
): Promise<string> {
  const setup = await jsonRequest(
    env,
    "POST",
    "/api/auth/2fa/totp/setup",
    undefined,
    cookie
  )
  expect(setup.status).toBe(200)
  const { secret } = (await setup.json()) as { secret: string }
  const enable = await jsonRequest(
    env,
    "POST",
    "/api/auth/2fa/totp/enable",
    { code: codeAt(secret) },
    cookie
  )
  expect(enable.status).toBe(200)
  return secret
}

async function registerPasskey(
  env: TestContext["env"],
  cookie: string,
  password?: string
) {
  const optionsRes = await jsonRequest(
    env,
    "POST",
    "/api/auth/2fa/passkey/register/options",
    password ? { password } : undefined,
    cookie
  )
  expect(optionsRes.status).toBe(200)
  const options = (await optionsRes.json()) as { challenge: string }
  const { response } = await createPasskey({
    rpID: RP_ID,
    origin: ORIGIN,
    challenge: options.challenge
  })
  const verify = await jsonRequest(
    env,
    "POST",
    "/api/auth/2fa/passkey/register/verify",
    {
      ...(response as Record<string, unknown>),
      ...(password ? { password } : {})
    },
    cookie
  )
  expect(verify.status).toBe(200)
}

/** 设置页流程：send-verify → enable（已有其它因子时两处都要带密码）。 */
async function enableEmailOtp(
  env: TestContext["env"],
  cookie: string,
  email: string,
  password?: string
): Promise<void> {
  const sent = await jsonRequest(
    env,
    "POST",
    "/api/auth/2fa/email-otp/send-verify",
    password ? { password } : undefined,
    cookie
  )
  expect(sent.status).toBe(200)
  const code = codeFor("2fa_enable", email)
  const enabled = await jsonRequest(
    env,
    "POST",
    "/api/auth/2fa/email-otp/enable",
    password ? { code, password } : { code },
    cookie
  )
  expect(enabled.status).toBe(200)
  expect(await enabled.json()).toEqual({ success: true })
}

beforeEach(() => {
  sendSmtpMessageMock.mockReset()
  sendSmtpMessageMock.mockResolvedValue({ success: true })
})

describe("设置页：发码（send-verify）", () => {
  it("未配置 SMTP：503 EMAIL_NOT_CONFIGURED，不写验证码、不写任何 email_code_* 计数", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)

    // 未登录先拦（会话中间件在路由之前）。
    expect(
      (await jsonRequest(env, "POST", "/api/auth/2fa/email-otp/send-verify"))
        .status
    ).toBe(401)

    const res = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/send-verify",
      undefined,
      admin
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: "Email delivery is not configured",
      code: "EMAIL_NOT_CONFIGURED"
    })

    // enable 同理：503 且不消费（此时也没有码可消费）。
    const enable = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/enable",
      { code: "123456" },
      admin
    )
    expect(enable.status).toBe(503)
    expect(await enable.json()).toMatchObject({
      code: "EMAIL_NOT_CONFIGURED"
    })

    expect(countRows(db, "ciki_email_codes")).toBe(0)
    expect(
      countRows(db, "ciki_auth_counters WHERE action LIKE 'email_code_%'")
    ).toBe(0)
    expect(sendSmtpMessageMock).not.toHaveBeenCalled()
  })

  it("发码：码落库只有哈希（2fa_enable、binding 为空、10 分钟），60 秒内重发 429；验码后即时生效", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)

    const meBefore = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, admin)
    ).json()) as { twofa: Record<string, unknown> }
    expect(meBefore.twofa).toEqual({
      totpEnabled: false,
      passkeyEnabled: false,
      passkeyCount: 0,
      emailOtpEnabled: false
    })

    const sent = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/send-verify",
      undefined,
      admin
    )
    expect(sent.status).toBe(200)
    expect(await sent.json()).toEqual({
      success: true,
      cooldownSeconds: 60,
      expiresInSeconds: 600
    })

    const message = lastMessage("2fa_enable", "admin@example.com")
    const code = codeOf(message)
    const row = db.db
      .prepare(
        "SELECT user_id, purpose, binding, code_hash, attempts, created_at, expires_at FROM ciki_email_codes"
      )
      .get() as {
      user_id: string
      purpose: string
      binding: string
      code_hash: string
      attempts: number
      created_at: number
      expires_at: number
    }
    expect(row.purpose).toBe("2fa_enable")
    expect(row.binding).toBe("")
    expect(row.attempts).toBe(0)
    expect(row.expires_at - row.created_at).toBe(600)
    expect(row.code_hash).not.toContain(code)
    expect(JSON.stringify(row)).not.toContain(code)

    // 60 秒冷却：第二次发码 429，带秒级 retryAfter，且不再发信。
    const second = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/send-verify",
      undefined,
      admin
    )
    expect(second.status).toBe(429)
    const limited = (await second.json()) as {
      code: string
      retryAfter: number
    }
    expect(limited.code).toBe("RATE_LIMITED")
    expect(limited.retryAfter).toBeGreaterThan(0)
    expect(limited.retryAfter).toBeLessThanOrEqual(60)
    expect(sendSmtpMessageMock).toHaveBeenCalledTimes(1)

    // 错码：400 INVALID_CODE、attempts+1，码仍在。
    const wrong = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/enable",
      { code: "000000" },
      admin
    )
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toEqual({
      error: "Invalid code",
      code: "INVALID_CODE"
    })
    expect(
      (
        db.db.prepare("SELECT attempts FROM ciki_email_codes").get() as {
          attempts: number
        }
      ).attempts
    ).toBe(1)

    // 正确码：200、码被消费、开关立即生效。
    const enabled = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/enable",
      { code },
      admin
    )
    expect(enabled.status).toBe(200)
    expect(await enabled.json()).toEqual({ success: true })
    expect(emailOtpFlag(db)).toBe(1)
    expect(countRows(db, "ciki_email_codes")).toBe(0)

    const meAfter = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, admin)
    ).json()) as { twofa: Record<string, unknown> }
    expect(meAfter.twofa).toEqual({
      totpEnabled: false,
      passkeyEnabled: false,
      passkeyCount: 0,
      emailOtpEnabled: true
    })
  })

  it("已有 TOTP 时两个端点都要密码；启用只改 email_otp_enabled，TOTP 密文原样保留", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await enableTotp(env, admin)

    const totpBefore = db.db
      .prepare("SELECT totp_secret, totp_enabled FROM ciki_user_2fa")
      .get() as { totp_secret: string; totp_enabled: number }
    expect(totpBefore.totp_secret.startsWith("v1.")).toBe(true)

    const noPassword = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/send-verify",
      undefined,
      admin
    )
    expect(noPassword.status).toBe(400)
    expect(await noPassword.json()).toEqual({ error: "Password required" })

    const wrongPassword = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/send-verify",
      { password: WRONG_PASSWORD },
      admin
    )
    expect(wrongPassword.status).toBe(403)
    expect(await wrongPassword.json()).toEqual({
      error: "Password is incorrect"
    })

    const sent = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/send-verify",
      { password: PASSWORD },
      admin
    )
    expect(sent.status).toBe(200)
    const code = codeFor("2fa_enable", "admin@example.com")

    const enableNoPassword = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/enable",
      { code },
      admin
    )
    expect(enableNoPassword.status).toBe(400)
    expect(await enableNoPassword.json()).toEqual({
      error: "Password required"
    })

    const enabled = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/enable",
      { code, password: PASSWORD },
      admin
    )
    expect(enabled.status).toBe(200)

    expect(
      db.db.prepare("SELECT totp_secret, totp_enabled FROM ciki_user_2fa").get()
    ).toEqual(totpBefore)
    expect(emailOtpFlag(db)).toBe(1)

    const me = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, admin)
    ).json()) as { twofa: Record<string, unknown> }
    expect(me.twofa).toEqual({
      totpEnabled: true,
      passkeyEnabled: false,
      passkeyCount: 0,
      emailOtpEnabled: true
    })
  })

  it("邮箱验证码已开启也算已有因子：新增 TOTP / passkey 同样要密码；启用 TOTP 不碰邮箱开关", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await enableEmailOtp(env, admin, "admin@example.com")

    const totpNoPassword = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/setup",
      undefined,
      admin
    )
    expect(totpNoPassword.status).toBe(400)
    expect(await totpNoPassword.json()).toEqual({ error: "Password required" })

    const passkeyNoPassword = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/passkey/register/options",
      undefined,
      admin
    )
    expect(passkeyNoPassword.status).toBe(400)

    const setup = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/setup",
      { password: PASSWORD },
      admin
    )
    expect(setup.status).toBe(200)
    const { secret } = (await setup.json()) as { secret: string }
    const enabled = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/enable",
      { code: codeAt(secret), password: PASSWORD },
      admin
    )
    expect(enabled.status).toBe(200)
    // 反向也不能丢：启用 TOTP 不得把邮箱验证码开关写回 0。
    expect(emailOtpFlag(db)).toBe(1)
  })

  it("enable 的错码累计 5 次后码被作废，正确码也不再可用", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)

    const sent = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/send-verify",
      undefined,
      admin
    )
    expect(sent.status).toBe(200)
    const code = codeFor("2fa_enable", "admin@example.com")

    for (let i = 0; i < 5; i += 1) {
      const wrong = await jsonRequest(
        env,
        "POST",
        "/api/auth/2fa/email-otp/enable",
        { code: "000000" },
        admin
      )
      expect(wrong.status).toBe(400)
    }
    expect(countRows(db, "ciki_email_codes")).toBe(0)

    // 第 6 次直接 429（email_code_verify 5 次/10 分钟），正确的码也用不上。
    const blocked = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/enable",
      { code },
      admin
    )
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ code: "RATE_LIMITED" })
    expect(emailOtpFlag(db)).toBe(0)
  })
})

describe("设置页：停用（disable）", () => {
  it("始终要密码；成功即时生效，之后登录不再要 2FA", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await enableEmailOtp(env, admin, "admin@example.com")
    expect(emailOtpFlag(db)).toBe(1)

    const noPassword = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/disable",
      undefined,
      admin
    )
    expect(noPassword.status).toBe(400)
    expect(await noPassword.json()).toEqual({ error: "Password required" })

    const wrongPassword = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/disable",
      { password: WRONG_PASSWORD },
      admin
    )
    expect(wrongPassword.status).toBe(403)

    const disabled = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/disable",
      { password: PASSWORD },
      admin
    )
    expect(disabled.status).toBe(200)
    expect(await disabled.json()).toEqual({ success: true })
    expect(emailOtpFlag(db)).toBe(0)

    const me = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, admin)
    ).json()) as { twofa: { emailOtpEnabled: boolean } }
    expect(me.twofa.emailOtpEnabled).toBe(false)

    const login = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: PASSWORD
    })
    expect(login.status).toBe(200)
    const body = (await login.json()) as {
      success?: boolean
      requires2fa?: boolean
    }
    expect(body.success).toBe(true)
    expect(body.requires2fa).toBeUndefined()
    expect(cookieOf(login)).toContain("ciki_session=")
  })

  it("不依赖 SMTP 是否可用，并清掉未使用的 2fa_enable 验证码", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await enableEmailOtp(env, admin, "admin@example.com")

    // 造一枚还没用的启用码（此时邮箱验证码已开启，作为已有因子要带密码）。
    clearCooldowns(db)
    expect(
      (
        await jsonRequest(
          env,
          "POST",
          "/api/auth/2fa/email-otp/send-verify",
          { password: PASSWORD },
          admin
        )
      ).status
    ).toBe(200)
    expect(countRows(db, "ciki_email_codes")).toBe(1)

    // 发信配置坏掉（删掉整行）之后仍然能关：否则用户会被锁死在这个因子上。
    db.db
      .prepare("DELETE FROM ciki_system_settings WHERE key = ?")
      .run(SMTP_CONFIG_KEY)
    const disabled = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/disable",
      { password: PASSWORD },
      admin
    )
    expect(disabled.status).toBe(200)
    expect(emailOtpFlag(db)).toBe(0)
    expect(countRows(db, "ciki_email_codes")).toBe(0)
  })

  it("密码重认证复用 reauth 限流：错 5 次后 429，开关保持不变", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await enableEmailOtp(env, admin, "admin@example.com")

    for (let i = 0; i < 5; i += 1) {
      const res = await jsonRequest(
        env,
        "POST",
        "/api/auth/2fa/email-otp/disable",
        { password: WRONG_PASSWORD },
        admin
      )
      expect(res.status).toBe(403)
    }
    const blocked = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/disable",
      { password: PASSWORD },
      admin
    )
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ code: "RATE_LIMITED" })
    expect(emailOtpFlag(db)).toBe(1)
  })
})

describe("登录第一步：availableMethods", () => {
  it("顺序固定 totp → passkey → email_otp", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await enableTotp(env, admin)
    await registerPasskey(env, admin, PASSWORD)
    await enableEmailOtp(env, admin, "admin@example.com", PASSWORD)

    const login = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: PASSWORD
    })
    expect(login.status).toBe(200)
    const body = (await login.json()) as {
      requires2fa: boolean
      tempToken: string
      availableMethods: string[]
    }
    expect(body.requires2fa).toBe(true)
    expect(body.availableMethods).toEqual(["totp", "passkey", "email_otp"])
    expect(cookieOf(login)).toBeNull()
  })

  it("只开了邮箱验证码：发信不可用就 403 2FA_METHOD_UNAVAILABLE，绝不静默降级成只验密码", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await enableEmailOtp(env, admin, "admin@example.com")

    db.db
      .prepare("DELETE FROM ciki_system_settings WHERE key = ?")
      .run(SMTP_CONFIG_KEY)
    const login = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: PASSWORD
    })
    expect(login.status).toBe(403)
    expect(await login.json()).toEqual({
      error: "Two-factor method unavailable",
      code: "2FA_METHOD_UNAVAILABLE"
    })
    expect(cookieOf(login)).toBeNull()
  })
})

describe("登录第二步：send-login + verify(method=email_otp)", () => {
  it("发码绑定 tempToken、60 秒冷却；错码 401，正确码放行且不可重放", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await enableEmailOtp(env, admin, "admin@example.com")

    const login = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: PASSWORD
    })
    const loginBody = (await login.json()) as {
      requires2fa: boolean
      tempToken: string
      availableMethods: string[]
    }
    expect(loginBody.requires2fa).toBe(true)
    expect(loginBody.availableMethods).toEqual(["email_otp"])
    expect(cookieOf(login)).toBeNull()

    const sent = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/send-login",
      { tempToken: loginBody.tempToken }
    )
    expect(sent.status).toBe(200)
    expect(await sent.json()).toEqual({
      success: true,
      cooldownSeconds: 60,
      expiresInSeconds: 600
    })

    const message = lastMessage("2fa_login", "admin@example.com")
    const code = codeOf(message)
    const row = db.db
      .prepare("SELECT purpose, binding, attempts FROM ciki_email_codes")
      .get() as { purpose: string; binding: string; attempts: number }
    expect(row.purpose).toBe("2fa_login")
    expect(row.binding).toBe(await sha256Hex(loginBody.tempToken))
    expect(row.attempts).toBe(0)

    // 冷却期内重发 429。
    const again = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/send-login",
      { tempToken: loginBody.tempToken }
    )
    expect(again.status).toBe(429)
    expect(await again.json()).toMatchObject({ code: "RATE_LIMITED" })

    const wrong = await jsonRequest(env, "POST", "/api/auth/2fa/verify", {
      tempToken: loginBody.tempToken,
      method: "email_otp",
      code: "000000"
    })
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toEqual({
      error: "Invalid verification code"
    })

    const verify = await jsonRequest(env, "POST", "/api/auth/2fa/verify", {
      tempToken: loginBody.tempToken,
      method: "email_otp",
      code
    })
    expect(verify.status).toBe(200)
    const verifyBody = (await verify.json()) as {
      success: boolean
      user: { email: string }
    }
    expect(verifyBody.success).toBe(true)
    expect(verifyBody.user.email).toBe("admin@example.com")
    const session = cookieOf(verify)
    expect(session).toContain("ciki_session=")
    expect(
      (await jsonRequest(env, "GET", "/api/me", undefined, session!)).status
    ).toBe(200)
    expect(countRows(db, "ciki_email_codes")).toBe(0)
    expect(
      countRows(
        db,
        "ciki_auth_challenges WHERE purpose = '2fa_login' AND payload = ''"
      )
    ).toBe(0)

    // 同一个码 / 同一个 tempToken 重放：挑战已消费，401。
    const replay = await jsonRequest(env, "POST", "/api/auth/2fa/verify", {
      tempToken: loginBody.tempToken,
      method: "email_otp",
      code
    })
    expect(replay.status).toBe(401)
    expect(cookieOf(replay)).toBeNull()
  })

  it("错码累计 5 次：验证码与登录挑战一并作废，第 6 次 429", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await enableEmailOtp(env, admin, "admin@example.com")

    const login = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: PASSWORD
    })
    const { tempToken } = (await login.json()) as { tempToken: string }
    expect(
      (
        await jsonRequest(env, "POST", "/api/auth/2fa/email-otp/send-login", {
          tempToken
        })
      ).status
    ).toBe(200)
    const code = codeFor("2fa_login", "admin@example.com")

    for (let i = 0; i < 5; i += 1) {
      const res = await jsonRequest(env, "POST", "/api/auth/2fa/verify", {
        tempToken,
        method: "email_otp",
        code: "000000"
      })
      expect(res.status).toBe(401)
    }
    // 第 5 次错误：码行被删、tempToken 的登录挑战也被作废。
    expect(countRows(db, "ciki_email_codes")).toBe(0)
    expect(
      countRows(db, "ciki_auth_challenges WHERE purpose = '2fa_login'")
    ).toBe(0)

    const blocked = await jsonRequest(env, "POST", "/api/auth/2fa/verify", {
      tempToken,
      method: "email_otp",
      code
    })
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ code: "RATE_LIMITED" })
    expect(cookieOf(blocked)).toBeNull()
  })

  it("两步之间站点关了发信：send-login 与 verify 都 503，不放行", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await enableEmailOtp(env, admin, "admin@example.com")

    const login = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: PASSWORD
    })
    const { tempToken } = (await login.json()) as { tempToken: string }

    const sendsBefore = sendSmtpMessageMock.mock.calls.length
    db.db
      .prepare("DELETE FROM ciki_system_settings WHERE key = ?")
      .run(SMTP_CONFIG_KEY)
    const sent = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/send-login",
      { tempToken }
    )
    expect(sent.status).toBe(503)
    expect(await sent.json()).toMatchObject({ code: "EMAIL_NOT_CONFIGURED" })
    expect(sendSmtpMessageMock.mock.calls.length).toBe(sendsBefore)

    const verify = await jsonRequest(env, "POST", "/api/auth/2fa/verify", {
      tempToken,
      method: "email_otp",
      code: "123456"
    })
    expect(verify.status).toBe(503)
    expect(await verify.json()).toMatchObject({ code: "EMAIL_NOT_CONFIGURED" })
    expect(cookieOf(verify)).toBeNull()
  })

  it("登录用的 2fa_login 验证码不能拿来启用（用途隔离）", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await enableEmailOtp(env, admin, "admin@example.com")

    const login = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: PASSWORD
    })
    const { tempToken } = (await login.json()) as { tempToken: string }
    expect(
      (
        await jsonRequest(env, "POST", "/api/auth/2fa/email-otp/send-login", {
          tempToken
        })
      ).status
    ).toBe(200)
    const loginCode = codeFor("2fa_login", "admin@example.com")

    // 用登录码当启用码：用途不同，一律 INVALID_CODE，且不消费这枚登录码。
    const enable = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/enable",
      { code: loginCode, password: PASSWORD },
      admin
    )
    expect(enable.status).toBe(400)
    expect(await enable.json()).toEqual({
      error: "Invalid code",
      code: "INVALID_CODE"
    })
    expect(countRows(db, "ciki_email_codes WHERE purpose = '2fa_login'")).toBe(
      1
    )
    expect(emailOtpFlag(db)).toBe(1)
  })

  it("验证码与 tempToken 绑定：A 的码不能给 B 用", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await enableEmailOtp(env, admin, "admin@example.com")

    const firstLogin = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: PASSWORD
    })
    const first = (await firstLogin.json()) as { tempToken: string }
    expect(
      (
        await jsonRequest(env, "POST", "/api/auth/2fa/email-otp/send-login", {
          tempToken: first.tempToken
        })
      ).status
    ).toBe(200)
    const codeA = codeFor("2fa_login", "admin@example.com")

    const secondLogin = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: PASSWORD
    })
    const second = (await secondLogin.json()) as { tempToken: string }
    clearCooldowns(db)
    expect(
      (
        await jsonRequest(env, "POST", "/api/auth/2fa/email-otp/send-login", {
          tempToken: second.tempToken
        })
      ).status
    ).toBe(200)
    const codeB = codeFor("2fa_login", "admin@example.com")
    expect(codeB).not.toBe(codeA)
    // 两枚码各自一行（binding 不同，互不覆盖）
    expect(countRows(db, "ciki_email_codes WHERE purpose = '2fa_login'")).toBe(
      2
    )

    const crossUse = await jsonRequest(env, "POST", "/api/auth/2fa/verify", {
      tempToken: second.tempToken,
      method: "email_otp",
      code: codeA
    })
    expect(crossUse.status).toBe(401)
    expect(cookieOf(crossUse)).toBeNull()

    const ownCode = await jsonRequest(env, "POST", "/api/auth/2fa/verify", {
      tempToken: second.tempToken,
      method: "email_otp",
      code: codeB
    })
    expect(ownCode.status).toBe(200)
    expect(cookieOf(ownCode)).toContain("ciki_session=")
  })

  it("账号未启用邮箱验证码：send-login 400 METHOD_NOT_ENABLED；坏 tempToken 401", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await enableTotp(env, admin)

    const login = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: PASSWORD
    })
    const loginBody = (await login.json()) as {
      tempToken: string
      availableMethods: string[]
    }
    expect(loginBody.availableMethods).toEqual(["totp"])

    const res = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/send-login",
      { tempToken: loginBody.tempToken }
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "Email code is not enabled for this account",
      code: "METHOD_NOT_ENABLED"
    })
    expect(sendSmtpMessageMock).not.toHaveBeenCalled()

    const bogus = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/send-login",
      { tempToken: "not-a-real-token" }
    )
    expect(bogus.status).toBe(401)
    expect(await bogus.json()).toEqual({
      error: "Invalid or expired 2FA session"
    })

    const missing = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/send-login",
      {}
    )
    expect(missing.status).toBe(400)
  })
})

describe("受限会话（require_2fa）", () => {
  it("放行 email-otp 端点；启用后受限标记清除、登录第二步出现 email_otp", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      { require2fa: true },
      admin
    )

    await register(env, "member@example.com")
    const pending = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/admin/users?status=pending",
        undefined,
        admin
      )
    ).json()) as Array<{ id: string; email: string }>
    const target = pending.find((user) => user.email === "member@example.com")!
    await jsonRequest(
      env,
      "POST",
      `/api/admin/users/${target.id}/approve`,
      undefined,
      admin
    )
    // 注册验证是独立的一道门禁，这里直接置位（流程本身见 auth-email-verify）。
    await markEmailVerified(env, "member@example.com")

    const login = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "member@example.com",
      password: PASSWORD
    })
    expect(login.status).toBe(200)
    const loginBody = (await login.json()) as { needs2faSetup?: boolean }
    expect(loginBody.needs2faSetup).toBe(true)
    const cookie = cookieOf(login)!

    // 受限会话的常规限制仍然生效。
    expect(
      (await jsonRequest(env, "GET", "/api/pages", undefined, cookie)).status
    ).toBe(403)

    // 白名单确实放行 email-otp：不是 403 needs2faSetup，而是「缺密码」400。
    const disable = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/disable",
      undefined,
      cookie
    )
    expect(disable.status).toBe(400)

    // 无任何因子：免密码发码 + 验码启用，成功后受限会话自动解除。
    await enableEmailOtp(env, cookie, "member@example.com")
    expect(
      (await jsonRequest(env, "GET", "/api/pages", undefined, cookie)).status
    ).toBe(200)

    const me = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, cookie)
    ).json()) as { twofa: { emailOtpEnabled: boolean } }
    expect(me.twofa.emailOtpEnabled).toBe(true)

    // 下一次登录：把 email_otp 作为第二因子，而不是再发受限会话。
    const next = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "member@example.com",
      password: PASSWORD
    })
    const nextBody = (await next.json()) as {
      requires2fa?: boolean
      availableMethods?: string[]
      needs2faSetup?: boolean
    }
    expect(nextBody.requires2fa).toBe(true)
    expect(nextBody.availableMethods).toEqual(["email_otp"])
    expect(nextBody.needs2faSetup).toBeUndefined()
    expect(cookieOf(next)).toBeNull()
  })
})

describe("发信失败", () => {
  it("SMTP 发送失败 502 SMTP_SEND_FAILED（原因已脱敏），开关不改变", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableSmtp(env, admin)
    sendSmtpMessageMock.mockResolvedValue({
      success: false,
      error: "535 5.7.8 bad credentials ***"
    })

    const res = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/email-otp/send-verify",
      undefined,
      admin
    )
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe("SMTP_SEND_FAILED")
    expect(body.error).toBe("SMTP send failed: 535 5.7.8 bad credentials ***")
    expect(body.error).not.toContain(SMTP_PASSWORD)
    expect(emailOtpFlag(db)).toBe(0)
  })
})
