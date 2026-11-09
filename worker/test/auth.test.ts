import { describe, expect, it } from "vitest"
import {
  adminSession,
  cookieOf,
  initializedContext,
  jsonRequest,
  loginAs,
  register,
  userSession
} from "./support/app"

const PASSWORD = "Test" + "-Password" + "-123"
const NEW_PASSWORD = "Test" + "-Password" + "-456"
const WRONG_PASSWORD = "definitely-wrong"

/** 测试里要核对“库里只存哈希”，直接查 SQLite。 */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  )
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

describe("注册与审批", () => {
  it("首个用户是管理员、直接批准；第二个用户默认待批准", async () => {
    const { env } = await initializedContext()

    const first = await register(env, "admin@example.com")
    expect(first.status).toBe(201)
    expect(await first.json()).toEqual({
      success: true,
      approvalRequired: false
    })

    const cookie = await loginAs(env, "admin@example.com")
    const me = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, cookie)
    ).json()) as { role: string; approvalStatus: string }
    expect(me.role).toBe("admin")
    expect(me.approvalStatus).toBe("approved")

    const second = await register(env, "pending@example.com")
    expect(await second.json()).toEqual({
      success: true,
      approvalRequired: true
    })

    const blocked = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "pending@example.com",
      password: PASSWORD
    })
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toMatchObject({
      code: "ACCOUNT_PENDING_APPROVAL"
    })
  })

  it("管理员批准后才能登录；拒绝后登录报 ACCOUNT_REJECTED", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await register(env, "ok@example.com")
    await register(env, "no@example.com")

    const pending = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/admin/users?status=pending",
        undefined,
        admin
      )
    ).json()) as Array<{ id: string; email: string }>
    expect(pending.map((user) => user.email).sort()).toEqual([
      "no@example.com",
      "ok@example.com"
    ])

    const ok = pending.find((user) => user.email === "ok@example.com")!
    const no = pending.find((user) => user.email === "no@example.com")!
    await jsonRequest(
      env,
      "POST",
      `/api/admin/users/${ok.id}/approve`,
      undefined,
      admin
    )
    await jsonRequest(
      env,
      "POST",
      `/api/admin/users/${no.id}/reject`,
      undefined,
      admin
    )

    await expect(loginAs(env, "ok@example.com")).resolves.toContain(
      "ciki_session="
    )
    const rejected = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "no@example.com",
      password: PASSWORD
    })
    expect(rejected.status).toBe(403)
    expect(await rejected.json()).toMatchObject({ code: "ACCOUNT_REJECTED" })
  })

  it("注册开关关闭时 403", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      { registrationEnabled: false },
      admin
    )

    const res = await register(env, "late@example.com")
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "REGISTRATION_DISABLED" })
  })
})

describe("会话：不透明令牌、哈希落库、吊销", () => {
  it("Cookie 只对应 SHA-256，登录响应不回传令牌原文", async () => {
    const { env, db } = await initializedContext()
    const res = await jsonRequest(env, "POST", "/api/auth/register", {
      email: "admin@example.com",
      password: PASSWORD
    })
    expect(res.status).toBe(201)
    const login = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: PASSWORD
    })
    const cookie = cookieOf(login)!
    const token = cookie.split("=")[1]

    const row = db.db.prepare("SELECT token_hash FROM ciki_sessions").get() as {
      token_hash: string
    }
    expect(row.token_hash).toBe(await sha256Hex(token))
    expect(row.token_hash).not.toBe(token)
  })

  it("登出删行即吊销；refresh 轮换令牌、旧 Cookie 失效", async () => {
    const { env } = await initializedContext()
    const cookie = await adminSession(env)

    const refreshed = await jsonRequest(
      env,
      "POST",
      "/api/auth/refresh",
      undefined,
      cookie
    )
    expect(refreshed.status).toBe(200)
    const next = cookieOf(refreshed)!
    expect(next).not.toBe(cookie)

    const oldCookie = await jsonRequest(
      env,
      "GET",
      "/api/me",
      undefined,
      cookie
    )
    expect(oldCookie.status).toBe(401)
    const newCookie = await jsonRequest(env, "GET", "/api/me", undefined, next)
    expect(newCookie.status).toBe(200)

    const logout = await jsonRequest(
      env,
      "POST",
      "/api/auth/logout",
      undefined,
      next
    )
    expect(logout.status).toBe(200)
    const after = await jsonRequest(env, "GET", "/api/me", undefined, next)
    expect(after.status).toBe(401)
  })

  it("改密保留当前会话、吊销其它会话", async () => {
    const { env } = await initializedContext()
    const first = await adminSession(env)
    const second = await loginAs(env, "admin@example.com")

    const res = await jsonRequest(
      env,
      "PUT",
      "/api/me/password",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      first
    )
    expect(res.status).toBe(200)

    expect(
      (await jsonRequest(env, "GET", "/api/me", undefined, first)).status
    ).toBe(200)
    expect(
      (await jsonRequest(env, "GET", "/api/me", undefined, second)).status
    ).toBe(401)

    // 新密码可登录，旧密码不行
    const oldLogin = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: PASSWORD
    })
    expect(oldLogin.status).toBe(401)
    await expect(
      loginAs(env, "admin@example.com", NEW_PASSWORD)
    ).resolves.toContain("ciki_session=")
  })
})

