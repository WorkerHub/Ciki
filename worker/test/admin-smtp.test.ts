import { beforeEach, describe, expect, it, vi } from "vitest"
import { decryptSecret } from "../src/core/secret-box"
import { SMTP_CONFIG_KEY, SMTP_PASSWORD_AAD } from "../src/services/email"
import type { TestContext } from "./support/app"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  TEST_ENCRYPTION_KEY,
  userSession
} from "./support/app"

const { sendSmtpMessageMock } = vi.hoisted(() => ({
  sendSmtpMessageMock: vi.fn()
}))

// 传输层（cloudflare:sockets）在 Node 里不可用：路由级测试只关心 email.ts
// 如何读配置、解密、脱敏与映射状态码，SMTP 会话本身由 smtp.test.ts 用假 socket 覆盖。
vi.mock("../src/services/smtp-transport", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/smtp-transport")>()
  return { ...actual, sendSmtpMessage: sendSmtpMessageMock }
})

const SMTP_PASSWORD = "Smtp-Pass-123"
const VALID_CONFIG = {
  host: "smtp.example.com",
  port: 587,
  encryption: "starttls",
  username: "mailer@example.com",
  password: SMTP_PASSWORD,
  from: "noreply@example.com",
  fromName: "Ciki"
}

function smtpGet(env: TestContext["env"], cookie: string) {
  return jsonRequest(env, "GET", "/api/admin/system/smtp", undefined, cookie)
}

function smtpPut(env: TestContext["env"], cookie: string, body: unknown) {
  return jsonRequest(env, "PUT", "/api/admin/system/smtp", body, cookie)
}

function smtpTest(env: TestContext["env"], cookie: string, body?: unknown) {
  return jsonRequest(env, "POST", "/api/admin/system/smtp/test", body, cookie)
}

function storedConfig(db: TestContext["db"]): {
  host: string
  port: number
  encryption: string
  username: string
  password: string
  from: string
  fromName: string
} {
  const row = db.db
    .prepare("SELECT value FROM ciki_system_settings WHERE key = ?")
    .get(SMTP_CONFIG_KEY) as { value: string }
  return JSON.parse(row.value)
}

beforeEach(() => {
  sendSmtpMessageMock.mockReset()
})

