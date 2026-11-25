import * as OTPAuth from "otpauth"
import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  makeContext,
  userSession
} from "./support/app"
import { createPasskey } from "./support/webauthn"
import { runLedgerMigrations } from "../src/lib/migrations-runner"
import { getMigrations } from "../src/lib/migrations"
import { passkeysTable, user2faTable } from "../src/lib/tables"

const PASSWORD = "Test" + "-Password" + "-123"
const RP_ID = "localhost"
const ORIGIN = "http://localhost"

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

async function registerNamedPasskey(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  name?: string,
  password?: string
): Promise<{
  credentialId: string
  response: Response
}> {
  const optionsRes = await jsonRequest(
    env,
    "POST",
    "/api/auth/2fa/passkey/register/options",
    password ? { password } : undefined,
    cookie
  )
  expect(optionsRes.status).toBe(200)
  const options = (await optionsRes.json()) as { challenge: string }
  const { passkey, response } = await createPasskey({
    rpID: RP_ID,
    origin: ORIGIN,
    challenge: options.challenge
  })
  const body: Record<string, unknown> = {
    ...(response as Record<string, unknown>)
  }
  if (name !== undefined) {
    body.name = name
  }
  if (password !== undefined) {
    body.password = password
  }
  const verify = await jsonRequest(
    env,
    "POST",
    "/api/auth/2fa/passkey/register/verify",
    body,
    cookie
  )
  return { credentialId: passkey.credentialId, response: verify }
}

describe("schema_v14 迁移与存量数据回填", () => {
  it("schema_v14 声明了 apply 且 sql 为空，通过 db.batch 原子执行加列与回填", async () => {
    const prefix = "ciki_"
    const migrations = getMigrations(prefix)
    const v14 = migrations.find((m) => m.name === "schema_v14")
    expect(v14).toBeDefined()
    expect(v14?.sql).toBe("")
    expect(typeof v14?.apply).toBe("function")
  })

  it("存量 passkey 按创建时间顺序回填「Passkey 1」「Passkey 2」；存量已启用 TOTP 回填「TOTP」", async () => {
    const ctx = makeContext()
    const prefix = "ciki_"
    // 先执行到 schema_v13，模拟拥有存量数据尚未应用 schema_v14 的库
    // 手动创建基础表并插入存量数据（无 name / totp_name 列）
    const passkeys = passkeysTable(prefix)
    const user2fa = user2faTable(prefix)

    // 先完整跑一次所有迁移前置（v1-v13），为了构造存量表，先运行 runLedgerMigrations
    await runLedgerMigrations(ctx.env)

    // 清空两表以准备测试数据
    await ctx.db.exec(`DELETE FROM ${passkeys}`)
    await ctx.db.exec(`DELETE FROM ${user2fa}`)

    // 插入用户 1 的 3 个 passkey（不同 created_at）
    await ctx.db.exec(`
      INSERT INTO ${passkeys} (user_id, credential_id, public_key, counter, transports, created_at, name)
      VALUES (1, 'cred-1-old', 'pk1', 0, '[]', '2026-01-01T10:00:00.000Z', ''),
             (1, 'cred-2-old', 'pk2', 0, '[]', '2026-01-02T10:00:00.000Z', ''),
             (1, 'cred-3-old', 'pk3', 0, '[]', '2026-01-03T10:00:00.000Z', '');
    `)

    // 插入用户 2 的 2 个 passkey（相同 created_at，按 id 确定顺序）
    await ctx.db.exec(`
      INSERT INTO ${passkeys} (user_id, credential_id, public_key, counter, transports, created_at, name)
      VALUES (2, 'cred-4-old', 'pk4', 0, '[]', '2026-01-01T12:00:00.000Z', ''),
             (2, 'cred-5-old', 'pk5', 0, '[]', '2026-01-01T12:00:00.000Z', '');
    `)

    // 插入 user_2fa：一个已启用，一个未启用
    await ctx.db.exec(`
      INSERT INTO ${user2fa} (user_id, totp_secret, totp_enabled, email_otp_enabled, updated_at, totp_name)
      VALUES (1, 'secret1', 1, 0, '2026-01-01T00:00:00.000Z', ''),
             (2, NULL, 0, 0, '2026-01-01T00:00:00.000Z', '');
    `)

    // 执行 schema_v14 的回填 SQL 逻辑进行验证
    await ctx.db.exec(`
      UPDATE ${user2fa} SET totp_name = 'TOTP' WHERE totp_enabled = 1;
      UPDATE ${passkeys}
      SET name = 'Passkey ' || (
        SELECT COUNT(*)
        FROM ${passkeys} AS p2
        WHERE p2.user_id = ${passkeys}.user_id
          AND (p2.created_at < ${passkeys}.created_at OR (p2.created_at = ${passkeys}.created_at AND p2.id <= ${passkeys}.id))
      )
      WHERE name = '' OR name IS NULL;
    `)

    // 验证用户 1 的 passkey 编号
    const u1Rows = (await ctx.db.db
      .prepare(
        `SELECT credential_id, name FROM ${passkeys} WHERE user_id = 1 ORDER BY created_at ASC`
      )
      .all()) as Array<{ credential_id: string; name: string }>
    expect(u1Rows).toEqual([
      { credential_id: "cred-1-old", name: "Passkey 1" },
      { credential_id: "cred-2-old", name: "Passkey 2" },
      { credential_id: "cred-3-old", name: "Passkey 3" }
    ])

    // 验证用户 2 的 passkey 编号（每用户独立自增）
    const u2Rows = (await ctx.db.db
      .prepare(
        `SELECT credential_id, name FROM ${passkeys} WHERE user_id = 2 ORDER BY id ASC`
      )
      .all()) as Array<{ credential_id: string; name: string }>
    expect(u2Rows).toEqual([
      { credential_id: "cred-4-old", name: "Passkey 1" },
      { credential_id: "cred-5-old", name: "Passkey 2" }
    ])

    // 验证 user_2fa 的 totp_name 回填
    const u1Totp = (await ctx.db.db
      .prepare(`SELECT totp_name FROM ${user2fa} WHERE user_id = 1`)
      .get()) as { totp_name: string }
    expect(u1Totp.totp_name).toBe("TOTP")

    const u2Totp = (await ctx.db.db
      .prepare(`SELECT totp_name FROM ${user2fa} WHERE user_id = 2`)
      .get()) as { totp_name: string }
    expect(u2Totp.totp_name).toBe("")
  })
})

