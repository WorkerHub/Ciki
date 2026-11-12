/**
 * 界面语言（i18n 规格 §2.6–§2.8）的后端部分：
 *
 * - 注册入参 `language`：支持集内值落库；非法/缺失/非字符串一律回退 `zh`，不阻断注册。
 * - `PUT /api/me/profile` 接受 `language`（可单独提交、不影响 username/头像），非法值
 *   400 `INVALID_LANGUAGE` 且一行都不写；`GET /api/me` 输出 `language`。
 * - 4 类验证码邮件按语言出文案：已注册用户按账号语言，注册首封按注册入参语言；
 *   中文文案逐字不变（这里用完整 HTML 字符串锁死）。
 *
 * 传输层在 Node 里不可用，只 mock「把信发出去」这一步；其余全走真实代码。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { sendEmailCodeMessage } from "../src/services/email"
import type { TestContext } from "./support/app"
import {
  TestExecutionContext,
  adminSession,
  enableSmtpConfig,
  initializedContext,
  jsonRequest,
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
const ADMIN = "admin@example.com"
const USER = "user@example.com"

const ZH_SUBJECTS = {
  password_reset: "Ciki 密码重置验证码",
  "2fa_login": "Ciki 登录验证码",
  "2fa_enable": "Ciki 邮箱验证码启用确认",
  register_verify: "Ciki 注册验证码"
} as const

const EN_SUBJECTS = {
  password_reset: "Ciki password reset code",
  "2fa_login": "Ciki sign-in code",
  "2fa_enable": "Ciki email code setup",
  register_verify: "Ciki registration code"
} as const

type Purpose = keyof typeof ZH_SUBJECTS

interface SentMessage {
  to: string
  subject: string
  html: string
}

interface MeShape {
  id: number
  username: string
  email: string
  role: string
  avatarUrl: string | null
  language: string
  [key: string]: unknown
}

function sentMessages(): SentMessage[] {
  return sendSmtpMessageMock.mock.calls.map(
    (call) => (call as [unknown, SentMessage])[1]
  )
}

function lastMessage(to: string): SentMessage {
  const message = sentMessages()
    .filter((sent) => sent.to === to)
    .pop()
  if (!message) throw new Error(`没有给 ${to} 发信`)
  return message
}

function storedLanguage(ctx: TestContext, email: string): string {
  const row = ctx.db.db
    .prepare("SELECT language FROM ciki_users WHERE email = ?")
    .get(email) as { language: string } | undefined
  if (!row) throw new Error(`没有 ${email} 这个账号`)
  return row.language
}

async function me(env: TestContext["env"], cookie: string): Promise<MeShape> {
  const res = await jsonRequest(env, "GET", "/api/me", undefined, cookie)
  expect(res.status).toBe(200)
  return (await res.json()) as MeShape
}

function putProfile(
  env: TestContext["env"],
  cookie: string,
  body: unknown
): Promise<Response> {
  return jsonRequest(env, "PUT", "/api/me/profile", body, cookie)
}

async function switchLanguage(
  ctx: TestContext,
  cookie: string,
  language: string
): Promise<void> {
  const res = await putProfile(ctx.env, cookie, { language })
  expect(res.status).toBe(200)
  expect(((await res.json()) as MeShape).language).toBe(language)
}

/** 注册并把后台发信任务跑完（响应不等 SMTP）。 */
async function registerWith(
  ctx: TestContext,
  body: { email: string; language?: unknown }
): Promise<Response> {
  const executionCtx = new TestExecutionContext()
  const res = await jsonRequest(
    ctx.env,
    "POST",
    "/api/auth/register",
    { password: PASSWORD, ...body },
    undefined,
    executionCtx
  )
  await executionCtx.settle()
  return res
}

