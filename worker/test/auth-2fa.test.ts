import * as OTPAuth from "otpauth"
import { describe, expect, it } from "vitest"
import {
  adminSession,
  cookieOf,
  enableSmtpConfig,
  initializedContext,
  jsonRequest,
  markEmailVerified,
  register
} from "./support/app"
import { app } from "../src/index"
import { assertPasskey, createPasskey } from "./support/webauthn"

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

  it("登录 2FA 挑战 5 分钟过期后被拒", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableTotp(env, admin)

    const login = await jsonRequest(env, "POST", "/api/auth/login", {
      email: "admin@example.com",
      password: PASSWORD
    })
    const { tempToken } = (await login.json()) as { tempToken: string }
    db.db
      .prepare(
        "UPDATE ciki_auth_challenges SET expires_at = ? WHERE purpose = '2fa_login'"
      )
      .run(Math.floor(Date.now() / 1000) - 1)

    const verify = await jsonRequest(env, "POST", "/api/auth/2fa/verify", {
      tempToken,
      method: "totp",
      code: "123456"
    })
    expect(verify.status).toBe(401)
    expect(await verify.json()).toMatchObject({
      error: "Invalid or expired 2FA session"
    })
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

    // 注册要发验证码（站点可发信）；邮箱验证是独立的一道，测试里直接置位。
    await enableSmtpConfig(env)
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
    await markEmailVerified(env, "member@example.com")

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

const RP_ID = "localhost"
const ORIGIN = "http://localhost"

async function registerPasskey(
  env: Parameters<typeof adminSession>[0],
  cookie: string
): Promise<{ passkey: Awaited<ReturnType<typeof createPasskey>>["passkey"] }> {
  const optionsRes = await jsonRequest(
    env,
    "POST",
    "/api/auth/2fa/passkey/register/options",
    undefined,
    cookie
  )
  expect(optionsRes.status).toBe(200)
  const options = (await optionsRes.json()) as { challenge: string }
  const { passkey, response } = await createPasskey({
    rpID: RP_ID,
    origin: ORIGIN,
    challenge: options.challenge
  })
  const verify = await jsonRequest(
    env,
    "POST",
    "/api/auth/2fa/passkey/register/verify",
    response as Record<string, unknown>,
    cookie
  )
  expect(verify.status).toBe(200)
  return { passkey }
}

describe("Passkey：注册、认证与挑战一次性", () => {
  it("注册落库（credential_id/base64 公钥/counter），登录第二步可认证并更新计数", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const { passkey } = await registerPasskey(env, admin)

    const row = db.db
      .prepare(
        "SELECT credential_id, public_key, counter FROM ciki_passkey_credentials"
      )
      .get() as { credential_id: string; public_key: string; counter: number }
    expect(row.credential_id).toBe(passkey.credentialId)
    expect(row.public_key.length).toBeGreaterThan(20)
    expect(row.counter).toBe(0)

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
    expect(loginBody.availableMethods).toContain("passkey")

    const authOptionsRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/passkey/authenticate/options",
      { tempToken: loginBody.tempToken }
    )
    expect(authOptionsRes.status).toBe(200)
    const authOptions = (await authOptionsRes.json()) as { challenge: string }

    const assertion = await assertPasskey({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: authOptions.challenge,
      passkey,
      counter: 1
    })
    const verify = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/passkey/authenticate/verify",
      {
        tempToken: loginBody.tempToken,
        ...(assertion as Record<string, unknown>)
      }
    )
    expect(verify.status).toBe(200)
    expect(cookieOf(verify)).toContain("ciki_session=")

    const after = db.db
      .prepare("SELECT counter FROM ciki_passkey_credentials")
      .get() as { counter: number }
    expect(after.counter).toBe(1)

    // 同一断言重放：认证挑战已消费，tempToken 也已作废
    const replay = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/passkey/authenticate/verify",
      {
        tempToken: loginBody.tempToken,
        ...(assertion as Record<string, unknown>)
      }
    )
    expect(replay.status).toBe(401)
  })

  it("注册挑战过期（5 分钟）后被拒", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)

    const optionsRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/passkey/register/options",
      undefined,
      admin
    )
    const options = (await optionsRes.json()) as { challenge: string }
    const { response } = await createPasskey({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: options.challenge
    })

    db.db
      .prepare(
        "UPDATE ciki_auth_challenges SET expires_at = ? WHERE purpose = 'passkey_register'"
      )
      .run(Math.floor(Date.now() / 1000) - 1)

    const verify = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/passkey/register/verify",
      response as Record<string, unknown>,
      admin
    )
    expect(verify.status).toBe(400)
    expect(await verify.json()).toMatchObject({ error: "No pending challenge" })
  })

  it("注册挑战消费即删：同一响应第二次被拒", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const optionsRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/passkey/register/options",
      undefined,
      admin
    )
    const options = (await optionsRes.json()) as { challenge: string }
    const { response } = await createPasskey({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: options.challenge
    })

    const first = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/passkey/register/verify",
      response as Record<string, unknown>,
      admin
    )
    expect(first.status).toBe(200)

    const second = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/passkey/register/verify",
      response as Record<string, unknown>,
      admin
    )
    expect(second.status).toBe(400)
  })
})

