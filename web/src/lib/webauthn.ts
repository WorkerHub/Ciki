import {
  type AuthenticationResponseJSON,
  browserSupportsWebAuthn,
  type RegistrationResponseJSON,
  startAuthentication,
  startRegistration
} from "@simplewebauthn/browser"
import { i18n } from "@/i18n"
import { ApiError, describeApiError } from "@/lib/api"

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
    throw new Error(i18n.t("errors.webauthn.missingChallenge"))
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
  // 端点自己回的错误（挑战过期、验证未通过）走统一翻译，别把后端的英文原文
  // 直接摆给用户；只有浏览器侧 WebAuthn 失败才用 error.message。
  if (error instanceof ApiError) return describeApiError(error)
  if (isWebAuthnCancelled(error)) return i18n.t("errors.webauthn.cancelled")
  const message = error instanceof Error ? error.message : ""
  return message || i18n.t("errors.webauthn.failed")
}
