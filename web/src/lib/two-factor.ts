import type { Me } from "@/lib/api"

/**
 * 账号是否已经有一个可用的第二因子。
 * 契约：已有因子时，新增/启用因子（TOTP setup/enable、Passkey 注册、邮箱验证码
 * send-verify/enable）要带密码重认证；一个因子都没有（刚被要求配置 2FA 的受限
 * 会话）则不需要密码。邮箱验证码已开启同样算「已有因子」。
 */
export function hasSecondFactor(
  twofa: Me["twofa"] | null | undefined
): boolean {
  if (!twofa) return false
  return (
    twofa.totpEnabled ||
    twofa.passkeyCount > 0 ||
    twofa.emailOtpEnabled === true
  )
}

/** 新增因子这一动作是否需要先输入密码。 */
export function needsReauthToAddFactor(
  twofa: Me["twofa"] | null | undefined
): boolean {
  return hasSecondFactor(twofa)
}
