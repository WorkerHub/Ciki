import { describe, expect, it } from "vitest"
import { hasSecondFactor, needsReauthToAddFactor } from "@/lib/two-factor"

const none = {
  totpEnabled: false,
  passkeyEnabled: false,
  passkeyCount: 0,
  emailOtpEnabled: false
}
const withTotp = {
  totpEnabled: true,
  passkeyEnabled: false,
  passkeyCount: 0,
  emailOtpEnabled: false
}
const withPasskey = {
  totpEnabled: false,
  passkeyEnabled: true,
  passkeyCount: 2,
  emailOtpEnabled: false
}
const withEmailOtp = {
  totpEnabled: false,
  passkeyEnabled: false,
  passkeyCount: 0,
  emailOtpEnabled: true
}

describe("新增因子时的重认证判定", () => {
  it("没有任何因子时不需要密码", () => {
    expect(hasSecondFactor(none)).toBe(false)
    expect(needsReauthToAddFactor(none)).toBe(false)
    expect(needsReauthToAddFactor(null)).toBe(false)
  })

  it("TOTP 已开启时必须重认证", () => {
    expect(needsReauthToAddFactor(withTotp)).toBe(true)
  })

  it("已有 passkey 时同样必须重认证", () => {
    expect(needsReauthToAddFactor(withPasskey)).toBe(true)
  })

  it("邮箱验证码已开启也算已有因子，再开其它方式要重认证", () => {
    expect(hasSecondFactor(withEmailOtp)).toBe(true)
    expect(needsReauthToAddFactor(withEmailOtp)).toBe(true)
  })
})
