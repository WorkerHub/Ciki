import { describe, expect, it } from "vitest"
import {
  bindingForTempToken,
  consumeEmailCodeSendLimits,
  consumeEmailCodeVerifyLimits,
  consumePasswordResetSubmitLimit,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_TTL_SECONDS,
  generateEmailCode,
  hashEmailCode,
  issueEmailCode,
  resetEmailCodeVerifyCounter,
  verifyEmailCode
} from "../src/core/email-code"
import { getTablePrefix } from "../src/lib/table-prefix"
import { initializedContext } from "./support/app"

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  )
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function queryCodes(
  db: Awaited<ReturnType<typeof initializedContext>>["db"],
  userId: string
) {
  return db.db
    .prepare("SELECT * FROM ciki_email_codes WHERE user_id = ?")
    .all(userId) as Array<{
    user_id: string
    purpose: string
    binding: string
    code_hash: string
    attempts: number
    created_at: number
    expires_at: number
  }>
}

async function countRow(
  db: Awaited<ReturnType<typeof initializedContext>>["db"],
  action: string,
  account: string,
  ip = ""
): Promise<number> {
  const row = db.db
    .prepare(
      "SELECT count FROM ciki_auth_counters WHERE action = ? AND account = ? AND ip = ?"
    )
    .get(action, account, ip) as { count: number } | undefined
  return row?.count ?? 0
}

const USER = "user-1"

