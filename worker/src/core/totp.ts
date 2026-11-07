/**
 * TOTP（RFC 6238）生成与校验：用 otpauth，不手写 base32/HMAC（舰队纪律 §3）。
 * 密钥的落库形态由 core/secret-box.ts 决定，本模块只处理明文。
 */
import * as OTPAuth from "otpauth"

const ISSUER = "ciki"

export function generateTotpSecret(email: string): {
  secret: string
  uri: string
} {
  const secret = new OTPAuth.Secret({ size: 20 })
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret
  })
  return { secret: secret.base32, uri: totp.toString() }
}

/** 校验 6 位码，允许前后各一个时间窗（±30s）。 */
export function verifyTotpCode(secretBase32: string, code: string): boolean {
  if (!/^\d{6}$/.test(code.trim())) return false
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32)
  })
  return totp.validate({ token: code.trim(), window: 1 }) !== null
}
