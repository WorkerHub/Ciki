/**
 * 注册邮箱验证（单 A #85 冻结契约的前端常量与入口状态）。
 *
 * 三个页面共用同一份字面量，别各写各的：
 * - 注册页成功后带 `codeSent` 跳到验证页（服务端在那次注册里已经发过码）；
 * - 登录页遇到 403 `EMAIL_NOT_VERIFIED` 时带 `email` 跳过来；
 * - 直接开 `/verify-email?email=…` 的链接也要能用（无状态可带）。
 */

/** 验证页地址（未登录可访问；`?email=` 只用于直接开链接的场合）。 */
export const VERIFY_EMAIL_PATH = "/verify-email"

/** 重发冷却秒数（契约固定 60，服务端 429 的 retryAfter 优先）。 */
export const RESEND_COOLDOWN_SECONDS = 60

/** 验证码有效期（分钟），只用于页面上的提示文案。 */
export const VERIFY_CODE_TTL_MINUTES = 10

/** 跳到验证页时携带的路由状态（react-router `state`，不进 URL）。 */
export interface VerifyEmailNavState {
  email?: string
  /** 服务端刚发过一封（注册成功即发）：进页先按冷却计，避免第一次点击必然撞 429。 */
  codeSent?: boolean
  /** 账号还在等管理员批准：验证成功页要如实说明「还要等审批」。 */
  approvalRequired?: boolean
}

export interface VerifyEmailEntry {
  email: string
  codeSent: boolean
  approvalRequired: boolean
}

/** 归一入口状态：路由 state 优先，其次 `?email=`。 */
export function verifyEmailEntry(
  state: unknown,
  emailParam: string | null
): VerifyEmailEntry {
  const nav = (state ?? {}) as Partial<VerifyEmailNavState>
  const fromState = typeof nav.email === "string" ? nav.email.trim() : ""
  const fromQuery = (emailParam ?? "").trim()
  return {
    email: fromState || fromQuery,
    codeSent: nav.codeSent === true,
    approvalRequired: nav.approvalRequired === true
  }
}
