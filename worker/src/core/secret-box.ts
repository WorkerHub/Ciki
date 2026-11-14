/**
 * 敏感字段的静态加密（规格补遗：TOTP 密钥用 ENCRYPTION_KEY 做 AES-GCM 加密落库）。
 *
 * ENCRYPTION_KEY 接受两种写法（值必须先在密码管理器留底，再进 GitHub Secrets）：
 * - base64（32 字节，44 字符）
 * - hex（32 字节，64 字符）
 *
 * 密文格式：`v1.<ivBase64url>.<ciphertextBase64url>`（IV 12 字节，
 * ciphertext 含 GCM tag；AAD 绑定用途与用户，防止密文在用户间挪用）。
 */

const encoder = new TextEncoder()

function base64urlFromBytes(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function bytesFromBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
  const pad = padded.length % 4
  const binary = atob(pad ? padded + "=".repeat(4 - pad) : padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 把 ENCRYPTION_KEY 解析成 32 字节；非法（含占位值）返回 null。 */
export function parseEncryptionKey(
  raw: string | undefined | null
): Uint8Array | null {
  const value = (raw ?? "").trim()
  if (!value) return null
  if (/_PLACEHOLDER$/i.test(value) || /^replace-with/i.test(value)) return null

  let bytes: Uint8Array | null = null
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
      bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
    }
  } else if (/^[A-Za-z0-9+/=_-]+$/.test(value)) {
    try {
      bytes = bytesFromBase64url(value)
    } catch {
      return null
    }
  }
  return bytes?.length === 32 ? bytes : null
}

export function isEncryptionKeyUsable(raw: string | undefined | null): boolean {
  return parseEncryptionKey(raw) !== null
}

async function importKey(raw: string): Promise<CryptoKey> {
  const bytes = parseEncryptionKey(raw)
  if (!bytes) throw new Error("ENCRYPTION_KEY is missing or invalid")
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt"
  ])
}

export async function encryptSecret(
  rawKey: string,
  plaintext: string,
  aad: string
): Promise<string> {
  const key = await importKey(rawKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(plaintext)
  )
  return `v1.${base64urlFromBytes(iv)}.${base64urlFromBytes(new Uint8Array(ciphertext))}`
}

/** 解密失败（密钥不符、密文被改）会抛错，由调用方按 500 兜底，不回显细节。 */
export async function decryptSecret(
  rawKey: string,
  payload: string,
  aad: string
): Promise<string> {
  const parts = payload.split(".")
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new Error("Unsupported secret payload")
  }
  const key = await importKey(rawKey)
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytesFromBase64url(parts[1]),
      additionalData: encoder.encode(aad)
    },
    key,
    bytesFromBase64url(parts[2])
  )
  return new TextDecoder().decode(plaintext)
}