describe("敏感 2FA 操作的重认证限流", () => {
  it("连续 5 次错误密码后 429，且不执行因子替换", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    await enableTotp(env, admin)

    for (let i = 0; i < 5; i += 1) {
      const res = await jsonRequest(
        env,
        "POST",
        "/api/auth/2fa/totp/disable",
        { password: "wrong-password" },
        admin
      )
      expect(res.status).toBe(403)
    }

    const blocked = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/disable",
      { password: PASSWORD },
      admin
    )
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ code: "RATE_LIMITED" })

    const row = db.db
      .prepare("SELECT totp_enabled FROM ciki_user_2fa")
      .get() as { totp_enabled: number }
    expect(row.totp_enabled).toBe(1)
  })
})

describe("已有因子时新增/启用因子必须密码重认证", () => {
  it("已有 TOTP：setup / enable / passkey options / passkey verify 都要求正确密码", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await enableTotp(env, admin)

    const noPassword = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/setup",
      undefined,
      admin
    )
    expect(noPassword.status).toBe(400)
    expect(await noPassword.json()).toMatchObject({
      error: "Password required"
    })

    const wrongPassword = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/setup",
      { password: "wrong-password" },
      admin
    )
    expect(wrongPassword.status).toBe(403)
    expect(await wrongPassword.json()).toMatchObject({
      error: "Password is incorrect"
    })

    const setup = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/setup",
      { password: PASSWORD },
      admin
    )
    expect(setup.status).toBe(200)
    const { secret } = (await setup.json()) as { secret: string }

    const enableNoPassword = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/enable",
      { code: codeAt(secret) },
      admin
    )
    expect(enableNoPassword.status).toBe(400)
    expect(await enableNoPassword.json()).toMatchObject({
      error: "Password required"
    })

    const passkeyNoPassword = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/passkey/register/options",
      undefined,
      admin
    )
    expect(passkeyNoPassword.status).toBe(400)

    const passkeyOptions = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/passkey/register/options",
      { password: PASSWORD },
      admin
    )
    expect(passkeyOptions.status).toBe(200)
    const options = (await passkeyOptions.json()) as { challenge: string }
    const { response } = await createPasskey({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: options.challenge
    })

    const verifyNoPassword = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/passkey/register/verify",
      response as Record<string, unknown>,
      admin
    )
    expect(verifyNoPassword.status).toBe(400)
    expect(await verifyNoPassword.json()).toMatchObject({
      error: "Password required"
    })

    const verify = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/passkey/register/verify",
      { ...(response as Record<string, unknown>), password: PASSWORD },
      admin
    )
    expect(verify.status).toBe(200)
  })

  it("已有 passkey 时，TOTP 首次 setup 也要密码", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await registerPasskey(env, admin)

    const noPassword = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/setup",
      undefined,
      admin
    )
    expect(noPassword.status).toBe(400)

    const withPassword = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/setup",
      { password: PASSWORD },
      admin
    )
    expect(withPassword.status).toBe(200)
  })

  it("无任何因子时免密码：首次 setup 与 passkey options 直接可用", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const totpSetup = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/setup",
      undefined,
      admin
    )
    expect(totpSetup.status).toBe(200)

    const passkeyOptions = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/passkey/register/options",
      undefined,
      admin
    )
    expect(passkeyOptions.status).toBe(200)
  })

  it("新增因子的重认证复用 reauth 限流：错密码 5 次后 429", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    await enableTotp(env, admin)

    for (let i = 0; i < 5; i += 1) {
      const res = await jsonRequest(
        env,
        "POST",
        "/api/auth/2fa/totp/setup",
        { password: "wrong-password" },
        admin
      )
      expect(res.status).toBe(403)
    }

    const blocked = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/setup",
      { password: PASSWORD },
      admin
    )
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ code: "RATE_LIMITED" })
  })
})
