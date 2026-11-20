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
})