describe("验证码：生成与哈希", () => {
  it("6 位数字、范围 100000–999999", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i += 1) {
      const code = generateEmailCode()
      expect(code).toMatch(/^\d{6}$/)
      const value = Number(code)
      expect(value).toBeGreaterThanOrEqual(100000)
      expect(value).toBeLessThanOrEqual(999999)
      seen.add(code)
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  it("code_hash = SHA-256('<purpose>:<userId>:<code>')，binding = SHA-256(tempToken)", async () => {
    const expected = await sha256Hex("password_reset:user-1:123456")
    expect(await hashEmailCode("password_reset", "user-1", "123456")).toBe(
      expected
    )
    expect(await bindingForTempToken("temp-token")).toBe(
      await sha256Hex("temp-token")
    )
  })
})

describe("验证码：下发、校验与消费", () => {
  it("落库只有哈希：TTL 600 秒、attempts=0、明文码不出现在库里", async () => {
    const { env, db } = await initializedContext()
    const prefix = getTablePrefix(env)
    const issued = await issueEmailCode(env.DB, prefix, {
      userId: USER,
      purpose: "password_reset"
    })

    const rows = queryCodes(db, USER)
    expect(rows).toHaveLength(1)
    expect(rows[0].purpose).toBe("password_reset")
    expect(rows[0].binding).toBe("")
    expect(rows[0].attempts).toBe(0)
    expect(rows[0].code_hash).toBe(
      await hashEmailCode("password_reset", USER, issued.code)
    )
    expect(rows[0].code_hash).not.toContain(issued.code)
    expect(rows[0].expires_at - rows[0].created_at).toBe(EMAIL_CODE_TTL_SECONDS)
    expect(JSON.stringify(rows[0])).not.toContain(issued.code)
  })

  it("正确码单次消费；重放失败", async () => {
    const { env, db } = await initializedContext()
    const prefix = getTablePrefix(env)
    const issued = await issueEmailCode(env.DB, prefix, {
      userId: USER,
      purpose: "password_reset"
    })

    expect(
      await verifyEmailCode(env.DB, prefix, {
        userId: USER,
        purpose: "password_reset",
        code: issued.code
      })
    ).toBe(true)
    expect(queryCodes(db, USER)).toHaveLength(0)
    expect(
      await verifyEmailCode(env.DB, prefix, {
        userId: USER,
        purpose: "password_reset",
        code: issued.code
      })
    ).toBe(false)
  })

  it("并发消费同一枚码：只有一个请求成功", async () => {
    const { env } = await initializedContext()
    const prefix = getTablePrefix(env)
    const issued = await issueEmailCode(env.DB, prefix, {
      userId: USER,
      purpose: "2fa_enable"
    })
    const results = await Promise.all([
      verifyEmailCode(env.DB, prefix, {
        userId: USER,
        purpose: "2fa_enable",
        code: issued.code
      }),
      verifyEmailCode(env.DB, prefix, {
        userId: USER,
        purpose: "2fa_enable",
        code: issued.code
      })
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it("错码 attempts+1；第 5 次错误删除该行并作废", async () => {
    const { env, db } = await initializedContext()
    const prefix = getTablePrefix(env)
    const issued = await issueEmailCode(env.DB, prefix, {
      userId: USER,
      purpose: "2fa_login",
      binding: await bindingForTempToken("temp")
    })

    for (let attempt = 1; attempt <= EMAIL_CODE_MAX_ATTEMPTS; attempt += 1) {
      const ok = await verifyEmailCode(env.DB, prefix, {
        userId: USER,
        purpose: "2fa_login",
        binding: await bindingForTempToken("temp"),
        // 000000 永远不是合法生成的码（生成范围 100000–999999）。
        code: "000000"
      })
      expect(ok).toBe(false)
      if (attempt < EMAIL_CODE_MAX_ATTEMPTS) {
        const rows = queryCodes(db, USER)
        expect(rows).toHaveLength(1)
        expect(rows[0].attempts).toBe(attempt)
      }
    }
    expect(queryCodes(db, USER)).toHaveLength(0)
    // 作废后即使拿正确的码也不能再用。
    expect(
      await verifyEmailCode(env.DB, prefix, {
        userId: USER,
        purpose: "2fa_login",
        binding: await bindingForTempToken("temp"),
        code: issued.code
      })
    ).toBe(false)
  })

  it("过期码校验失败，且不增加 attempts", async () => {
    const { env, db } = await initializedContext()
    const prefix = getTablePrefix(env)
    const issued = await issueEmailCode(env.DB, prefix, {
      userId: USER,
      purpose: "password_reset"
    })
    db.db
      .prepare(
        "UPDATE ciki_email_codes SET expires_at = ? WHERE user_id = ? AND purpose = ?"
      )
      .run(Math.floor(Date.now() / 1000) - 1, USER, "password_reset")

    expect(
      await verifyEmailCode(env.DB, prefix, {
        userId: USER,
        purpose: "password_reset",
        code: issued.code
      })
    ).toBe(false)
    const rows = queryCodes(db, USER)
    expect(rows).toHaveLength(1)
    expect(rows[0].attempts).toBe(0)
  })

  it("binding 区隔：同一用户+用途的两枚码互不通用（2fa_login 按 tempToken 绑定）", async () => {
    const { env } = await initializedContext()
    const prefix = getTablePrefix(env)
    const bindingA = await bindingForTempToken("temp-a")
    const bindingB = await bindingForTempToken("temp-b")
    const issued = await issueEmailCode(env.DB, prefix, {
      userId: USER,
      purpose: "2fa_login",
      binding: bindingA
    })

    expect(
      await verifyEmailCode(env.DB, prefix, {
        userId: USER,
        purpose: "2fa_login",
        binding: bindingB,
        code: issued.code
      })
    ).toBe(false)
    expect(
      await verifyEmailCode(env.DB, prefix, {
        userId: USER,
        purpose: "2fa_login",
        binding: bindingA,
        code: issued.code
      })
    ).toBe(true)
  })

  it("重发覆盖旧码：旧码立即失效，新码可用；发码顺带清过期行", async () => {
    const { env, db } = await initializedContext()
    const prefix = getTablePrefix(env)
    const first = await issueEmailCode(env.DB, prefix, {
      userId: USER,
      purpose: "password_reset"
    })

    // 另一用户的过期行：下一次发码时被顺带清掉。
    db.db
      .prepare(
        `INSERT INTO ciki_email_codes
          (user_id, purpose, binding, code_hash, attempts, created_at, expires_at)
         VALUES ('stale-user', 'password_reset', '', 'stale-hash', 0, 1, 2)`
      )
      .run()

    const second = await issueEmailCode(env.DB, prefix, {
      userId: USER,
      purpose: "password_reset"
    })
    expect(second.code).not.toBe(first.code)
    expect(
      db.db
        .prepare(
          "SELECT COUNT(*) AS count FROM ciki_email_codes WHERE user_id = 'stale-user'"
        )
        .get() as { count: number }
    ).toEqual({ count: 0 })

    expect(
      await verifyEmailCode(env.DB, prefix, {
        userId: USER,
        purpose: "password_reset",
        code: first.code
      })
    ).toBe(false)
    expect(
      await verifyEmailCode(env.DB, prefix, {
        userId: USER,
        purpose: "password_reset",
        code: second.code
      })
    ).toBe(true)
  })
})

describe("验证码：限频（counters.ts）", () => {
  it("发码顺序 cd → send → send_ip：60 秒内第二次是 cooldown", async () => {
    const { env, db } = await initializedContext()
    const prefix = getTablePrefix(env)
    const options = {
      purpose: "password_reset" as const,
      accountKey: "a@example.com",
      ip: "203.0.113.9"
    }

    expect(await consumeEmailCodeSendLimits(env.DB, prefix, options)).toEqual({
      allowed: true
    })
    const second = await consumeEmailCodeSendLimits(env.DB, prefix, options)
    expect(second.allowed).toBe(false)
    if (!second.allowed) {
      expect(second.scope).toBe("cooldown")
      expect(second.retryAfter).toBeGreaterThan(0)
    }
    expect(
      await countRow(db, "email_code_cd", "password_reset:a@example.com")
    ).toBe(2)
  })

  it("账号+用途每小时第 6 封 429 级（scope=send），其它用途不受影响", async () => {
    const { env, db } = await initializedContext()
    const prefix = getTablePrefix(env)
    const options = {
      purpose: "password_reset" as const,
      accountKey: "a@example.com",
      ip: "203.0.113.9"
    }
    const clearCooldown = () =>
      db.db
        .prepare(
          "DELETE FROM ciki_auth_counters WHERE action = 'email_code_cd'"
        )
        .run()

    for (let i = 0; i < 5; i += 1) {
      expect(await consumeEmailCodeSendLimits(env.DB, prefix, options)).toEqual(
        {
          allowed: true
        }
      )
      await clearCooldown()
    }
    const sixth = await consumeEmailCodeSendLimits(env.DB, prefix, options)
    expect(sixth.allowed).toBe(false)
    if (!sixth.allowed) expect(sixth.scope).toBe("send")

    // 另一个用途有独立配额。
    await clearCooldown()
    expect(
      await consumeEmailCodeSendLimits(env.DB, prefix, {
        ...options,
        purpose: "2fa_login"
      })
    ).toEqual({ allowed: true })
  })

  it("每 IP 每小时 20 封：换账号也挡（scope=send_ip）", async () => {
    const { env, db } = await initializedContext()
    const prefix = getTablePrefix(env)
    // 只清冷却/账号配额，保留 send_ip 计数让它累加。
    const clearAccountCounters = () =>
      db.db
        .prepare(
          "DELETE FROM ciki_auth_counters WHERE action IN ('email_code_cd', 'email_code_send')"
        )
        .run()

    for (let i = 0; i < 20; i += 1) {
      await clearAccountCounters()
      expect(
        await consumeEmailCodeSendLimits(env.DB, prefix, {
          purpose: "password_reset",
          accountKey: `user-${i}@example.com`,
          ip: "203.0.113.9"
        })
      ).toEqual({ allowed: true })
    }
    await clearAccountCounters()

    const blocked = await consumeEmailCodeSendLimits(env.DB, prefix, {
      purpose: "password_reset",
      accountKey: "fresh@example.com",
      ip: "203.0.113.9"
    })
    expect(blocked.allowed).toBe(false)
    if (!blocked.allowed) expect(blocked.scope).toBe("send_ip")
  })

  it("校验限频：账号 5 次/10 分钟，第 6 次拒绝；成功后清零", async () => {
    const { env, db } = await initializedContext()
    const prefix = getTablePrefix(env)
    const options = {
      purpose: "password_reset" as const,
      accountKey: "a@example.com",
      ip: "203.0.113.9"
    }

    for (let i = 0; i < 5; i += 1) {
      expect(
        await consumeEmailCodeVerifyLimits(env.DB, prefix, options)
      ).toEqual({ allowed: true })
    }
    const sixth = await consumeEmailCodeVerifyLimits(env.DB, prefix, options)
    expect(sixth.allowed).toBe(false)
    if (!sixth.allowed) expect(sixth.retryAfter).toBeGreaterThan(0)

    await resetEmailCodeVerifyCounter(env.DB, prefix, {
      purpose: "password_reset",
      accountKey: "a@example.com"
    })
    expect(
      await countRow(db, "email_code_verify", "password_reset:a@example.com")
    ).toBe(0)
    expect(await consumeEmailCodeVerifyLimits(env.DB, prefix, options)).toEqual(
      {
        allowed: true
      }
    )
  })

  it("每 IP 校验 20 次/10 分钟：第 21 次拒绝", async () => {
    const { env } = await initializedContext()
    const prefix = getTablePrefix(env)
    for (let i = 0; i < 20; i += 1) {
      expect(
        await consumeEmailCodeVerifyLimits(env.DB, prefix, {
          purpose: "password_reset",
          accountKey: `user-${i}@example.com`,
          ip: "198.51.100.7"
        })
      ).toEqual({ allowed: true })
    }
    const blocked = await consumeEmailCodeVerifyLimits(env.DB, prefix, {
      purpose: "password_reset",
      accountKey: "another@example.com",
      ip: "198.51.100.7"
    })
    expect(blocked.allowed).toBe(false)
  })

  it("设密提交限流（password_reset_submit）：userId+IP 5 次/5 分钟，无 userId 时按空账号单独计数", async () => {
    const { env, db } = await initializedContext()
    const prefix = getTablePrefix(env)
    const options = { userId: USER, ip: "203.0.113.9" }

    for (let i = 0; i < 5; i += 1) {
      expect(
        await consumePasswordResetSubmitLimit(env.DB, prefix, options)
      ).toEqual({ allowed: true })
    }
    const blocked = await consumePasswordResetSubmitLimit(
      env.DB,
      prefix,
      options
    )
    expect(blocked.allowed).toBe(false)
    if (!blocked.allowed) expect(blocked.retryAfter).toBeGreaterThan(0)
    expect(
      await countRow(db, "password_reset_submit", USER, "203.0.113.9")
    ).toBe(6)

    // 换 IP 独立计数。
    expect(
      await consumePasswordResetSubmitLimit(env.DB, prefix, {
        userId: USER,
        ip: "198.51.100.1"
      })
    ).toEqual({ allowed: true })
    // 解析不出用户时 account 为空串，与 userId 的计数互不影响。
    expect(
      await consumePasswordResetSubmitLimit(env.DB, prefix, {
        userId: null,
        ip: "198.51.100.1"
      })
    ).toEqual({ allowed: true })
  })
})