describe("登录限流与失败锁定（D1 计数表为权威）", () => {
  it("同一邮箱连续 5 次失败后锁定 15 分钟，成功前也拦", async () => {
    const { env } = await initializedContext()
    await adminSession(env)

    for (let i = 0; i < 5; i += 1) {
      const res = await jsonRequest(env, "POST", "/api/auth/login", {
        email: "admin@example.com",
        password: WRONG_PASSWORD
      })
      expect(res.status).toBe(401)
    }

    const locked = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: PASSWORD
    })
    expect(locked.status).toBe(429)
    const body = (await locked.json()) as { code: string; retryAfter: number }
    expect(body.code).toBe("ACCOUNT_LOCKED")
    expect(body.retryAfter).toBeGreaterThan(0)
  })

  it("每 IP 10 次/5 分钟：第 11 次 429 RATE_LIMITED", async () => {
    const { env } = await initializedContext()
    for (let i = 0; i < 10; i += 1) {
      const res = await jsonRequest(env, "POST", "/api/auth/login", {
        email: `ghost-${i}@example.com`,
        password: WRONG_PASSWORD
      })
      expect(res.status).toBe(401)
    }
    const blocked = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "ghost-10@example.com",
      password: WRONG_PASSWORD
    })
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ code: "RATE_LIMITED" })
  })

  it("成功登录清零失败计数（锁定前不会误锁）", async () => {
    const { env } = await initializedContext()
    await adminSession(env)
    for (let i = 0; i < 4; i += 1) {
      await jsonRequest(env, "POST", "/api/auth/login", {
        email: "admin@example.com",
        password: WRONG_PASSWORD
      })
    }
    await loginAs(env, "admin@example.com")
    for (let i = 0; i < 4; i += 1) {
      const res = await jsonRequest(env, "POST", "/api/auth/login", {
        email: "admin@example.com",
        password: WRONG_PASSWORD
      })
      expect(res.status).toBe(401)
    }
  })
})

describe("权限分层", () => {
  it("非管理员访问管理面 403；GET /api/auth/config 公开", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)

    const res = await jsonRequest(
      env,
      "GET",
      "/api/admin/users",
      undefined,
      user
    )
    expect(res.status).toBe(403)

    const config = await jsonRequest(env, "GET", "/api/auth/config")
    expect(config.status).toBe(200)
    expect(await config.json()).toEqual({
      siteName: "Ciki",
      registrationEnabled: true,
      registrationApprovalRequired: true,
      emailConfigured: false
    })
  })
})

describe("会话管理与管理员吊销", () => {
  it("GET /api/me/sessions 列会话；删除其他会话立即失效；删当前 400", async () => {
    const { env } = await initializedContext()
    const first = await adminSession(env)
    const second = await loginAs(env, "admin@example.com")

    const list = (await (
      await jsonRequest(env, "GET", "/api/me/sessions", undefined, first)
    ).json()) as Array<{ id: string; current: boolean }>
    expect(list).toHaveLength(2)
    expect(list.filter((session) => session.current)).toHaveLength(1)
    const other = list.find((session) => !session.current)!
    const current = list.find((session) => session.current)!

    const removed = await jsonRequest(
      env,
      "DELETE",
      `/api/me/sessions/${other.id}`,
      undefined,
      first
    )
    expect(removed.status).toBe(200)
    expect(
      (await jsonRequest(env, "GET", "/api/me", undefined, second)).status
    ).toBe(401)

    const denied = await jsonRequest(
      env,
      "DELETE",
      `/api/me/sessions/${current.id}`,
      undefined,
      first
    )
    expect(denied.status).toBe(400)
  })

  it("管理员停用后会话立即 401；重新启用并拒绝后再次 401", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)
    const me = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, user)
    ).json()) as { id: string }

    const disable = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${me.id}`,
      { isActive: false },
      admin
    )
    expect(disable.status).toBe(200)
    expect(
      (await jsonRequest(env, "GET", "/api/me", undefined, user)).status
    ).toBe(401)

    await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${me.id}`,
      { isActive: true },
      admin
    )
    const again = await loginAs(env, "user@example.com")
    expect(
      (await jsonRequest(env, "GET", "/api/me", undefined, again)).status
    ).toBe(200)

    const reject = await jsonRequest(
      env,
      "POST",
      `/api/admin/users/${me.id}/reject`,
      undefined,
      admin
    )
    expect(reject.status).toBe(200)
    expect(
      (await jsonRequest(env, "GET", "/api/me", undefined, again)).status
    ).toBe(401)
  })
})

describe("外部 JSON 字段类型校验", () => {
  it("非字符串 email/password 一律 400，且不创建账号", async () => {
    const { env, db } = await initializedContext()
    for (const body of [
      { email: 123, password: "Test-Password-123" },
      { email: "a@b.c", password: 123 },
      { email: "a@b.c", password: null },
      { email: ["a@b.c"], password: "Test-Password-123" }
    ]) {
      const res = await jsonRequest(env, "POST", "/api/auth/register", body)
      expect(res.status).toBe(400)
    }
    const count = db.db
      .prepare("SELECT COUNT(*) AS c FROM ciki_users")
      .get() as { c: number }
    expect(count.c).toBe(0)
  })

  it("登录、改密、TOTP enable 的非字符串字段返回 400 而非 500", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const login = await jsonRequest(env, "POST", "/api/auth/login", {
      email: 123,
      password: "Test-Password-123"
    })
    expect(login.status).toBe(400)

    const password = await jsonRequest(
      env,
      "PUT",
      "/api/me/password",
      { currentPassword: 1, newPassword: 2 },
      admin
    )
    expect(password.status).toBe(400)

    const enable = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/enable",
      { code: 123456 },
      admin
    )
    expect(enable.status).toBe(400)

    const verify = await jsonRequest(env, "POST", "/api/auth/2fa/verify", {
      tempToken: 1,
      method: "totp",
      code: 123456
    })
    expect(verify.status).toBe(400)
  })
})