describe("SMTP 配置：读写与 emailConfigured", () => {
  it("GET：未配置时 config=null、emailConfigured=false，并同步到 auth/config 与 admin/settings", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const res = await smtpGet(env, admin)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ emailConfigured: false, config: null })

    const publicConfig = (await (
      await jsonRequest(env, "GET", "/api/auth/config")
    ).json()) as { emailConfigured: boolean }
    expect(publicConfig.emailConfigured).toBe(false)

    const settings = (await (
      await jsonRequest(env, "GET", "/api/admin/settings", undefined, admin)
    ).json()) as { emailConfigured: boolean }
    expect(settings.emailConfigured).toBe(false)
  })

  it("全部端点都是管理员专属：普通用户 403", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)

    expect((await smtpGet(env, user)).status).toBe(403)
    expect((await smtpPut(env, user, VALID_CONFIG)).status).toBe(403)
    expect((await smtpTest(env, user)).status).toBe(403)
  })

  it("字段校验失败一律 400 INVALID_SMTP_CONFIG", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const invalidBodies: unknown[] = [
      { ...VALID_CONFIG, host: "" },
      { ...VALID_CONFIG, host: "smtp:example.com" },
      { ...VALID_CONFIG, port: 0 },
      { ...VALID_CONFIG, port: 70000 },
      { ...VALID_CONFIG, encryption: "ssl" },
      { ...VALID_CONFIG, from: "not-an-email" },
      { ...VALID_CONFIG, fromName: "a".repeat(65) },
      { ...VALID_CONFIG, username: "mailer@example.com", password: undefined },
      { ...VALID_CONFIG, username: "", password: "only-password" },
      { ...VALID_CONFIG, password: 12345 }
    ]
    for (const body of invalidBodies) {
      const res = await smtpPut(env, admin, body)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ code: "INVALID_SMTP_CONFIG" })
    }

    // 非法请求不落库：仍然未配置。
    expect(await (await smtpGet(env, admin)).json()).toEqual({
      emailConfigured: false,
      config: null
    })
  })

  it("PUT：密码以 AES-GCM 密文落库；GET 只回 passwordSet；空串/掩码保留、null 清空、非空重加密", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)

    const created = await smtpPut(env, admin, VALID_CONFIG)
    expect(created.status).toBe(200)
    expect(await created.json()).toEqual({
      success: true,
      emailConfigured: true
    })

    const stored = storedConfig(db)
    expect(stored.host).toBe("smtp.example.com")
    expect(stored.port).toBe(587)
    expect(stored.encryption).toBe("starttls")
    expect(stored.username).toBe("mailer@example.com")
    expect(stored.from).toBe("noreply@example.com")
    expect(stored.fromName).toBe("Ciki")
    expect(stored.password).toMatch(/^v1\./)
    expect(stored.password).not.toContain(SMTP_PASSWORD)
    expect(
      await decryptSecret(
        TEST_ENCRYPTION_KEY,
        stored.password,
        SMTP_PASSWORD_AAD
      )
    ).toBe(SMTP_PASSWORD)
    // AAD 绑用途：换用其它 AAD 解不开（密文不能在 TOTP/其它场景间挪用）。
    await expect(
      decryptSecret(TEST_ENCRYPTION_KEY, stored.password, "ciki:totp:user-1")
    ).rejects.toThrow()

    const fetched = (await (await smtpGet(env, admin)).json()) as {
      emailConfigured: boolean
      config: Record<string, unknown>
    }
    expect(fetched.emailConfigured).toBe(true)
    expect(fetched.config).toEqual({
      host: "smtp.example.com",
      port: 587,
      encryption: "starttls",
      username: "mailer@example.com",
      passwordSet: true,
      from: "noreply@example.com",
      fromName: "Ciki"
    })
    expect(fetched.config.password).toBeUndefined()
    expect(JSON.stringify(fetched)).not.toContain(stored.password)
    expect(JSON.stringify(fetched)).not.toContain(SMTP_PASSWORD)

    // 空串 = 保留原密文（逐字节相同，不重新加密）。
    expect(
      (await smtpPut(env, admin, { ...VALID_CONFIG, password: "" })).status
    ).toBe(200)
    expect(storedConfig(db).password).toBe(stored.password)

    // 纯 • 掩码 = 保留原密文。
    expect(
      (await smtpPut(env, admin, { ...VALID_CONFIG, password: "••••••" }))
        .status
    ).toBe(200)
    expect(storedConfig(db).password).toBe(stored.password)

    // 非空 = 重新加密（新 IV），可解出新的明文。
    expect(
      (await smtpPut(env, admin, { ...VALID_CONFIG, password: "New-Pass-456" }))
        .status
    ).toBe(200)
    const rotated = storedConfig(db)
    expect(rotated.password).not.toBe(stored.password)
    expect(
      await decryptSecret(
        TEST_ENCRYPTION_KEY,
        rotated.password,
        SMTP_PASSWORD_AAD
      )
    ).toBe("New-Pass-456")

    // null = 清空（同时把 username 清空，满足“同时有/同时空”）。
    expect(
      (
        await smtpPut(env, admin, {
          ...VALID_CONFIG,
          username: "",
          password: null
        })
      ).status
    ).toBe(200)
    expect(storedConfig(db).password).toBe("")
    const cleared = (await (await smtpGet(env, admin)).json()) as {
      emailConfigured: boolean
      config: { passwordSet: boolean }
    }
    expect(cleared.config.passwordSet).toBe(false)
    // emailConfigured 只看非密字段，清空密码不影响判定。
    expect(cleared.emailConfigured).toBe(true)
  })

  it("损坏的 smtp_config：config=null、emailConfigured=false，测试邮件 503", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    db.db
      .prepare(
        "INSERT INTO ciki_system_settings (key, value, updated_at) VALUES (?, ?, ?)\n         ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(SMTP_CONFIG_KEY, "not-json", new Date().toISOString())

    expect(await (await smtpGet(env, admin)).json()).toEqual({
      emailConfigured: false,
      config: null
    })
    const test = await smtpTest(env, admin)
    expect(test.status).toBe(503)
    expect(await test.json()).toMatchObject({ code: "EMAIL_NOT_CONFIGURED" })
    expect(sendSmtpMessageMock).not.toHaveBeenCalled()
  })

  it("JSON 合法但非密字段非法：config 仍可回显，emailConfigured=false", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    db.db
      .prepare(
        "INSERT INTO ciki_system_settings (key, value, updated_at) VALUES (?, ?, ?)\n         ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(
        SMTP_CONFIG_KEY,
        JSON.stringify({ ...VALID_CONFIG, from: "broken" }),
        new Date().toISOString()
      )

    const body = (await (await smtpGet(env, admin)).json()) as {
      emailConfigured: boolean
      config: { host: string }
    }
    expect(body.emailConfigured).toBe(false)
    expect(body.config.host).toBe("smtp.example.com")
    expect((await smtpTest(env, admin)).status).toBe(503)
  })

  it("smtp_config 写入限流：5 分钟 10 次，第 11 次 429", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    for (let i = 0; i < 10; i += 1) {
      expect((await smtpPut(env, admin, VALID_CONFIG)).status).toBe(200)
    }
    const blocked = await smtpPut(env, admin, VALID_CONFIG)
    expect(blocked.status).toBe(429)
    const body = (await blocked.json()) as { code: string; retryAfter: number }
    expect(body.code).toBe("RATE_LIMITED")
    expect(body.retryAfter).toBeGreaterThan(0)
  })
})