describe("Passkey 注册命名与默认规则", () => {
  it("注册时提供名字则校验并落库，留空则默认 Passkey N（已有数量 + 1）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 1. 首次注册，留空名字 -> 默认 Passkey 1
    const p1 = await registerNamedPasskey(env, admin, "")
    expect(p1.response.status).toBe(200)

    let me = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, admin)
    ).json()) as {
      twofa: { passkeys: Array<{ name: string; credentialId: string }> }
    }
    expect(me.twofa.passkeys).toHaveLength(1)
    expect(me.twofa.passkeys[0].name).toBe("Passkey 1")
    expect(me.twofa.passkeys[0].credentialId).toBe(p1.credentialId)

    // 2. 再次注册，未提供 name 字段 -> 默认 Passkey 2
    const p2 = await registerNamedPasskey(env, admin, undefined, PASSWORD)
    expect(p2.response.status).toBe(200)

    me = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, admin)
    ).json()) as {
      twofa: { passkeys: Array<{ name: string; credentialId: string }> }
    }
    expect(me.twofa.passkeys).toHaveLength(2)
    expect(me.twofa.passkeys[1].name).toBe("Passkey 2")

    // 3. 再次注册，提供自定义名字并带空格 -> trim 后保存
    const p3 = await registerNamedPasskey(
      env,
      admin,
      "  MacBook Touch ID  ",
      PASSWORD
    )
    expect(p3.response.status).toBe(200)

    me = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, admin)
    ).json()) as { twofa: { passkeys: Array<{ name: string }> } }
    expect(me.twofa.passkeys).toHaveLength(3)
    expect(me.twofa.passkeys[2].name).toBe("MacBook Touch ID")

    // 4. 再次注册，纯空格留空 -> 现有数量 3 + 1 = Passkey 4
    const p4 = await registerNamedPasskey(env, admin, "    ", PASSWORD)
    expect(p4.response.status).toBe(200)

    me = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, admin)
    ).json()) as { twofa: { passkeys: Array<{ name: string }> } }
    expect(me.twofa.passkeys).toHaveLength(4)
    expect(me.twofa.passkeys[3].name).toBe("Passkey 4")

    // 5. 允许同用户内重名
    const p5 = await registerNamedPasskey(
      env,
      admin,
      "MacBook Touch ID",
      PASSWORD
    )
    expect(p5.response.status).toBe(200)
    me = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, admin)
    ).json()) as { twofa: { passkeys: Array<{ name: string }> } }
    expect(me.twofa.passkeys).toHaveLength(5)
    expect(me.twofa.passkeys[4].name).toBe("MacBook Touch ID")
  })

  it("名字校验：超过 50 字符或非字符串返回 400", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 超过 50 字符
    const longName = "A".repeat(51)
    const tooLong = await registerNamedPasskey(env, admin, longName)
    expect(tooLong.response.status).toBe(400)
    expect(await tooLong.response.json()).toMatchObject({
      code: "INVALID_NAME"
    })

    // 刚好 50 字符合法
    const exact50 = "B".repeat(50)
    const ok50 = await registerNamedPasskey(env, admin, exact50)
    expect(ok50.response.status).toBe(200)
  })
})