/** 清掉注册首封 arm 的 60 秒发码冷却，让「重发」真的发信。 */
function clearEmailCooldown(ctx: TestContext): void {
  ctx.db.db
    .prepare("DELETE FROM ciki_auth_counters WHERE action = 'email_code_cd'")
    .run()
}

/** 从邮件正文里取 6 位验证码（模板把码单独放在一个 <p> 里）。 */
function codeOf(message: SentMessage): string {
  const match = /(\d{6})<\/p>/.exec(message.html)
  if (!match) throw new Error("邮件正文里没有 6 位验证码")
  return match[1]
}

beforeEach(() => {
  sendSmtpMessageMock.mockReset()
  sendSmtpMessageMock.mockResolvedValue({ success: true })
})

describe("注册入参 language", () => {
  it("英文界面注册：账号 language=en，注册验证邮件为英文", async () => {
    const ctx = await initializedContext()
    await adminSession(ctx.env, ADMIN)
    await enableSmtpConfig(ctx.env)
    sendSmtpMessageMock.mockClear()

    const res = await registerWith(ctx, { email: USER, language: "en" })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      success: true,
      approvalRequired: true,
      emailVerificationRequired: true
    })
    expect(storedLanguage(ctx, USER)).toBe("en")

    const message = lastMessage(USER)
    expect(message.subject).toBe(EN_SUBJECTS.register_verify)
    expect(message.html).toContain("valid for 10 minutes")
    // 注册验证邮件不加开场句，因此也没有「若非本人操作」那一句。
    expect(message.html).not.toContain("If you did not request")
  })

  it("缺省 / 非法 / 非字符串一律回退 zh，且不阻断注册", async () => {
    const ctx = await initializedContext()
    await adminSession(ctx.env, ADMIN)
    await enableSmtpConfig(ctx.env)

    const cases: Array<{ email: string; language?: unknown }> = [
      { email: "default@example.com" },
      { email: "fr@example.com", language: "fr" },
      { email: "number@example.com", language: 123 }
    ]
    for (const entry of cases) {
      sendSmtpMessageMock.mockClear()
      const res = await registerWith(ctx, entry)
      expect(res.status).toBe(201)
      expect(storedLanguage(ctx, entry.email)).toBe("zh")
      const message = lastMessage(entry.email)
      expect(message.subject).toBe(ZH_SUBJECTS.register_verify)
      expect(message.html).toContain("10 分钟")
    }
  })

  it("首个管理员（免验证、不发信）也按入参语言落库", async () => {
    const ctx = await initializedContext()
    const res = await registerWith(ctx, { email: ADMIN, language: "en" })
    expect(res.status).toBe(201)
    expect(storedLanguage(ctx, ADMIN)).toBe("en")
    expect(sendSmtpMessageMock).not.toHaveBeenCalled()
  })
})

