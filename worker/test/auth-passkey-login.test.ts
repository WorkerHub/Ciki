import { describe, expect, it } from "vitest"
import {
  adminSession,
  cookieOf,
  initializedContext,
  jsonRequest
} from "./support/app"
import {
  assertPasskey,
  createPasskey,
  encodeUserHandle
} from "./support/webauthn"
import { isoBase64URL } from "@simplewebauthn/server/helpers"

const RP_ID = "localhost"
const ORIGIN = "http://localhost"

async function registerPasskeyForUser(
  env: Parameters<typeof adminSession>[0],
  cookie: string
) {
  const optionsRes = await jsonRequest(
    env,
    "POST",
    "/api/auth/2fa/passkey/register/options",
    undefined,
    cookie
  )
  expect(optionsRes.status).toBe(200)
  const options = (await optionsRes.json()) as {
    challenge: string
    user: { id: string }
    authenticatorSelection?: {
      residentKey?: string
      userVerification?: string
    }
  }

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

  return { passkey, options }
}

describe("无密码 Passkey 注册：可发现凭证与 UV 约束", () => {
  it("注册 options 返回 residentKey=required、UV=required，且 user.id 为 UTF-8 base64url", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const optionsRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/passkey/register/options",
      undefined,
      admin
    )
    expect(optionsRes.status).toBe(200)
    const options = (await optionsRes.json()) as {
      user: { id: string; name: string }
      authenticatorSelection: {
        residentKey: string
        userVerification: string
      }
    }

    expect(options.authenticatorSelection.residentKey).toBe("required")
    expect(options.authenticatorSelection.userVerification).toBe("required")

    // user.id 为数字 id 的 UTF-8 字节的 base64url 编码
    const decodedId = Number(isoBase64URL.toUTF8String(options.user.id))
    expect(Number.isSafeInteger(decodedId)).toBe(true)
    expect(decodedId).toBeGreaterThan(0)
  })
})

