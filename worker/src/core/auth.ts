/**
 * 密码哈希 / 常量时间比较 / ID 工具——按 eNotify 现行实现移植（规格 §8：
 * 哈希与凭证存储对齐现行，不新发明）。
 *
 * 密码格式：`saltHex:hashHex`，PBKDF2-SHA256，100000 次，32 字节盐、32 字节输出。
 */

function bufToHex(buf: Uint8Array | ArrayBuffer): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(32))
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  )
  const hashBuffer = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256
  )
  return `${bufToHex(salt)}:${bufToHex(hashBuffer)}`
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const colonIdx = stored.indexOf(":")
  if (colonIdx === -1) return false

  const saltHex = stored.slice(0, colonIdx)
  const storedHash = stored.slice(colonIdx + 1)
  if (!saltHex || !storedHash) return false

  const salt = hexToBytes(saltHex)
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  )
  const hashBuffer = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256
  )
  const hashHex = bufToHex(hashBuffer)

  if (hashHex.length !== storedHash.length) return false
  let diff = 0
  for (let i = 0; i < hashHex.length; i++) {
    diff |= hashHex.charCodeAt(i) ^ storedHash.charCodeAt(i)
  }
  return diff === 0
}

/** 常量时间字符串比较（先各自 SHA-256，再逐字节异或）。 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ])
  const va = new Uint8Array(ha)
  const vb = new Uint8Array(hb)
  let diff = 0
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i]
  return diff === 0
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  )
  return bufToHex(digest)
}

/** 随机不透明令牌：32 字节 → base64url（43 字符，无填充）。 */
export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  let binary = ""
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i])
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