describe("SMTP 测试邮件", () => {
  it("未配置 503 EMAIL_NOT_CONFIGURED（不消耗 smtp_test 配额、不连 SMTP）", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)

    const res = await smtpTest(env, admin)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: "Email delivery is not configured",
      code: "EMAIL_NOT_CONFIGURED"
    })
    expect(sendSmtpMessageMock).not.toHaveBeenCalled()
    expect(
      db.db
        .prepare(
          "SELECT COUNT(*) AS count FROM ciki_auth_counters WHERE action = 'smtp_test'"
        )
        .get()
    ).toEqual({ count: 0 })
  })

  it("只发给当前管理员自己：请求体里的任意 to 被忽略", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await smtpPut(env, admin, VALID_CONFIG)
    sendSmtpMessageMock.mockResolvedValue({ success: true })

    const res = await smtpTest(env, admin, {
      to: "attacker@example.com",
      subject: "hijack"
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })

    expect(sendSmtpMessageMock).toHaveBeenCalledTimes(1)
    const [config, message] = sendSmtpMessageMock.mock.calls[0] as [
      Record<string, unknown>,
      { to: string; subject: string; html: string }
    ]
    expect(message.to).toBe("admin@example.com")
    expect(message.to).not.toBe("attacker@example.com")
    expect(message.subject).toBe("Ciki SMTP 测试邮件")
    expect(config.host).toBe("smtp.example.com")
    expect(config.port).toBe(587)
    expect(config.encryption).toBe("starttls")
    expect(config.password).toBe(SMTP_PASSWORD)
  })

  it("发送失败 502 SMTP_SEND_FAILED，原因已脱敏", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await smtpPut(env, admin, VALID_CONFIG)
    sendSmtpMessageMock.mockResolvedValue({
      success: false,
      error: "535 5.7.8 bad credentials ***"
    })

    const res = await smtpTest(env, admin)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe("SMTP_SEND_FAILED")
    expect(body.error).toBe("SMTP send failed: 535 5.7.8 bad credentials ***")
  })

  it("ENCRYPTION_KEY 轮换后旧密文解不开：502 并给可操作原因，不回显密文/密码", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await smtpPut(env, admin, VALID_CONFIG)

    const previousKey = env.ENCRYPTION_KEY
    env.ENCRYPTION_KEY = btoa(
      String.fromCharCode(...new Uint8Array(32).fill(9))
    )
    const res = await smtpTest(env, admin)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe("SMTP_SEND_FAILED")
    expect(body.error).toContain("cannot be decrypted")
    expect(body.error).toContain("re-enter the SMTP password")
    expect(body.error).not.toContain(SMTP_PASSWORD)
    expect(body.error).not.toContain(previousKey)
    expect(sendSmtpMessageMock).not.toHaveBeenCalled()
  })

  it("测试邮件限流：5 分钟 5 次，第 6 次 429", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await smtpPut(env, admin, VALID_CONFIG)
    sendSmtpMessageMock.mockResolvedValue({ success: true })

    for (let i = 0; i < 5; i += 1) {
      expect((await smtpTest(env, admin)).status).toBe(200)
    }
    const blocked = await smtpTest(env, admin)
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ code: "RATE_LIMITED" })
  })
})

describe("账号变更时清理邮箱验证码", () => {
  async function userIdByEmail(
    env: TestContext["env"],
    admin: string,
    email: string
  ): Promise<string> {
    const users = (await (
      await jsonRequest(env, "GET", "/api/admin/users", undefined, admin)
    ).json()) as Array<{ id: string; email: string }>
    return users.find((user) => user.email === email)!.id
  }

  function insertCode(db: TestContext["db"], userId: string, purpose: string) {
    db.db
      .prepare(
        `INSERT INTO ciki_email_codes
          (user_id, purpose, binding, code_hash, attempts, created_at, expires_at)
         VALUES (?, ?, '', 'hash', 0, 1, 2)`
      )
      .run(userId, purpose)
  }

  function codeCount(db: TestContext["db"], userId: string): number {
    return (
      db.db
        .prepare(
          "SELECT COUNT(*) AS count FROM ciki_email_codes WHERE user_id = ?"
        )
        .get(userId) as { count: number }
    ).count
  }

  it("管理员改用户邮箱 → 旧邮箱的验证码全部作废", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await userSession(env, admin, "victim@example.com")
    const userId = await userIdByEmail(env, admin, "victim@example.com")
    insertCode(db, userId, "password_reset")
    insertCode(db, userId, "2fa_enable")
    expect(codeCount(db, userId)).toBe(2)

    const res = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${userId}`,
      { email: "renamed@example.com" },
      admin
    )
    expect(res.status).toBe(200)
    expect(codeCount(db, userId)).toBe(0)
  })

  it("删除用户 → 该用户的验证码一并删除", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await userSession(env, admin, "gone@example.com")
    const userId = await userIdByEmail(env, admin, "gone@example.com")
    insertCode(db, userId, "password_reset")

    const res = await jsonRequest(
      env,
      "DELETE",
      `/api/admin/users/${userId}`,
      undefined,
      admin
    )
    expect(res.status).toBe(200)
    expect(codeCount(db, userId)).toBe(0)
  })
})