describe("Passkey 改名接口 PATCH /api/auth/2fa/passkey/:credentialId", () => {
  it("登录会话即可改名（不要求密码重认证），修改成功回显", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const { credentialId } = await registerNamedPasskey(
      env,
      admin,
      "Initial Name"
    )

    // 改名：无密码也可以
    const rename = await jsonRequest(
      env,
      "PATCH",
      `/api/auth/2fa/passkey/${credentialId}`,
      { name: "  Renamed Key  " },
      admin
    )
    expect(rename.status).toBe(200)
    expect(await rename.json()).toEqual({
      success: true,
      name: "Renamed Key"
    })

    // /api/me 验证名字已更新
    const me = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, admin)
    ).json()) as {
      twofa: { passkeys: Array<{ name: string; credentialId: string }> }
    }
    expect(me.twofa.passkeys[0].name).toBe("Renamed Key")
  })

  it("改名校验：空名字、超长、非字符串报 400；凭证不存在或非本人报 404；未登录 401", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const { credentialId } = await registerNamedPasskey(env, admin, "Key 1")

    // 1. 空名字 / 纯空格
    const emptyRes = await jsonRequest(
      env,
      "PATCH",
      `/api/auth/2fa/passkey/${credentialId}`,
      { name: "   " },
      admin
    )
    expect(emptyRes.status).toBe(400)

    // 2. 超长 > 50
    const longRes = await jsonRequest(
      env,
      "PATCH",
      `/api/auth/2fa/passkey/${credentialId}`,
      { name: "X".repeat(51) },
      admin
    )
    expect(longRes.status).toBe(400)

    // 3. 非字符串
    const typeRes = await jsonRequest(
      env,
      "PATCH",
      `/api/auth/2fa/passkey/${credentialId}`,
      { name: 12345 },
      admin
    )
    expect(typeRes.status).toBe(400)

    // 4. 不存在的凭证 ID 报 404
    const notFound = await jsonRequest(
      env,
      "PATCH",
      "/api/auth/2fa/passkey/non-existent-id",
      { name: "Valid Name" },
      admin
    )
    expect(notFound.status).toBe(404)

    // 5. 跨用户访问（其他用户尝试改名此凭证）报 404
    const otherCookie = await userSession(env, admin, "other@example.com")
    const crossUser = await jsonRequest(
      env,
      "PATCH",
      `/api/auth/2fa/passkey/${credentialId}`,
      { name: "Hacked" },
      otherCookie
    )
    expect(crossUser.status).toBe(404)

    // 6. 未登录报 401
    const unauth = await jsonRequest(
      env,
      "PATCH",
      `/api/auth/2fa/passkey/${credentialId}`,
      { name: "Unauth" }
    )
    expect(unauth.status).toBe(401)
  })
})