describe("无密码 Passkey 登录端点：options 与 verify", () => {
  it("options 端点公开且不含 allowCredentials，challenge 存入 D1 且 5 分钟有效", async () => {
    const { env, db } = await initializedContext()

    // 公开端点：无需任何会话 Cookie
    const res = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/options",
      {}
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      challenge: string
      rpId?: string
      userVerification?: string
      allowCredentials?: unknown[]
    }

    expect(body.challenge).toBeTruthy()
    expect(body.userVerification).toBe("required")
    // 免密登录：不指定 allowCredentials
    expect(
      body.allowCredentials === undefined ||
        (Array.isArray(body.allowCredentials) &&
          body.allowCredentials.length === 0)
    ).toBe(true)

    // 挑战存入 D1，purpose 为 passkey_login
    const row = db.db
      .prepare(
        "SELECT user_id, purpose, payload, expires_at FROM ciki_auth_challenges WHERE purpose = 'passkey_login'"
      )
      .get() as {
      user_id: number
      purpose: string
      payload: string
      expires_at: number
    }
    expect(row).toBeTruthy()
    expect(row.purpose).toBe("passkey_login")
    expect(row.payload).toBe(body.challenge)
    expect(row.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 290)
  })

  it("verify 端点成功验证：反查账号、直接颁发会话、自增 counter", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const { passkey, options } = await registerPasskeyForUser(env, admin)

    // 1. 获取免密登录 options
    const optRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/options"
    )
    expect(optRes.status).toBe(200)
    const optBody = (await optRes.json()) as { challenge: string }

    // 2. 生成断言（带 userHandle 与 UV=true）
    const userId = Number(isoBase64URL.toUTF8String(options.user.id))
    const assertion = await assertPasskey({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optBody.challenge,
      passkey,
      counter: 1,
      userHandle: encodeUserHandle(userId)
    })

    // 3. 提交验证（公开端点，无需 Cookie）
    const verifyRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/verify",
      assertion as Record<string, unknown>
    )
    expect(verifyRes.status).toBe(200)
    const verifyBody = (await verifyRes.json()) as {
      success: boolean
      user: { id: number; email: string; role: string }
    }
    expect(verifyBody.success).toBe(true)
    expect(verifyBody.user.id).toBe(userId)
    expect(verifyBody.user.email).toBe("admin@example.com")
    expect(verifyBody.user.role).toBe("admin")

    // 会话 Cookie 已写入
    const cookie = cookieOf(verifyRes)
    expect(cookie).toContain("ciki_session=")

    // counter 已更新为 1
    const passkeyRow = db.db
      .prepare(
        "SELECT counter FROM ciki_passkey_credentials WHERE credential_id = ?"
      )
      .get(passkey.credentialId) as { counter: number }
    expect(passkeyRow.counter).toBe(1)

    // 挑战已被单次消费删除
    const challengeRow = db.db
      .prepare(
        "SELECT * FROM ciki_auth_challenges WHERE purpose = 'passkey_login'"
      )
      .get()
    expect(challengeRow).toBeUndefined()
  })

  it("支持从 clientDataJSON 自动解码 challenge（缺省顶层 challenge 也能登录）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { passkey } = await registerPasskeyForUser(env, admin)

    const optRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/options"
    )
    const optBody = (await optRes.json()) as { challenge: string }

    const assertion = (await assertPasskey({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optBody.challenge,
      passkey,
      counter: 1
    })) as Record<string, unknown>

    // 确保没有顶层 challenge
    delete assertion.challenge

    const verifyRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/verify",
      assertion
    )
    expect(verifyRes.status).toBe(200)
    expect(cookieOf(verifyRes)).toContain("ciki_session=")
  })

  it("防重放：同一 assertion 第二次提交报 401 Invalid credentials", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { passkey } = await registerPasskeyForUser(env, admin)

    const optRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/options"
    )
    const optBody = (await optRes.json()) as { challenge: string }

    const assertion = await assertPasskey({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optBody.challenge,
      passkey,
      counter: 1
    })

    const first = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/verify",
      assertion as Record<string, unknown>
    )
    expect(first.status).toBe(200)

    const second = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/verify",
      assertion as Record<string, unknown>
    )
    expect(second.status).toBe(401)
    expect(await second.json()).toMatchObject({ error: "Invalid credentials" })
  })

  it("挑战过期（>5 分钟）被拒 401", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const { passkey } = await registerPasskeyForUser(env, admin)

    const optRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/options"
    )
    const optBody = (await optRes.json()) as { challenge: string }

    const assertion = await assertPasskey({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optBody.challenge,
      passkey,
      counter: 1
    })

    // 篡改过期时间
    db.db
      .prepare(
        "UPDATE ciki_auth_challenges SET expires_at = ? WHERE purpose = 'passkey_login'"
      )
      .run(Math.floor(Date.now() / 1000) - 10)

    const res = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/verify",
      assertion as Record<string, unknown>
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "Invalid credentials" })
  })

  it("未知凭证 ID 返回 401，不泄露账号存在性", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { passkey } = await registerPasskeyForUser(env, admin)

    const optRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/options"
    )
    const optBody = (await optRes.json()) as { challenge: string }

    const assertion = (await assertPasskey({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optBody.challenge,
      passkey,
      counter: 1
    })) as Record<string, unknown>

    assertion.id = "unknown-credential-id"
    assertion.rawId = "unknown-credential-id"

    const res = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/verify",
      assertion
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "Invalid credentials" })
  })

  it("userHandle 与凭证账号不匹配时返回 401", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { passkey } = await registerPasskeyForUser(env, admin)

    const optRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/options"
    )
    const optBody = (await optRes.json()) as { challenge: string }

    // 故意伪造一个其他用户的 userHandle (99999)
    const assertion = await assertPasskey({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optBody.challenge,
      passkey,
      counter: 1,
      userHandle: encodeUserHandle(99999)
    })

    const res = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/verify",
      assertion as Record<string, unknown>
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "Invalid credentials" })
  })

  it("缺少用户验证（UV=false）被拒 401", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { passkey } = await registerPasskeyForUser(env, admin)

    const optRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/options"
    )
    const optBody = (await optRes.json()) as { challenge: string }

    const assertion = await assertPasskey({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optBody.challenge,
      passkey,
      counter: 1,
      uv: false // 未执行用户验证
    })

    const res = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/verify",
      assertion as Record<string, unknown>
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "Invalid credentials" })
  })
})

describe("无密码 Passkey 登录：账号状态门禁一致性", () => {
  it("未验证邮箱拦截为 403 EMAIL_NOT_VERIFIED", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const { passkey } = await registerPasskeyForUser(env, admin)

    // 将用户改为未验证邮箱
    db.db
      .prepare(
        "UPDATE ciki_users SET email_verified = 0 WHERE email = 'admin@example.com'"
      )
      .run()

    const optRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/options"
    )
    const optBody = (await optRes.json()) as { challenge: string }

    const assertion = await assertPasskey({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optBody.challenge,
      passkey,
      counter: 1
    })

    const res = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/verify",
      assertion as Record<string, unknown>
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      code: "EMAIL_NOT_VERIFIED",
      error: "Email not verified"
    })
  })

  it("待审批拦截为 403 ACCOUNT_PENDING_APPROVAL", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const { passkey } = await registerPasskeyForUser(env, admin)

    db.db
      .prepare(
        "UPDATE ciki_users SET approval_status = 'pending' WHERE email = 'admin@example.com'"
      )
      .run()

    const optRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/options"
    )
    const optBody = (await optRes.json()) as { challenge: string }

    const assertion = await assertPasskey({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optBody.challenge,
      passkey,
      counter: 1
    })

    const res = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/verify",
      assertion as Record<string, unknown>
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      code: "ACCOUNT_PENDING_APPROVAL",
      error: "Account pending approval"
    })
  })

  it("已拒绝拦截为 403 ACCOUNT_REJECTED", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const { passkey } = await registerPasskeyForUser(env, admin)

    db.db
      .prepare(
        "UPDATE ciki_users SET approval_status = 'rejected' WHERE email = 'admin@example.com'"
      )
      .run()

    const optRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/options"
    )
    const optBody = (await optRes.json()) as { challenge: string }

    const assertion = await assertPasskey({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optBody.challenge,
      passkey,
      counter: 1
    })

    const res = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/verify",
      assertion as Record<string, unknown>
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      code: "ACCOUNT_REJECTED",
      error: "Account was rejected"
    })
  })

  it("停用账号拦截为 401 Invalid credentials（与密码登录一致）", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const { passkey } = await registerPasskeyForUser(env, admin)

    db.db
      .prepare(
        "UPDATE ciki_users SET is_active = 0 WHERE email = 'admin@example.com'"
      )
      .run()

    const optRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/options"
    )
    const optBody = (await optRes.json()) as { challenge: string }

    const assertion = await assertPasskey({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optBody.challenge,
      passkey,
      counter: 1
    })

    const res = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/verify",
      assertion as Record<string, unknown>
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "Invalid credentials" })
  })
})