describe("PUT /api/me/profile 与 meDto 的 language", () => {
  it("只带 language 时只改语言：username / 头像 / id / email 都不动", async () => {
    const ctx = await initializedContext()
    const cookie = await adminSession(ctx.env)
    const before = await me(ctx.env, cookie)
    expect(before.language).toBe("zh")

    const res = await putProfile(ctx.env, cookie, { language: "en" })
    expect(res.status).toBe(200)
    const updated = (await res.json()) as MeShape
    expect(updated.language).toBe("en")
    for (const key of ["id", "username", "email", "avatarUrl", "role"]) {
      expect(updated[key]).toEqual(before[key])
    }

    const after = await me(ctx.env, cookie)
    expect(after.language).toBe("en")
    expect(after.username).toBe(before.username)
    expect(after.avatarUrl).toBe(before.avatarUrl)
    expect(storedLanguage(ctx, ADMIN)).toBe("en")

    // 与 username 同时提交时两者一起生效（仍是同一条 UPDATE）。
    const both = await putProfile(ctx.env, cookie, {
      username: "观测者",
      language: "zh"
    })
    expect(both.status).toBe(200)
    const bothBody = (await both.json()) as MeShape
    expect(bothBody.username).toBe("观测者")
    expect(bothBody.language).toBe("zh")
  })

  it("非法 language 400 INVALID_LANGUAGE，且同一请求里的其它字段也不落库", async () => {
    const ctx = await initializedContext()
    const cookie = await adminSession(ctx.env)
    const before = await me(ctx.env, cookie)

    for (const language of ["fr", "EN", " en ", null, 123, true]) {
      const res = await putProfile(ctx.env, cookie, { language })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: "language must be zh or en",
        code: "INVALID_LANGUAGE"
      })
    }
    expect(storedLanguage(ctx, ADMIN)).toBe("zh")
    expect((await me(ctx.env, cookie)).language).toBe("zh")

    // 合法 username + 非法 language：整单拒绝，名字没被改。
    const mixed = await putProfile(ctx.env, cookie, {
      username: "观测者",
      language: "fr"
    })
    expect(mixed.status).toBe(400)
    expect(((await mixed.json()) as { code?: string }).code).toBe(
      "INVALID_LANGUAGE"
    )
    expect((await me(ctx.env, cookie)).username).toBe(before.username)

    // 三个字段都没有仍是 Nothing to update（与语言无关）。
    const empty = await putProfile(ctx.env, cookie, {})
    expect(empty.status).toBe(400)
    expect(await empty.json()).toEqual({ error: "Nothing to update" })
  })

  it("库里是支持集外的历史值时，meDto 读作默认 zh", async () => {
    const ctx = await initializedContext()
    const cookie = await adminSession(ctx.env)
    // 模拟人工改库/历史脏值：读出口必须归一，不能让前端拿到未知语言码。
    ctx.db.db
      .prepare("UPDATE ciki_users SET language = 'fr' WHERE email = ?")
      .run(ADMIN)
    expect((await me(ctx.env, cookie)).language).toBe("zh")
  })
})

