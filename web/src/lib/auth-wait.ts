import { ApiError, describeApiError } from "@/lib/api"

/**
 * 邮箱验证码类流程共用的「还要等多久」文案（找回密码、注册邮箱验证等）：
 * 429 的 `retryAfter` 是服务端给的剩余秒数，可以直接说给用户听；
 * 其余错误照 `describeApiError` 统一翻译。
 */

/** 等待秒数的说人话版本：一分钟以内报秒，更长报分钟（429 的 retryAfter 可能是小时窗）。 */
export function formatWait(seconds: number): string {
  const value = Math.max(1, Math.round(seconds))
  if (value < 60) return `${value} 秒`
  return `${Math.ceil(value / 60)} 分钟`
}

/** 限流提示带上服务端给的真实剩余时间；其它错误照统一翻译。 */
export function waitText(error: unknown): string {
  if (error instanceof ApiError && error.retryAfter) {
    return `操作过于频繁，请在 ${formatWait(error.retryAfter)}后重试。`
  }
  return describeApiError(error)
}
