import * as OTPAuth from "otpauth"
import { describe, expect, it } from "vitest"
import {
  adminSession,
  cookieOf,
  initializedContext,
  jsonRequest,
  register
} from "./support/app"
import { app } from "../src/index"

const PASSWORD = "Test" + "-Password" + "-123"

/** 用与服务端相同的参数生成某一时间窗的 TOTP。 */
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
  env: Parameters<typeof adminSession>[0],
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
  const { secret, uri } = (await setup.json()) as {
    secret: string
    uri: string
  }
  expect(uri.startsWith("otpauth://totp/")).toBe(true)

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

describe("TOTP：加密落库、登录第二步、防重放", () => {
  it("setup 只回一次明文；库里是 v1. 密文；登录要求 TOTP", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const secret = await enableTotp(env, admin)

    const row = db.db
      .prepare("SELECT totp_secret FROM ciki_user_2fa")
      .get() as { totp_secret: string }
    expect(row.totp_secret.startsWith("v1.")).toBe(true)
    expect(row.totp_secret).not.toContain(secret)

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
    expect(body.availableMethods).toEqual(["totp"])
    expect(cookieOf(login)).toBeNull()

    // 用下一个时间窗的码，避开 enable 时消耗掉的那个
    const nextCode = codeAt(secret, 30_000)
    const verify = await jsonRequest(env, "POST", "/api/auth/2fa/verify", {
      tempToken: body.tempToken,
      method: "totp",
      code: nextCode
    })
    expect(verify.status).toBe(200)
    expect(cookieOf(verify)).toContain("ciki_session=")

    // 重放同一个码：新的 tempToken 也不能通过
    const secondLogin = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: PASSWORD
    })
    const second = (await secondLogin.json()) as { tempToken: string }
    const replay = await jsonRequest(env, "POST", "/api/auth/2fa/verify", {
      tempToken: second.tempToken,
      method: "totp",
      code: nextCode
    })
    expect(replay.status).toBe(401)
  })

  it("错误码累计 5 次作废 tempToken", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await enableTotp(env, admin)

    const login = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: PASSWORD
    })
    const { tempToken } = (await login.json()) as { tempToken: string }

    for (let i = 0; i < 5; i += 1) {
      const res = await jsonRequest(
        env,
        "POST",
        "/api/auth/2fa/verify",
        { tempToken, method: "totp", code: "000000" },
        undefined
      )
      expect(res.status).toBe(401)
    }

    const after = await fetch2fa(env, tempToken, "10.9.9.9")
    expect(after.status).toBe(401)
  })

  it("受限会话只放行 2FA 设置，配置完成后自动解除", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
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

    const login = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "member@example.com",
      password: PASSWORD
    })
    expect(login.status).toBe(200)
    const loginBody = (await login.json()) as { needs2faSetup?: boolean }
    expect(loginBody.needs2faSetup).toBe(true)
    const cookie = cookieOf(login)!

    const blocked = await jsonRequest(
      env,
      "GET",
      "/api/pages",
      undefined,
      cookie
    )
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toMatchObject({ needs2faSetup: true })

    await enableTotp(env, cookie)

    const allowed = await jsonRequest(
      env,
      "GET",
      "/api/pages",
      undefined,
      cookie
    )
    expect(allowed.status).toBe(200)
  })

  it("passkey 注册 options 需会话，返回挑战", async () => {
    const { env } = await initializedContext()
    const unauth = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/passkey/register/options"
    )
    expect(unauth.status).toBe(401)

    const admin = await adminSession(env)
    const res = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/passkey/register/options",
      undefined,
      admin
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { challenge: string; rp: { id: string } }
    expect(typeof body.challenge).toBe("string")
    expect(body.challenge.length).toBeGreaterThan(10)
  })
})

/** 指定客户端 IP 调 2FA verify，绕开同一 IP 的 5 次限流，专测令牌作废。 */
async function fetch2fa(
  env: Parameters<typeof jsonRequest>[0],
  tempToken: string,
  ip: string
): Promise<Response> {
  return app.request(
    "/api/auth/2fa/verify",
    {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ tempToken, method: "totp", code: "111111" })
    },
    env
  )
}
