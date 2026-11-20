/**
 * WebAuthn / Passkey：薄封装 @simplewebauthn/server（v14）。
 * RP ID 取请求 host、expectedOrigin 取请求 origin；挑战由 routes 层存入
 * auth_challenges，本模块只负责 options 生成与响应校验。
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse
} from "@simplewebauthn/server"
import { isoBase64URL } from "@simplewebauthn/server/helpers"

export interface StoredPasskey {
  credentialId: string
  publicKey: string // base64
  counter: number
}

export async function buildRegistrationOptions(input: {
  rpID: string
  rpName: string
  user: { id: string; email: string }
  existing: StoredPasskey[]
}) {
  const encoded = new TextEncoder().encode(input.user.id)
  const userID = new Uint8Array(encoded.byteLength)
  userID.set(encoded)
  return generateRegistrationOptions({
    rpName: input.rpName,
    rpID: input.rpID,
    userID,
    userName: input.user.email,
    userDisplayName: input.user.email,
    attestationType: "none",
    excludeCredentials: input.existing.map((credential) => ({
      id: credential.credentialId,
      type: "public-key" as const
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required"
    }
  })
}

export async function checkRegistration(input: {
  response: RegistrationResponseJSON
  expectedChallenge: string
  expectedOrigin: string
  expectedRPID: string
  requireUserVerification?: boolean
}): Promise<VerifiedRegistrationResponse> {
  return verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.expectedOrigin,
    expectedRPID: input.expectedRPID,
    requireUserVerification: input.requireUserVerification ?? true
  })
}

export async function buildAuthenticationOptions(input: {
  rpID: string
  credentials?: StoredPasskey[]
  userVerification?: "discouraged" | "preferred" | "required"
}) {
  return generateAuthenticationOptions({
    rpID: input.rpID,
    allowCredentials: input.credentials?.map((credential) => ({
      id: credential.credentialId,
      type: "public-key" as const
    })),
    userVerification: input.userVerification ?? "preferred"
  })
}

export async function buildPasswordlessAuthenticationOptions(input: {
  rpID: string
}) {
  return generateAuthenticationOptions({
    rpID: input.rpID,
    userVerification: "required"
  })
}

export async function checkAuthentication(input: {
  response: AuthenticationResponseJSON
  expectedChallenge: string
  expectedOrigin: string
  expectedRPID: string
  credential: StoredPasskey
  requireUserVerification?: boolean
}): Promise<VerifiedAuthenticationResponse> {
  return verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.expectedOrigin,
    expectedRPID: input.expectedRPID,
    credential: {
      id: input.credential.credentialId,
      publicKey: Uint8Array.from(atob(input.credential.publicKey), (c) =>
        c.charCodeAt(0)
      ),
      counter: input.credential.counter
    },
    requireUserVerification: input.requireUserVerification ?? true
  })
}

/**
 * 解析客户端返回的 userHandle。
 * 规范中 WebAuthn assertion 的 userHandle 是 ArrayBuffer（@simplewebauthn 序列化为 base64url）；
 * 本系统 user.id 为 UTF-8 字节存入，此处反解并归一为正整数账号主键。
 */
export function parseUserHandle(userHandle: unknown): number | null {
  if (
    typeof userHandle === "number" &&
    Number.isSafeInteger(userHandle) &&
    userHandle > 0
  ) {
    return userHandle
  }
  if (typeof userHandle !== "string" || !userHandle.trim()) {
    return null
  }
  const trimmed = userHandle.trim()
  try {
    const text = isoBase64URL.toUTF8String(trimmed)
    const id = Number(text)
    if (Number.isSafeInteger(id) && id > 0) {
      return id
    }
  } catch {}
  const directId = Number(trimmed)
  if (Number.isSafeInteger(directId) && directId > 0) {
    return directId
  }
  return null
}

/**
 * 从 WebAuthn 的 clientDataJSON（base64url）中提取挑战字符串。
 */
export function extractChallengeFromClientData(
  clientDataJSON: string
): string | null {
  if (typeof clientDataJSON !== "string" || !clientDataJSON.trim()) {
    return null
  }
  try {
    const text = isoBase64URL.toUTF8String(clientDataJSON.trim())
    const parsed = JSON.parse(text)
    return typeof parsed?.challenge === "string" ? parsed.challenge : null
  } catch {
    return null
  }
}
