import {
  type AuthenticationResponseJSON,
  browserSupportsWebAuthn,
  type RegistrationResponseJSON,
  startAuthentication,
  startRegistration
} from "@simplewebauthn/browser"

type JsonRecord = Record<string, unknown>

/**
 * 契约里 passkey 的两个 options 端点直接回 WebAuthn 的 JSON 形态
 * （challenge/allowCredentials 等为 base64url 字符串），正是
 * @simplewebauthn/browser 的 optionsJSON 入参。若后端把对象包在 options 里也兼容。
 */
function unwrapOptions(raw: JsonRecord): JsonRecord {
  const candidate = (raw.options ?? raw.publicKey ?? raw) as
    | JsonRecord
    | undefined
  if (!candidate || typeof candidate.challenge !== "string") {
    throw new Error("服务器返回的 WebAuthn 参数不完整（缺少 challenge）")
  }
  return candidate
}

export function webauthnSupported(): boolean {
  return typeof window !== "undefined" && browserSupportsWebAuthn()
}

export function authenticationCredential(
  raw: JsonRecord
): Promise<AuthenticationResponseJSON> {
  return startAuthentication({ optionsJSON: unwrapOptions(raw) as never })
}

export function registrationCredential(
  raw: JsonRecord
): Promise<RegistrationResponseJSON> {
  return startRegistration({ optionsJSON: unwrapOptions(raw) as never })
}

/** 用户取消（点了取消/超时）不该当成报错弹红条。 */
export function isWebAuthnCancelled(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  return name === "NotAllowedError" || name === "AbortError"
}

export function describeWebAuthnError(error: unknown): string {
  if (isWebAuthnCancelled(error)) return "已取消 Passkey 操作"
  const message = error instanceof Error ? error.message : ""
  return message || "Passkey 操作失败，请重试"
}