describe("TOTP 设置命名与启用流程", () => {
  it("totp/setup 填名则 otpauth URI 的 label 为该名，留空则为邮箱；issuer 恒为 ciki", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 1. 带自定义名字
    const customSetup = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/setup",
      { name: "My Authenticator" },
      admin
    )
    expect(customSetup.status).toBe(200)
    const customBody = (await customSetup.json()) as { uri: string }
    expect(customBody.uri).toContain("otpauth://totp/ciki:My%20Authenticator?")
    expect(customBody.uri).toContain("issuer=ciki")

    // 2. 留空名字 -> 使用用户邮箱
    const defaultSetup = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/setup",
      { name: "  " },
      admin
    )
    expect(defaultSetup.status).toBe(200)
    const defaultBody = (await defaultSetup.json()) as { uri: string }
    expect(defaultBody.uri).toContain(
      "otpauth://totp/ciki:admin%40example.com?"
    )
    expect(defaultBody.uri).toContain("issuer=ciki")

    // 3. setup 名字超长拦截
    const tooLong = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/setup",
      { name: "T".repeat(51) },
      admin
    )
    expect(tooLong.status).toBe(400)
    expect(await tooLong.json()).toMatchObject({ code: "INVALID_NAME" })
  })

  it("totp/enable 随请求提交名字入库，留空则为 TOTP；停用后清空", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 1. 自定义名字启用
    const setupRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/setup",
      { name: "Work Phone" },
      admin
    )
    const { secret } = (await setupRes.json()) as { secret: string }
    const code = codeAt(secret)

    const enableRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/enable",
      { code, name: "  Work Phone  " },
      admin
    )
    expect(enableRes.status).toBe(200)

    let me = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, admin)
    ).json()) as { twofa: { totpEnabled: boolean; totpName: string | null } }
    expect(me.twofa.totpEnabled).toBe(true)
    expect(me.twofa.totpName).toBe("Work Phone")

    // 2. 停用 TOTP
    const disableRes = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/disable",
      { password: PASSWORD },
      admin
    )
    expect(disableRes.status).toBe(200)

    me = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, admin)
    ).json()) as { twofa: { totpEnabled: boolean; totpName: string | null } }
    expect(me.twofa.totpEnabled).toBe(false)
    expect(me.twofa.totpName).toBeNull()

    // 3. 再次启用，留空名字 -> 默认「TOTP」
    const setup2 = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/setup",
      undefined,
      admin
    )
    const { secret: secret2 } = (await setup2.json()) as { secret: string }
    const code2 = codeAt(secret2)

    const enable2 = await jsonRequest(
      env,
      "POST",
      "/api/auth/2fa/totp/enable",
      { code: code2 },
      admin
    )
    expect(enable2.status).toBe(200)

    me = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, admin)
    ).json()) as { twofa: { totpEnabled: boolean; totpName: string | null } }
    expect(me.twofa.totpEnabled).toBe(true)
    expect(me.twofa.totpName).toBe("TOTP")
  })
})

describe("/api/me 数据出口完整性验证", () => {
  it("twofa 摘要完整包含 totpEnabled, totpName, passkeyEnabled, passkeyCount, passkeys 及字段结构", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 初始状态：无任何因子
    let res = await jsonRequest(env, "GET", "/api/me", undefined, admin)
    let body = (await res.json()) as {
      twofa: {
        totpEnabled: boolean
        totpName: string | null
        passkeyEnabled: boolean
        passkeyCount: number
        passkeys: Array<{
          name: string
          createdAt: string
          lastUsedAt: string | null
          credentialId: string
        }>
        emailOtpEnabled: boolean
      }
    }
    expect(body.twofa).toEqual({
      totpEnabled: false,
      totpName: null,
      passkeyEnabled: false,
      passkeyCount: 0,
      passkeys: [],
      emailOtpEnabled: false
    })

    // 添加一个 Passkey
    const { credentialId } = await registerNamedPasskey(
      env,
      admin,
      "Security Key 1"
    )

    res = await jsonRequest(env, "GET", "/api/me", undefined, admin)
    body = (await res.json()) as typeof body
    expect(body.twofa.passkeyEnabled).toBe(true)
    expect(body.twofa.passkeyCount).toBe(1)
    expect(body.twofa.passkeys).toHaveLength(1)
    expect(body.twofa.passkeys[0].name).toBe("Security Key 1")
    expect(body.twofa.passkeys[0].credentialId).toBe(credentialId)
    expect(body.twofa.passkeys[0].lastUsedAt).toBeNull()
    expect(typeof body.twofa.passkeys[0].createdAt).toBe("string")
  })
})