describe("无密码 Passkey 登录：限流与锁定", () => {
  it("同一账号连续 5 次失败后锁定，第 6 次直接 429 ACCOUNT_LOCKED", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { passkey } = await registerPasskeyForUser(env, admin)

    for (let i = 0; i < 5; i += 1) {
      const optRes = await jsonRequest(
        env,
        "POST",
        "/api/auth/passkey/login/options"
      )
      const optBody = (await optRes.json()) as { challenge: string }

      // 故意提供错误的签名
      const assertion = (await assertPasskey({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: optBody.challenge,
        passkey,
        counter: 1
      })) as { response: { signature: string } }
      assertion.response.signature = "invalid-sig"

      const failRes = await jsonRequest(
        env,
        "POST",
        "/api/auth/passkey/login/verify",
        assertion as Record<string, unknown>
      )
      expect(failRes.status).toBe(401)
    }

    // 第 6 次即便拿到正确的断言，也因账号被锁直接返回 429 ACCOUNT_LOCKED
    const optRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/options"
    )
    const optBody = (await optRes.json()) as { challenge: string }
    const validAssertion = await assertPasskey({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optBody.challenge,
      passkey,
      counter: 2
    })

    const lockedRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/verify",
      validAssertion as Record<string, unknown>
    )
    expect(lockedRes.status).toBe(429)
    const body = (await lockedRes.json()) as {
      code: string
      retryAfter: number
    }
    expect(body.code).toBe("ACCOUNT_LOCKED")
    expect(body.retryAfter).toBeGreaterThan(0)
  })

  it("每 IP 10 次/5 分钟：第 11 次 429 RATE_LIMITED", async () => {
    const { env } = await initializedContext()

    for (let i = 0; i < 10; i += 1) {
      const res = await jsonRequest(
        env,
        "POST",
        "/api/auth/passkey/login/verify",
        {
          id: `fake-id-${i}`
        }
      )
      expect(res.status).toBe(401)
    }

    const blocked = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/verify",
      { id: "fake-id-11" }
    )
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ code: "RATE_LIMITED" })
  })

  it("登录成功清空失败计数（锁定前不会误锁）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { passkey } = await registerPasskeyForUser(env, admin)

    // 失败 4 次
    for (let i = 0; i < 4; i += 1) {
      const optRes = await jsonRequest(
        env,
        "POST",
        "/api/auth/passkey/login/options"
      )
      const optBody = (await optRes.json()) as { challenge: string }
      const assertion = (await assertPasskey({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: optBody.challenge,
        passkey,
        counter: 1
      })) as { response: { signature: string } }
      assertion.response.signature = "invalid-sig"

      await jsonRequest(
        env,
        "POST",
        "/api/auth/passkey/login/verify",
        assertion as Record<string, unknown>
      )
    }

    // 成功登录 1 次
    const optRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/options"
    )
    const optBody = (await optRes.json()) as { challenge: string }
    const validAssertion = await assertPasskey({
      rpID: RP_ID,
      origin: ORIGIN,
      challenge: optBody.challenge,
      passkey,
      counter: 2
    })
    const successRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/passkey/login/verify",
      validAssertion as Record<string, unknown>
    )
    expect(successRes.status).toBe(200)

    // 再次失败 4 次，依然不会触发锁定（因为中间被成功清空过）
    for (let i = 0; i < 4; i += 1) {
      const optRes = await jsonRequest(
        env,
        "POST",
        "/api/auth/passkey/login/options"
      )
      const optBody = (await optRes.json()) as { challenge: string }
      const assertion = (await assertPasskey({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge: optBody.challenge,
        passkey,
        counter: 3
      })) as { response: { signature: string } }
      assertion.response.signature = "invalid-sig"

      const res = await jsonRequest(
        env,
        "POST",
        "/api/auth/passkey/login/verify",
        assertion as Record<string, unknown>
      )
      expect(res.status).toBe(401)
    }
  })
})
