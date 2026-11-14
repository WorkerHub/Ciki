/**
 * 测试用 WebAuthn 客户端：用真实 P-256 密钥生成合法的注册/认证响应，
 * 让服务端的 simplewebauthn 校验走完整路径（不 mock 内部函数）。
 */
const encoder = new TextEncoder()

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function b64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** 最小 CBOR 编码器：整数 / 文本 / 字节串 / Map / 普通对象。 */
function cbor(value: unknown): Uint8Array {
  const out: number[] = []
  const head = (major: number, length: number) => {
    if (length < 24) out.push((major << 5) | length)
    else if (length < 256) out.push((major << 5) | 24, length)
    else if (length < 65536)
      out.push((major << 5) | 25, length >> 8, length & 0xff)
    else {
      out.push(
        (major << 5) | 26,
        (length >>> 24) & 0xff,
        (length >>> 16) & 0xff,
        (length >>> 8) & 0xff,
        length & 0xff
      )
    }
  }
  const write = (input: unknown) => {
    if (typeof input === "number") {
      if (input >= 0) head(0, input)
      else head(1, -1 - input)
      return
    }
    if (typeof input === "string") {
      const bytes = encoder.encode(input)
      head(3, bytes.length)
      out.push(...bytes)
      return
    }
    if (input instanceof Uint8Array) {
      head(2, input.length)
      out.push(...input)
      return
    }
    if (input instanceof Map) {
      head(5, input.size)
      for (const [key, item] of input) {
        write(key)
        write(item)
      }
      return
    }
    if (input && typeof input === "object") {
      const entries = Object.entries(input as Record<string, unknown>)
      head(5, entries.length)
      for (const [key, item] of entries) {
        write(key)
        write(item)
      }
      return
    }
    throw new Error("cbor: unsupported value")
  }
  write(value)
  return new Uint8Array(out)
}

function u32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ])
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
}

/** WebCrypto 返回 r||s（64 字节），WebAuthn 要 DER。 */
function toDer(signature: Uint8Array): Uint8Array {
  const encodeInteger = (raw: Uint8Array): Uint8Array => {
    let start = 0
    while (start < raw.length - 1 && raw[start] === 0) start += 1
    let value = raw.slice(start)
    if (value[0] & 0x80) value = concat([new Uint8Array([0]), value])
    return concat([new Uint8Array([0x02, value.length]), value])
  }
  const r = encodeInteger(signature.slice(0, 32))
  const s = encodeInteger(signature.slice(32, 64))
  return concat([new Uint8Array([0x30, r.length + s.length]), r, s])
}

export interface TestPasskey {
  credentialId: string
  keyPair: CryptoKeyPair
}

export async function createPasskey(input: {
  rpID: string
  origin: string
  challenge: string
}): Promise<{ passkey: TestPasskey; response: unknown }> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey)
  )
  const x = raw.slice(1, 33)
  const y = raw.slice(33, 65)
  const credentialId = crypto.getRandomValues(new Uint8Array(16))
  const cose = cbor(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y]
    ])
  )
  const authData = concat([
    await sha256(encoder.encode(input.rpID)),
    new Uint8Array([0x45]), // UP | UV | AT
    u32(0),
    new Uint8Array(16), // aaguid
    new Uint8Array([
      (credentialId.length >> 8) & 0xff,
      credentialId.length & 0xff
    ]),
    credentialId,
    cose
  ])
  const clientDataJSON = encoder.encode(
    JSON.stringify({
      type: "webauthn.create",
      challenge: input.challenge,
      origin: input.origin,
      crossOrigin: false
    })
  )
  const attestationObject = cbor({
    fmt: "none",
    attStmt: {},
    authData
  })
  return {
    passkey: { credentialId: b64url(credentialId), keyPair },
    response: {
      id: b64url(credentialId),
      rawId: b64url(credentialId),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ["internal"]
      }
    }
  }
}

export async function assertPasskey(input: {
  rpID: string
  origin: string
  challenge: string
  passkey: TestPasskey
  counter: number
}): Promise<unknown> {
  const authData = concat([
    await sha256(encoder.encode(input.rpID)),
    new Uint8Array([0x05]), // UP | UV
    u32(input.counter)
  ])
  const clientDataJSON = encoder.encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: input.challenge,
      origin: input.origin,
      crossOrigin: false
    })
  )
  const clientHash = await sha256(clientDataJSON)
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      input.passkey.keyPair.privateKey,
      concat([authData, clientHash])
    )
  )
  return {
    id: input.passkey.credentialId,
    rawId: input.passkey.credentialId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64url(clientDataJSON),
      authenticatorData: b64url(authData),
      signature: b64url(toDer(signature)),
      userHandle: null
    }
  }
}