describe("验证码邮件按账号语言出文案", () => {
  it("重发注册验证码：英文入参注册的账号收英文，默认账号收中文", async () => {
    const ctx = await initializedContext()
    await adminSession(ctx.env, ADMIN)
    await enableSmtpConfig(ctx.env)
    await registerWith(ctx, { email: USER, language: "en" })
    await registerWith(ctx, { email: "zh@example.com" })
    clearEmailCooldown(ctx)

    const cases: Array<[string, string]> = [
      [USER, EN_SUBJECTS.register_verify],
      ["zh@example.com", ZH_SUBJECTS.register_verify]
    ]
    for (const [email, subject] of cases) {
      const executionCtx = new TestExecutionContext()
      const res = await jsonRequest(
        ctx.env,
        "POST",
        "/api/auth/email/resend",
        { email },
        undefined,
        executionCtx
      )
      expect(res.status).toBe(200)
      await executionCtx.settle()
      expect(lastMessage(email).subject).toBe(subject)
    }
  })

  it("密码重置按账号语言：英文账号收英文，中文账号逐字不变", async () => {
    const ctx = await initializedContext()
    const admin = await adminSession(ctx.env, ADMIN)
    await userSession(ctx.env, admin, USER)

    const zhCtx = new TestExecutionContext()
    const zhForgot = await jsonRequest(
      ctx.env,
      "POST",
      "/api/auth/password/forgot",
      { email: USER },
      undefined,
      zhCtx
    )
    expect(zhForgot.status).toBe(200)
    await zhCtx.settle()
    expect(lastMessage(USER).subject).toBe(ZH_SUBJECTS.password_reset)
    expect(lastMessage(USER).html).toContain(
      "你正在重置 Ciki 账号的密码，验证码是："
    )

    await switchLanguage(ctx, admin, "en")
    const enCtx = new TestExecutionContext()
    const enForgot = await jsonRequest(
      ctx.env,
      "POST",
      "/api/auth/password/forgot",
      { email: ADMIN },
      undefined,
      enCtx
    )
    expect(enForgot.status).toBe(200)
    await enCtx.settle()
    const message = lastMessage(ADMIN)
    expect(message.subject).toBe(EN_SUBJECTS.password_reset)
    expect(message.html).toContain(
      "You are resetting the password for your Ciki account."
    )
    expect(message.html).toContain("valid for 10 minutes")
  })

  it("2fa_enable 与 2fa_login 都按账号语言发信", async () => {
    const ctx = await initializedContext()
    const admin = await adminSession(ctx.env, ADMIN)
    await enableSmtpConfig(ctx.env)
    await switchLanguage(ctx, admin, "en")

    const sent = await jsonRequest(
      ctx.env,
      "POST",
      "/api/auth/2fa/email-otp/send-verify",
      undefined,
      admin
    )
    expect(sent.status).toBe(200)
    const enableMessage = lastMessage(ADMIN)
    expect(enableMessage.subject).toBe(EN_SUBJECTS["2fa_enable"])
    expect(enableMessage.html).toContain(
      "You are turning on email verification codes for your Ciki account."
    )

    const enabled = await jsonRequest(
      ctx.env,
      "POST",
      "/api/auth/2fa/email-otp/enable",
      { code: codeOf(enableMessage) },
      admin
    )
    expect(enabled.status).toBe(200)

    const login = await jsonRequest(ctx.env, "POST", "/api/auth/login", {
      email: ADMIN,
      password: PASSWORD
    })
    expect(login.status).toBe(200)
    const loginBody = (await login.json()) as {
      requires2fa?: boolean
      tempToken?: string
    }
    expect(loginBody.requires2fa).toBe(true)

    const loginCode = await jsonRequest(
      ctx.env,
      "POST",
      "/api/auth/2fa/email-otp/send-login",
      { tempToken: loginBody.tempToken }
    )
    expect(loginCode.status).toBe(200)
    const loginMessage = lastMessage(ADMIN)
    expect(loginMessage.subject).toBe(EN_SUBJECTS["2fa_login"])
    expect(loginMessage.html).toContain(
      "You are signing in to Ciki with an email code."
    )
  })
})

describe("中文文案逐字保留", () => {
  it("四类中文主题不变；带/不带开场句两种 HTML 与现网逐字一致", async () => {
    const ctx = await initializedContext()
    await enableSmtpConfig(ctx.env)

    for (const purpose of Object.keys(ZH_SUBJECTS) as Purpose[]) {
      sendSmtpMessageMock.mockClear()
      const sent = await sendEmailCodeMessage(ctx.env, {
        to: "copy@example.com",
        code: "123456",
        purpose,
        language: "zh"
      })
      expect(sent.success).toBe(true)
      expect(lastMessage("copy@example.com").subject).toBe(ZH_SUBJECTS[purpose])
    }

    sendSmtpMessageMock.mockClear()
    await sendEmailCodeMessage(ctx.env, {
      to: "copy@example.com",
      code: "123456",
      purpose: "password_reset",
      language: "zh"
    })
    expect(lastMessage("copy@example.com").html).toBe(
      "<p>你正在重置 Ciki 账号的密码，验证码是：</p>" +
        '<p style="font-size:24px;font-weight:bold;letter-spacing:4px">123456</p>' +
        "<p>验证码 10 分钟内有效，且只能使用一次。若非本人操作，请忽略本邮件。</p>"
    )

    sendSmtpMessageMock.mockClear()
    await sendEmailCodeMessage(ctx.env, {
      to: "copy@example.com",
      code: "123456",
      purpose: "register_verify",
      language: "zh"
    })
    expect(lastMessage("copy@example.com").html).toBe(
      "<p>验证码是：</p>" +
        '<p style="font-size:24px;font-weight:bold;letter-spacing:4px">123456</p>' +
        "<p>验证码 10 分钟内有效，只能使用一次。</p>"
    )
  })
})
