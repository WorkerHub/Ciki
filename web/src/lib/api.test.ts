import { describe, expect, it } from "vitest"
import { ApiError, describeApiError } from "@/lib/api"
import { describeWebAuthnError } from "@/lib/webauthn"

/**
 * 规格 §8「TOTP 两步登录」的失败提示。
 *
 * 后端的 401 一个状态码两种含义：两步验证输错码 / 挑战过期 / 账号密码错，
 * 与会话中间件的 `Unauthorized`（Cookie 失效）同码。这里把每个入口逐一钉住，
 * 防止统一 401 处理再把「验证码不对」说成「登录状态已失效」。
 * 断言的英文原文即 worker 的冻结返回（worker/src/routes/auth.ts、auth-2fa.ts）。
 */
function apiError(
  status: number,
  message: string,
  path: string,
  code?: string,
  retryAfter?: number
) {
  return new ApiError(
    status,
    message,
    code,
    retryAfter,
    { error: message },
    path
  )
}

const SESSION_EXPIRED = "登录状态已失效，请重新登录。"

describe("describeApiError：登录 / 两步验证入口", () => {
  it("两步验证输错码 → 提示验证码不正确，不再说会话过期", () => {
    const error = apiError(401, "Invalid verification code", "/auth/2fa/verify")
    expect(describeApiError(error)).toBe("验证码不正确，请重新输入。")
    expect(describeApiError(error)).not.toBe(SESSION_EXPIRED)
  })

  it("同一 tempToken 失败 5 次后挑战作废 → 提示返回上一步重新登录", () => {
    const error = apiError(
      401,
      "Invalid or expired 2FA session",
      "/auth/2fa/verify"
    )
    expect(describeApiError(error)).toBe(
      "两步验证已失效，请返回上一步重新登录。"
    )
  })

  it("两步验证尝试过于频繁 → 提示稍后再试", () => {
    const error = apiError(
      429,
      "Too many requests",
      "/auth/2fa/verify",
      "RATE_LIMITED"
    )
    expect(describeApiError(error)).toBe("尝试次数过多，请稍后再试。")
  })

  it("邮箱或密码错 → 提示邮箱或密码不正确，不再说会话过期", () => {
    const error = apiError(401, "Invalid credentials", "/auth/login")
    expect(describeApiError(error)).toBe("邮箱或密码不正确。")
  })

  it("Passkey 登录验证未通过 → 中文提示，不摆英文原文", () => {
    const error = apiError(
      401,
      "Verification failed",
      "/auth/2fa/passkey/authenticate/verify"
    )
    expect(describeApiError(error)).toBe("Passkey 验证未通过，请重试。")
  })

  it("Passkey 挑战过期 → 同「两步验证已失效」", () => {
    const error = apiError(
      401,
      "Invalid or expired 2FA session",
      "/auth/2fa/passkey/authenticate/options"
    )
    expect(describeApiError(error)).toBe(
      "两步验证已失效，请返回上一步重新登录。"
    )
  })

  it("设置页启用 TOTP 时输错码（400 Invalid code）→ 同一句验证码提示", () => {
    const error = apiError(400, "Invalid code", "/auth/2fa/totp/enable")
    expect(describeApiError(error)).toBe("验证码不正确，请重新输入。")
  })

  it("登录表单上没见过的 401 文案也不说会话过期（后端改词的兜底）", () => {
    const error = apiError(401, "Nope", "/auth/2fa/verify")
    expect(describeApiError(error)).toBe("验证未通过，请重试。")
  })

  it("describeWebAuthnError 对接口错误也走统一翻译", () => {
    const error = apiError(
      401,
      "Invalid or expired 2FA session",
      "/auth/2fa/passkey/authenticate/verify"
    )
    expect(describeWebAuthnError(error)).toBe(
      "两步验证已失效，请返回上一步重新登录。"
    )
  })
})

describe("describeApiError：会话过期的路径不受影响", () => {
  it("/me 的 401 仍然提示重新登录", () => {
    const error = apiError(401, "Unauthorized", "/me")
    expect(describeApiError(error)).toBe(SESSION_EXPIRED)
  })

  it("业务接口的 401 仍然提示重新登录", () => {
    expect(describeApiError(apiError(401, "Unauthorized", "/pages"))).toBe(
      SESSION_EXPIRED
    )
    expect(
      describeApiError(apiError(401, "Unauthorized", "/admin/users"))
    ).toBe(SESSION_EXPIRED)
  })

  it("没有路径信息的 401（老调用点）仍按会话过期处理", () => {
    expect(describeApiError(new ApiError(401, "Unauthorized"))).toBe(
      SESSION_EXPIRED
    )
  })

  it("非 ApiError 仍是网络异常", () => {
    expect(describeApiError(new Error("boom"))).toBe("网络异常，请稍后重试")
  })
})
