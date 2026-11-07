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
  type VerifiedRegistrationResponse
} from "@simplewebauthn/server"

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
      residentKey: "preferred",
      userVerification: "preferred"
    }
  })
}

export async function checkRegistration(input: {
  response: RegistrationResponseJSON
  expectedChallenge: string
  expectedOrigin: string
  expectedRPID: string
}): Promise<VerifiedRegistrationResponse> {
  return verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.expectedOrigin,
    expectedRPID: input.expectedRPID
  })
}

export async function buildAuthenticationOptions(input: {
  rpID: string
  credentials: StoredPasskey[]
}) {
  return generateAuthenticationOptions({
    rpID: input.rpID,
    allowCredentials: input.credentials.map((credential) => ({
      id: credential.credentialId,
      type: "public-key" as const
    })),
    userVerification: "preferred"
  })
}

export async function checkAuthentication(input: {
  response: AuthenticationResponseJSON
  expectedChallenge: string
  expectedOrigin: string
  expectedRPID: string
  credential: StoredPasskey
}) {
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
    }
  })
}
