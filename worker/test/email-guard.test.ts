/**
 * 规格 §5.6 第 4 条「未配置守卫」与注册邮箱验证开关后端行为：
 * - 开关默认开启；
 * - 邮件未配置时「注册需邮箱验证」开关不可开启（PUT/PATCH /api/admin/settings 报 409 EMAIL_NOT_CONFIGURED）；
 * - 开关开启且邮件已配置时：普通用户注册 emailVerificationRequired: true, email_verified: 0, 发码；
 * - 开关关闭时：普通用户注册 emailVerificationRequired: false, email_verified: 1, 不发信；
 * - 开关已开但邮件被撤走（未配置守卫生效）：新注册按未配置口径直接视为已验证，不发码；已注册未验证的用户登录放行并自愈 email_verified=1；
 * - 首个用户（管理员）恒免验证（emailVerificationRequired: false, email_verified=1）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getTablePrefix } from "../src/lib/table-prefix"
import { settingsTable, usersTable } from "../src/lib/tables"
import { SMTP_CONFIG_KEY } from "../src/services/email"
import type { Env } from "../src/types"
import type { TestContext } from "./support/app"
import {
  TestExecutionContext,
  adminSession,
  enableSmtpConfig,
  initializedContext,
  jsonRequest
} from "./support/app"

const { sendSmtpMessageMock } = vi.hoisted(() => ({
  sendSmtpMessageMock: vi.fn()
}))

vi.mock("../src/services/smtp-transport", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/smtp-transport")>()
  return { ...actual, sendSmtpMessage: sendSmtpMessageMock }
})

const PASSWORD = "Test-Password-123"
const ADMIN = "admin@example.com"
const USER1 = "user1@example.com"
const USER2 = "user2@example.com"

async function disableSmtpConfig(env: Env): Promise<void> {
  const prefix = getTablePrefix(env)
  await env.DB.prepare(`DELETE FROM ${settingsTable(prefix)} WHERE key = ?`)
    .bind(SMTP_CONFIG_KEY)
    .run()
}

async function approveUser(ctx: TestContext, admin: string, email: string) {
  const prefix = getTablePrefix(ctx.env)
  const user = ctx.db.db
    .prepare(`SELECT id FROM ${usersTable(prefix)} WHERE email = ?`)
    .get(email) as { id: number }
  const res = await jsonRequest(
    ctx.env,
    "POST",
    `/api/admin/users/${user.id}/approve`,
    undefined,
    admin
  )
  expect(res.status).toBe(200)
}

async function registerUser(
  ctx: TestContext,
  email: string,
  password = PASSWORD
): Promise<Response> {
  const executionCtx = new TestExecutionContext()
  const res = await jsonRequest(
    ctx.env,
    "POST",
    "/api/auth/register",
    { email, password },
    undefined,
    executionCtx
  )
  await executionCtx.settle()
  return res
}

function userRow(ctx: TestContext, email: string) {
  const prefix = getTablePrefix(ctx.env)
  return ctx.db.db
    .prepare(
      `SELECT email, role, email_verified, approval_status FROM ${usersTable(prefix)} WHERE email = ?`
    )
    .get(email) as
    | {
        email: string
        role: string
        email_verified: number
        approval_status: string
      }
    | undefined
}

beforeEach(() => {
  sendSmtpMessageMock.mockReset()
  sendSmtpMessageMock.mockResolvedValue({ success: true })
})

describe("邮件未配置守卫（管理面）", () => {
  it("系统初始化后开关默认开；邮件未配置时尝试开启回 409 EMAIL_NOT_CONFIGURED", async () => {
    const ctx = await initializedContext()
    const admin = await adminSession(ctx.env, ADMIN)

    // GET /api/admin/settings 回读默认值
    const getRes = await jsonRequest(
      ctx.env,
      "GET",
      "/api/admin/settings",
      undefined,
      admin
    )
    expect(getRes.status).toBe(200)
    const settings = (await getRes.json()) as {
      registrationEmailVerificationRequired: boolean
      emailConfigured: boolean
    }
    expect(settings.registrationEmailVerificationRequired).toBe(true)
    expect(settings.emailConfigured).toBe(false)

    // 邮件未配置时尝试 PUT 设置为 true：拦截并报 409
    const putTrue = await jsonRequest(
      ctx.env,
      "PUT",
      "/api/admin/settings",
      { registrationEmailVerificationRequired: true },
      admin
    )
    expect(putTrue.status).toBe(409)
    expect(await putTrue.json()).toEqual({
      error:
        "Email delivery is not configured; the verification requirement cannot be enabled",
      code: "EMAIL_NOT_CONFIGURED"
    })

    // 关掉开关允许成功
    const putFalse = await jsonRequest(
      ctx.env,
      "PATCH",
      "/api/admin/settings",
      { registrationEmailVerificationRequired: false },
      admin
    )
    expect(putFalse.status).toBe(200)

    const afterFalse = (await (
      await jsonRequest(ctx.env, "GET", "/api/admin/settings", undefined, admin)
    ).json()) as { registrationEmailVerificationRequired: boolean }
    expect(afterFalse.registrationEmailVerificationRequired).toBe(false)

    // 仍然未配置邮件时再试图开：依然 409，且开关保持 false
    const tryEnableAgain = await jsonRequest(
      ctx.env,
      "PATCH",
      "/api/admin/settings",
      { registrationEmailVerificationRequired: true },
      admin
    )
    expect(tryEnableAgain.status).toBe(409)

    const stillFalse = (await (
      await jsonRequest(ctx.env, "GET", "/api/admin/settings", undefined, admin)
    ).json()) as { registrationEmailVerificationRequired: boolean }
    expect(stillFalse.registrationEmailVerificationRequired).toBe(false)
  })

  it("邮件配置后允许开启开关", async () => {
    const ctx = await initializedContext()
    const admin = await adminSession(ctx.env, ADMIN)

    // 先关掉开关
    await jsonRequest(
      ctx.env,
      "PUT",
      "/api/admin/settings",
      { registrationEmailVerificationRequired: false },
      admin
    )

    // 配置邮件
    await enableSmtpConfig(ctx.env)

    // 再次开启开关：成功
    const enableRes = await jsonRequest(
      ctx.env,
      "PUT",
      "/api/admin/settings",
      { registrationEmailVerificationRequired: true },
      admin
    )
    expect(enableRes.status).toBe(200)

    const view = (await (
      await jsonRequest(ctx.env, "GET", "/api/admin/settings", undefined, admin)
    ).json()) as {
      registrationEmailVerificationRequired: boolean
      emailConfigured: boolean
    }
    expect(view.registrationEmailVerificationRequired).toBe(true)
    expect(view.emailConfigured).toBe(true)
  })
})

describe("开关与守卫对注册与登录的影响", () => {
  it("首个用户（管理员）恒免验证（email_verified=1），即使开关开且邮件未配", async () => {
    const ctx = await initializedContext()
    sendSmtpMessageMock.mockClear()

    const res = await registerUser(ctx, ADMIN)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      success: true,
      approvalRequired: false,
      emailVerificationRequired: false
    })

    const user = userRow(ctx, ADMIN)
    expect(user?.role).toBe("admin")
    expect(user?.email_verified).toBe(1)
    expect(sendSmtpMessageMock).not.toHaveBeenCalled()
  })

  it("开关关闭时：普通用户注册直接已验证（email_verified=1），不发信，审批后直接可登录", async () => {
    const ctx = await initializedContext()
    const admin = await adminSession(ctx.env, ADMIN)
    await enableSmtpConfig(ctx.env)
    sendSmtpMessageMock.mockClear()

    // 关闭邮箱验证开关
    await jsonRequest(
      ctx.env,
      "PUT",
      "/api/admin/settings",
      { registrationEmailVerificationRequired: false },
      admin
    )

    const res = await registerUser(ctx, USER1)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      success: true,
      approvalRequired: true,
      emailVerificationRequired: false
    })

    const user = userRow(ctx, USER1)
    expect(user?.email_verified).toBe(1)
    expect(sendSmtpMessageMock).not.toHaveBeenCalled()

    // 审批通过后即可登录，无需任何邮箱验证
    await approveUser(ctx, admin, USER1)
    const loginRes = await jsonRequest(ctx.env, "POST", "/api/auth/login", {
      email: USER1,
      password: PASSWORD
    })
    expect(loginRes.status).toBe(200)
  })

  it("开关开启且配置邮件：普通用户注册 email_verified=0 且发码，未验证 403", async () => {
    const ctx = await initializedContext()
    await adminSession(ctx.env, ADMIN)
    await enableSmtpConfig(ctx.env)
    sendSmtpMessageMock.mockClear()

    const res = await registerUser(ctx, USER1)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      success: true,
      approvalRequired: true,
      emailVerificationRequired: true
    })

    const user = userRow(ctx, USER1)
    expect(user?.email_verified).toBe(0)
    expect(sendSmtpMessageMock).toHaveBeenCalledTimes(1)

    // 未验证登录报 403 EMAIL_NOT_VERIFIED
    const loginRes = await jsonRequest(ctx.env, "POST", "/api/auth/login", {
      email: USER1,
      password: PASSWORD
    })
    expect(loginRes.status).toBe(403)
    expect(await loginRes.json()).toMatchObject({
      code: "EMAIL_NOT_VERIFIED"
    })
  })

  it("开关开但邮件被撤走：新注册直接已验证，存量未验证用户登录自动自愈", async () => {
    const ctx = await initializedContext()
    const admin = await adminSession(ctx.env, ADMIN)
    await enableSmtpConfig(ctx.env)

    // 用户 1 在邮件正常时注册：email_verified=0
    await registerUser(ctx, USER1)
    expect(userRow(ctx, USER1)?.email_verified).toBe(0)

    // 管理员审批通过用户 1
    await approveUser(ctx, admin, USER1)

    // 撤走邮件配置
    await disableSmtpConfig(ctx.env)
    sendSmtpMessageMock.mockClear()

    // 1. 新注册用户 2：虽然开关仍是 true，但邮件未配，直接视为已验证且不发码
    const res2 = await registerUser(ctx, USER2)
    expect(res2.status).toBe(201)
    expect(await res2.json()).toEqual({
      success: true,
      approvalRequired: true,
      emailVerificationRequired: false
    })
    expect(userRow(ctx, USER2)?.email_verified).toBe(1)
    expect(sendSmtpMessageMock).not.toHaveBeenCalled()

    // 2. 存量未验证用户 1 尝试登录：自愈置位 email_verified=1 并成功登录
    const loginRes = await jsonRequest(ctx.env, "POST", "/api/auth/login", {
      email: USER1,
      password: PASSWORD
    })
    expect(loginRes.status).toBe(200)

    // 数据库中已经被自愈置位
    expect(userRow(ctx, USER1)?.email_verified).toBe(1)
  })
})
