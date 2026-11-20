/**
 * 邮件子系统三态收敛测试（backend 标准 §5.5A）：
 * - provider 单选生效：smtp 与 resend 各以 stub 跑通成功与错误路径；
 * - `email_configured` 的单一判定；
 * - 凭据读回脱敏、保存留空不改；
 * - 测试邮件把 provider 原文错误回显（`detail`）；
 * - 管理面设置接口 `GET/PUT/PATCH /api/admin/settings` 对 email 块的支持与脱敏；
 * - 存量过渡接口 `POST /api/admin/system/smtp/test` 兼容性。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { sendSmtpMessageMock } = vi.hoisted(() => ({
  sendSmtpMessageMock: vi.fn(async (_config: unknown, _message: unknown) => ({
    success: true
  }))
}))

vi.mock("../src/services/smtp-transport", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/smtp-transport")>()
  return { ...actual, sendSmtpMessage: sendSmtpMessageMock }
})

import { DEFAULT_SITE_NAME } from "../src/core/identity"
import { decryptSecret, encryptSecret } from "../src/core/secret-box"
import { parseEmailLanguage, renderTestEmail } from "../src/locales/email"
import { getTablePrefix } from "../src/lib/table-prefix"
import {
  isEmailConfigured,
  readEmailSettings,
  readStoredResendConfig,
  readStoredSmtpConfig,
  RESEND_API_KEY_AAD,
  saveEmailSettings,
  sendEmail,
  SMTP_PASSWORD_AAD
} from "../src/services/email"
import type { Env } from "../src/types"
import {
  adminSession,
  configureResend,
  initializedContext,
  jsonRequest,
  stubResend,
  writeSetting,
  type FetchStub
} from "./support/app"

let stub: FetchStub | null = null

beforeEach(() => {
  sendSmtpMessageMock.mockReset()
  sendSmtpMessageMock.mockResolvedValue({ success: true })
})

afterEach(() => {
  stub?.restore()
  stub = null
})

async function configureSmtp(env: Env): Promise<void> {
  const prefix = getTablePrefix(env)
  await writeSetting(env.DB, prefix, "email_provider", "smtp")
  const password = await encryptSecret(
    env.ENCRYPTION_KEY,
    "smtp-secret",
    SMTP_PASSWORD_AAD
  )
  await writeSetting(
    env.DB,
    prefix,
    "smtp_config",
    JSON.stringify({
      host: "smtp.example.com",
      port: 587,
      encryption: "starttls",
      username: "mailer@example.com",
      password,
      from: "noreply@example.com",
      fromName: "Ciki"
    })
  )
}

describe("email_configured 单一判断", () => {
  it("provider=none / smtp 缺 host / resend 缺 api_key 都算未配置", async () => {
    const { env } = await initializedContext()
    const prefix = getTablePrefix(env)

    expect(await isEmailConfigured(env)).toBe(false)

    await writeSetting(env.DB, prefix, "email_provider", "smtp")
    await writeSetting(
      env.DB,
      prefix,
      "smtp_config",
      JSON.stringify({ host: "" })
    )
    expect(await isEmailConfigured(env)).toBe(false)

    await writeSetting(env.DB, prefix, "email_provider", "resend")
    await writeSetting(
      env.DB,
      prefix,
      "resend_config",
      JSON.stringify({ api_key: "" })
    )
    expect(await isEmailConfigured(env)).toBe(false)

    // resend 有 api_key 但 from 为空或非法，依然算未配置
    await writeSetting(
      env.DB,
      prefix,
      "resend_config",
      JSON.stringify({ api_key: "re_key_test", from: "" })
    )
    expect(await isEmailConfigured(env)).toBe(false)

    await writeSetting(
      env.DB,
      prefix,
      "resend_config",
      JSON.stringify({ api_key: "re_key_test", from: "not-an-email" })
    )
    expect(await isEmailConfigured(env)).toBe(false)

    await configureResend(env)
    expect(await isEmailConfigured(env)).toBe(true)

    await configureSmtp(env)
    expect(await isEmailConfigured(env)).toBe(true)
  })
})

describe("发送通道", () => {
  it("resend：成功与错误原文回显", async () => {
    const { env } = await initializedContext()
    await configureResend(env)

    stub = stubResend()
    const ok = await sendEmail(env, {
      to: "user@example.test",
      subject: "hi",
      html: "<p>hi</p>",
      text: "hi"
    })
    expect(ok).toEqual({ success: true })
    expect(stub.sent[0]).toMatchObject({
      to: "user@example.test",
      subject: "hi",
      text: "hi",
      from: `${DEFAULT_SITE_NAME} <noreply@example.com>`
    })
    stub.restore()

    stub = stubResend({
      fail: { status: 422, body: '{"message":"invalid from"}' }
    })
    const failed = await sendEmail(env, {
      to: "user@example.test",
      subject: "hi",
      html: "<p>hi</p>"
    })
    expect(failed.success).toBe(false)
    expect(failed.error).toContain("invalid from")
  })

  it("smtp：走传输层，成功与错误都原样返回", async () => {
    const { env } = await initializedContext()
    await configureSmtp(env)

    const ok = await sendEmail(env, {
      to: "user@example.test",
      subject: "hi",
      html: "<p>hi</p>",
      text: "hi"
    })
    expect(ok).toEqual({ success: true })
    expect(sendSmtpMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.example.com",
        port: 587,
        username: "mailer@example.com",
        password: "smtp-secret",
        from: "noreply@example.com",
        fromName: "Ciki"
      }),
      expect.objectContaining({
        to: "user@example.test",
        subject: "hi"
      })
    )

    sendSmtpMessageMock.mockResolvedValueOnce({
      success: false,
      error: "550 mailbox unavailable"
    })
    const failed = await sendEmail(env, {
      to: "user@example.test",
      subject: "hi",
      html: "<p>hi</p>"
    })
    expect(failed.success).toBe(false)
    expect(failed.error).toContain("550 mailbox unavailable")
  })

  it("provider 单选：两套配置都在时只走生效的那一个", async () => {
    const { env } = await initializedContext()
    await configureSmtp(env)
    const prefix = getTablePrefix(env)
    await writeSetting(
      env.DB,
      prefix,
      "resend_config",
      JSON.stringify({ api_key: "re_key", from: "a@b.c" })
    )
    stub = stubResend()

    await sendEmail(env, { to: "user@example.test", subject: "s", html: "h" })
    expect(sendSmtpMessageMock).toHaveBeenCalledTimes(1)
    expect(stub.called).toBe(false)

    // 切到 resend
    await writeSetting(env.DB, prefix, "email_provider", "resend")
    await configureResend(env)
    sendSmtpMessageMock.mockClear()
    stub.sent.length = 0

    await sendEmail(env, { to: "user@example.test", subject: "s", html: "h" })
    expect(stub.sent).toHaveLength(1)
    expect(sendSmtpMessageMock).not.toHaveBeenCalled()
  })

  it("收件人非法直接失败，不发请求", async () => {
    const { env } = await initializedContext()
    await configureSmtp(env)
    const result = await sendEmail(env, {
      to: "not-an-email",
      subject: "s",
      html: "h"
    })
    expect(result.success).toBe(false)
    expect(sendSmtpMessageMock).not.toHaveBeenCalled()
  })
})

describe("配置读写与脱敏", () => {
  it("读回只给 passwordSet/apiKeySet，密钥本体不出现在任何视图里", async () => {
    const { env } = await initializedContext()
    const saved = await saveEmailSettings(env, {
      provider: "smtp",
      smtp: {
        host: "smtp.example.com",
        port: 465,
        encryption: "tls",
        username: "mailer@example.com",
        password: "smtp-secret",
        from: "noreply@example.com",
        fromName: "Ciki"
      }
    })
    expect(saved.ok).toBe(true)

    const view = await readEmailSettings(env)
    expect(view.provider).toBe("smtp")
    expect(view.smtp.passwordSet).toBe(true)
    expect(JSON.stringify(view)).not.toContain("smtp-secret")

    const savedResend = await saveEmailSettings(env, {
      provider: "resend",
      resend: {
        apiKey: "re_test_secret",
        from: "noreply@example.com",
        fromName: "Ciki"
      }
    })
    expect(savedResend.ok).toBe(true)

    const resendView = await readEmailSettings(env)
    expect(resendView.provider).toBe("resend")
    expect(resendView.resend.apiKeySet).toBe(true)
    expect(JSON.stringify(resendView)).not.toContain("re_test_secret")
  })

  it("保存时留空 = 不改已存凭据；切回 none 不清空配置", async () => {
    const { env } = await initializedContext()
    await saveEmailSettings(env, {
      provider: "smtp",
      smtp: {
        host: "smtp.example.com",
        password: "smtp-secret",
        from: "noreply@example.com"
      }
    })
    await saveEmailSettings(env, { smtp: { password: "" } })
    const storedSmtp = await readStoredSmtpConfig(env)
    expect(storedSmtp).not.toBeNull()
    expect(
      await decryptSecret(
        env.ENCRYPTION_KEY,
        storedSmtp!.password,
        SMTP_PASSWORD_AAD
      )
    ).toBe("smtp-secret")

    await saveEmailSettings(env, {
      provider: "resend",
      resend: { apiKey: "re_secret_123" }
    })
    await saveEmailSettings(env, { resend: { apiKey: "" } })
    const storedResend = await readStoredResendConfig(env)
    expect(storedResend).not.toBeNull()
    expect(
      await decryptSecret(
        env.ENCRYPTION_KEY,
        storedResend!.api_key,
        RESEND_API_KEY_AAD
      )
    ).toBe("re_secret_123")

    await saveEmailSettings(env, { provider: "none" })
    expect(await isEmailConfigured(env)).toBe(false)
    const afterSmtp = await readStoredSmtpConfig(env)
    expect(
      await decryptSecret(
        env.ENCRYPTION_KEY,
        afterSmtp!.password,
        SMTP_PASSWORD_AAD
      )
    ).toBe("smtp-secret")
    const afterResend = await readStoredResendConfig(env)
    expect(
      await decryptSecret(
        env.ENCRYPTION_KEY,
        afterResend!.api_key,
        RESEND_API_KEY_AAD
      )
    ).toBe("re_secret_123")
  })

  it("配置校验：非法邮箱、CR/LF、端口范围都拒绝", async () => {
    const { env } = await initializedContext()
    const badFrom = await saveEmailSettings(env, {
      smtp: { from: "not-an-email" }
    })
    expect(badFrom.ok).toBe(false)

    const injection = await saveEmailSettings(env, {
      smtp: { fromName: "x\r\nBcc: evil@example.test" }
    })
    expect(injection.ok).toBe(false)

    const badPort = await saveEmailSettings(env, { smtp: { port: 70_000 } })
    expect(badPort.ok).toBe(false)
  })

  it("凭据置空（null）：显式清空密文，不再加密为字面量 null", async () => {
    const { env } = await initializedContext()
    await saveEmailSettings(env, {
      provider: "smtp",
      smtp: {
        host: "smtp.example.com",
        password: "initial-password",
        from: "noreply@example.com"
      },
      resend: {
        apiKey: "initial-api-key",
        from: "noreply@example.com"
      }
    })

    let view = await readEmailSettings(env)
    expect(view.smtp.passwordSet).toBe(true)
    expect(view.resend.apiKeySet).toBe(true)

    // 传入 null 置空
    const res = await saveEmailSettings(env, {
      smtp: { password: null },
      resend: { apiKey: null }
    })
    expect(res.ok).toBe(true)

    view = await readEmailSettings(env)
    expect(view.smtp.passwordSet).toBe(false)
    expect(view.resend.apiKeySet).toBe(false)

    const storedSmtp = await readStoredSmtpConfig(env)
    expect(storedSmtp?.password).toBe("")

    const storedResend = await readStoredResendConfig(env)
    expect(storedResend?.api_key).toBe("")
  })

  it("字段类型守卫：非字符串/非期望类型打回 400 拒绝，不抛 500", async () => {
    const { env } = await initializedContext()
    const badPassword = await saveEmailSettings(env, {
      smtp: { password: 123 as unknown as string }
    })
    expect(badPassword.ok).toBe(false)
    expect(badPassword.error).toContain(
      "smtp.password must be a string or null"
    )

    const badApiKey = await saveEmailSettings(env, {
      resend: { apiKey: true as unknown as string }
    })
    expect(badApiKey.ok).toBe(false)
    expect(badApiKey.error).toContain("resend.apiKey must be a string or null")

    const badHost = await saveEmailSettings(env, {
      smtp: { host: 123 as unknown as string }
    })
    expect(badHost.ok).toBe(false)
    expect(badHost.error).toContain("smtp.host must be a string")

    const badUsername = await saveEmailSettings(env, {
      smtp: { username: {} as unknown as string }
    })
    expect(badUsername.ok).toBe(false)
    expect(badUsername.error).toContain("smtp.username must be a string")

    const badFromName = await saveEmailSettings(env, {
      smtp: { fromName: 456 as unknown as string }
    })
    expect(badFromName.ok).toBe(false)
    expect(badFromName.error).toContain("smtp.fromName must be a string")

    const badResendFrom = await saveEmailSettings(env, {
      resend: { from: 789 as unknown as string }
    })
    expect(badResendFrom.ok).toBe(false)
    expect(badResendFrom.error).toContain("resend.from must be a string")

    const badResendFromName = await saveEmailSettings(env, {
      resend: { fromName: [] as unknown as string }
    })
    expect(badResendFromName.ok).toBe(false)
    expect(badResendFromName.error).toContain(
      "resend.fromName must be a string"
    )
  })
})

describe("管理面发送测试邮件与设置管理", () => {
  it("未配置 → 409 EMAIL_NOT_CONFIGURED", async () => {
    const { env } = await initializedContext()
    const cookie = await adminSession(env)
    const res = await jsonRequest(
      env,
      "POST",
      "/api/admin/settings/test-email",
      { to: "user@example.test" },
      cookie
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe(
      "EMAIL_NOT_CONFIGURED"
    )
  })

  it("缺少/非法收件人 → 400 INVALID_EMAIL", async () => {
    const { env } = await initializedContext()
    const cookie = await adminSession(env)
    await configureResend(env)

    const resEmpty = await jsonRequest(
      env,
      "POST",
      "/api/admin/settings/test-email",
      { to: "" },
      cookie
    )
    expect(resEmpty.status).toBe(400)
    expect(((await resEmpty.json()) as { code: string }).code).toBe(
      "INVALID_EMAIL"
    )

    const resInvalid = await jsonRequest(
      env,
      "POST",
      "/api/admin/settings/test-email",
      { to: "not-an-email" },
      cookie
    )
    expect(resInvalid.status).toBe(400)
    expect(((await resInvalid.json()) as { code: string }).code).toBe(
      "INVALID_EMAIL"
    )
  })

  it("provider 报错 → 502 EMAIL_SEND_FAILED 且带 detail 原文", async () => {
    const { env } = await initializedContext()
    const cookie = await adminSession(env)
    await configureResend(env)
    stub = stubResend({
      fail: { status: 401, body: '{"message":"API key is invalid"}' }
    })

    const res = await jsonRequest(
      env,
      "POST",
      "/api/admin/settings/test-email",
      { to: "user@example.test" },
      cookie
    )
    expect(res.status).toBe(502)
    const body = (await res.json()) as { code: string; detail: string }
    expect(body.code).toBe("EMAIL_SEND_FAILED")
    expect(body.detail).toContain("API key is invalid")
  })

  it("成功 → 200 {success:true}", async () => {
    const { env } = await initializedContext()
    const cookie = await adminSession(env)
    await configureResend(env)
    stub = stubResend()

    const res = await jsonRequest(
      env,
      "POST",
      "/api/admin/settings/test-email",
      { to: "user@example.test" },
      cookie
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(stub.sent).toHaveLength(1)
    expect(stub.sent[0].subject).toBe("Ciki 测试邮件")
  })

  it("管理面保存配置后读回仍脱敏", async () => {
    const { env } = await initializedContext()
    const cookie = await adminSession(env)
    const put = await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      {
        email: {
          provider: "resend",
          resend: {
            apiKey: "re_live_key",
            from: "noreply@example.com",
            fromName: "Ciki"
          }
        }
      },
      cookie
    )
    expect(put.status).toBe(200)
    const get = await jsonRequest(
      env,
      "GET",
      "/api/admin/settings",
      undefined,
      cookie
    )
    expect(get.status).toBe(200)
    const body = (await get.json()) as {
      email: { configured: boolean; resend: { apiKeySet: boolean } }
    }
    expect(body.email.configured).toBe(true)
    expect(body.email.resend.apiKeySet).toBe(true)
    expect(JSON.stringify(body)).not.toContain("re_live_key")
  })

  it("HTTP 端点：null 置空凭据与非法类型 400 校验", async () => {
    const { env } = await initializedContext()
    const cookie = await adminSession(env)

    // 先存好凭据
    await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      {
        email: {
          provider: "resend",
          resend: {
            apiKey: "re_live_key",
            from: "noreply@example.com"
          },
          smtp: {
            host: "smtp.example.com",
            password: "smtp-pass",
            from: "noreply@example.com"
          }
        }
      },
      cookie
    )

    // 非法类型 400
    const badRes = await jsonRequest(
      env,
      "PATCH",
      "/api/admin/settings",
      { email: { smtp: { host: 123 } } },
      cookie
    )
    expect(badRes.status).toBe(400)
    expect(((await badRes.json()) as { code: string }).code).toBe(
      "EMAIL_CONFIG_INVALID"
    )

    const badSecretRes = await jsonRequest(
      env,
      "PATCH",
      "/api/admin/settings",
      { email: { resend: { apiKey: 123 } } },
      cookie
    )
    expect(badSecretRes.status).toBe(400)
    expect(((await badSecretRes.json()) as { code: string }).code).toBe(
      "EMAIL_CONFIG_INVALID"
    )

    // null 成功清空凭据
    const clearRes = await jsonRequest(
      env,
      "PATCH",
      "/api/admin/settings",
      {
        email: {
          smtp: { password: null },
          resend: { apiKey: null }
        }
      },
      cookie
    )
    expect(clearRes.status).toBe(200)

    const view = await readEmailSettings(env)
    expect(view.smtp.passwordSet).toBe(false)
    expect(view.resend.apiKeySet).toBe(false)
  })
})

describe("邮件多语言解析 parseEmailLanguage", () => {
  it("支持集内语言正确解析并支持归一化", () => {
    expect(parseEmailLanguage("zh")).toBe("zh")
    expect(parseEmailLanguage("en")).toBe("en")
    expect(parseEmailLanguage(" ZH ")).toBe("zh")
    expect(parseEmailLanguage("En")).toBe("en")
  })

  it("非法或不支持的语言返回 null", () => {
    expect(parseEmailLanguage("fr")).toBeNull()
    expect(parseEmailLanguage("")).toBeNull()
    expect(parseEmailLanguage(null)).toBeNull()
    expect(parseEmailLanguage(undefined)).toBeNull()
    expect(parseEmailLanguage(123)).toBeNull()
  })

  it("renderTestEmail 本地化内容正确生成", () => {
    const zh = renderTestEmail("zh", "2026-01-01T00:00:00.000Z")
    expect(zh.subject).toBe("Ciki 测试邮件")
    expect(zh.html).toContain("这是一封测试邮件。收到它说明邮件配置可用。")
    expect(zh.html).toContain("2026-01-01T00:00:00.000Z")

    const en = renderTestEmail("en", "2026-01-01T00:00:00.000Z")
    expect(en.subject).toBe("Ciki test email")
    expect(en.html).toContain(
      "This is a test email. Receiving it means the mail configuration works."
    )
    expect(en.html).toContain("2026-01-01T00:00:00.000Z")
  })
})
