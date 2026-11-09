import { describe, expect, it } from "vitest"
import {
  encodeUtf8Base64,
  redactSmtpError,
  type SmtpConnectOptions,
  SmtpSession,
  type SmtpSocketLike,
  type SmtpTransportConfig,
  sendSmtpMessage
} from "../src/services/smtp-transport"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * 脚本化的假 SMTP 服务端：按顺序吐出预置应答，记录客户端写出的命令。
 * `startTls()` 返回共享同一应答队列的新 socket（等价于升级后的 TLS 流）。
 */
function fakeServer(responses: string[]) {
  const queue = responses.map((line) =>
    encoder.encode(line.endsWith("\r\n") ? line : `${line}\r\n`)
  )
  const writes: string[] = []
  let tlsCalls = 0

  const createSocket = (): SmtpSocketLike => {
    const readable = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const next = queue.shift()
          if (next) controller.enqueue(next)
          else controller.close()
        }
      },
      // 不预读：保证 STARTTLS 升级前后的应答按脚本顺序到达。
      { highWaterMark: 0 }
    )
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(decoder.decode(chunk))
      }
    })
    return {
      readable,
      writable,
      startTls() {
        tlsCalls += 1
        return createSocket()
      },
      close: async () => {}
    }
  }

  return {
    socket: createSocket(),
    writes,
    tlsCalls: () => tlsCalls,
    sent: () => writes.join("")
  }
}

function baseConfig(
  overrides: Partial<SmtpTransportConfig> = {}
): SmtpTransportConfig {
  return {
    host: "smtp.example.com",
    port: 2525,
    encryption: "none",
    username: "",
    password: "",
    from: "noreply@example.com",
    fromName: "Ciki",
    ...overrides
  }
}

const message = {
  to: "user@example.com",
  subject: "验证码",
  html: "<p>123456</p>"
}

describe("SMTP 传输：加密三态", () => {
  it("none：明文连接（secureTransport=off），不发 STARTTLS", async () => {
    const server = fakeServer([
      "220 smtp.example.com ESMTP",
      "250-smtp.example.com\r\n250 AUTH LOGIN",
      "250 2.1.0 Ok",
      "250 2.1.5 Ok",
      "354 End data",
      "250 2.0.0 Ok: queued"
    ])
    const calls: SmtpConnectOptions[] = []
    const result = await sendSmtpMessage(
      baseConfig(),
      message,
      async (options) => {
        calls.push(options)
        return server.socket
      }
    )

    expect(result).toEqual({ success: true })
    expect(calls).toEqual([
      { hostname: "smtp.example.com", port: 2525, secureTransport: "off" }
    ])
    expect(server.sent()).not.toContain("STARTTLS")
    expect(server.sent()).toContain("MAIL FROM:<noreply@example.com>")
    expect(server.sent()).toContain("RCPT TO:<user@example.com>")
    expect(server.sent()).toContain("DATA")
  })

  it("tls：隐式 TLS（secureTransport=on），不发 STARTTLS", async () => {
    const server = fakeServer([
      "220 smtp.example.com ESMTP",
      "250 smtp.example.com",
      "250 2.1.0 Ok",
      "250 2.1.5 Ok",
      "354 End data",
      "250 2.0.0 Ok: queued"
    ])
    const calls: SmtpConnectOptions[] = []
    const result = await sendSmtpMessage(
      baseConfig({ port: 465, encryption: "tls" }),
      message,
      async (options) => {
        calls.push(options)
        return server.socket
      }
    )

    expect(result).toEqual({ success: true })
    expect(calls[0].secureTransport).toBe("on")
    expect(server.sent()).not.toContain("STARTTLS")
    expect(server.tlsCalls()).toBe(0)
  })

  it("starttls：EHLO → STARTTLS → 220 → startTls() → 再 EHLO，然后才 AUTH/发信", async () => {
    const server = fakeServer([
      "220 smtp.example.com ESMTP",
      "250-smtp.example.com\r\n250-STARTTLS\r\n250 AUTH LOGIN",
      "220 2.0.0 Ready to start TLS",
      "250 smtp.example.com",
      "334 VXNlcm5hbWU6",
      "334 UGFzc3dvcmQ6",
      "235 2.7.0 Authentication successful",
      "250 2.1.0 Ok",
      "250 2.1.5 Ok",
      "354 End data",
      "250 2.0.0 Ok: queued"
    ])
    const calls: SmtpConnectOptions[] = []
    const result = await sendSmtpMessage(
      baseConfig({
        port: 587,
        encryption: "starttls",
        username: "mailer@example.com",
        password: "p@ss"
      }),
      message,
      async (options) => {
        calls.push(options)
        return server.socket
      }
    )

    expect(result).toEqual({ success: true })
    expect(calls[0].secureTransport).toBe("starttls")
    expect(server.tlsCalls()).toBe(1)
    const sent = server.sent()
    const startTlsIndex = sent.indexOf("STARTTLS")
    const secondEhlo = sent.indexOf("EHLO", startTlsIndex + 1)
    expect(startTlsIndex).toBeGreaterThan(-1)
    expect(secondEhlo).toBeGreaterThan(startTlsIndex)
    expect(sent.indexOf("AUTH LOGIN")).toBeGreaterThan(secondEhlo)
    expect(sent.indexOf("MAIL FROM")).toBeGreaterThan(secondEhlo)
  })

  it("starttls 失败即失败：服务器不回 220 时绝不回退明文，也不发 AUTH/邮件", async () => {
    const server = fakeServer([
      "220 smtp.example.com ESMTP",
      "250 smtp.example.com",
      "502 5.5.1 Command not implemented"
    ])
    const result = await sendSmtpMessage(
      baseConfig({
        encryption: "starttls",
        username: "mailer@example.com",
        password: "p@ss"
      }),
      message,
      async () => server.socket
    )

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain("STARTTLS")
    expect(server.tlsCalls()).toBe(0)
    const sent = server.sent()
    expect(sent).not.toContain("AUTH LOGIN")
    expect(sent).not.toContain("MAIL FROM")
    expect(sent).not.toContain("DATA")
  })
})

describe("SMTP 传输：认证、报文与失败兜底", () => {
  it("未配用户名密码时不发 AUTH；配了就 AUTH LOGIN 且 base64 编码", async () => {
    const noAuth = fakeServer([
      "220 smtp.example.com ESMTP",
      "250 smtp.example.com",
      "250 2.1.0 Ok",
      "250 2.1.5 Ok",
      "354 End data",
      "250 2.0.0 Ok: queued"
    ])
    await sendSmtpMessage(baseConfig(), message, async () => noAuth.socket)
    expect(noAuth.sent()).not.toContain("AUTH")

    const withAuth = fakeServer([
      "220 smtp.example.com ESMTP",
      "250 smtp.example.com",
      "334 VXNlcm5hbWU6",
      "334 UGFzc3dvcmQ6",
      "235 2.7.0 Authentication successful",
      "250 2.1.0 Ok",
      "250 2.1.5 Ok",
      "354 End data",
      "250 2.0.0 Ok: queued"
    ])
    const result = await sendSmtpMessage(
      baseConfig({ username: "mailer@example.com", password: "p@ss" }),
      message,
      async () => withAuth.socket
    )
    expect(result).toEqual({ success: true })
    const sent = withAuth.sent()
    expect(sent).toContain("AUTH LOGIN")
    expect(sent).toContain(`${encodeUtf8Base64("mailer@example.com")}\r\n`)
    expect(sent).toContain(`${encodeUtf8Base64("p@ss")}\r\n`)
    expect(sent).not.toContain("p@ss")
  })

  it("报文：Subject 为 UTF-8 base64、正文 base64 折行，头部值剥 CR/LF", async () => {
    const server = fakeServer([
      "220 smtp.example.com ESMTP",
      "250 smtp.example.com",
      "250 2.1.0 Ok",
      "250 2.1.5 Ok",
      "354 End data",
      "250 2.0.0 Ok: queued"
    ])
    const session = new SmtpSession(server.socket)
    await session.expect(220, "greeting")
    await session.ehlo("example.com")
    await session.sendMessage(
      "noreply@example.com",
      "Ciki\r\nBcc: evil@example.com",
      "user@example.com",
      "你好\r\nBcc: evil@example.com",
      `<p>${"x".repeat(200)}</p>`
    )

    const sent = server.sent()
    const headerBlock = sent.split("\r\n\r\n")[0]
    const headerLines = headerBlock.split("\r\n")
    // 头注入不成立：没有任何一行是注入出来的 Bcc。
    expect(
      headerLines.filter((line) => line.toLowerCase().startsWith("bcc:"))
    ).toHaveLength(0)
    expect(headerLines.filter((line) => line.startsWith("From:"))).toHaveLength(
      1
    )
    expect(sent).toContain(
      "From: CikiBcc: evil@example.com <noreply@example.com>"
    )
    expect(sent).toContain(
      `Subject: =?UTF-8?B?${encodeUtf8Base64("你好Bcc: evil@example.com")}?=`
    )
    expect(sent).toContain("To: user@example.com")
    // 正文按 76 字符折行（base64 行长度 ≤ 76）。
    const body = sent.split("\r\n\r\n")[1]
    for (const line of body.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76)
    }
  })

  it("认证失败：返回脱敏后的原因，密码与其 base64 都变成 ***", async () => {
    const password = "s3cret-pass"
    const server = fakeServer([
      "220 smtp.example.com ESMTP",
      "250 smtp.example.com",
      "334 VXNlcm5hbWU6",
      "334 UGFzc3dvcmQ6",
      `535 5.7.8 bad credentials (${password} / ${encodeUtf8Base64(password)})`
    ])
    const result = await sendSmtpMessage(
      baseConfig({ username: "mailer@example.com", password }),
      message,
      async () => server.socket
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain("***")
      expect(result.error).not.toContain(password)
      expect(result.error).not.toContain(encodeUtf8Base64(password))
    }
    expect(server.sent()).not.toContain("MAIL FROM")
  })

  it("连接失败：不抛错，返回失败原因", async () => {
    const result = await sendSmtpMessage(baseConfig(), message, async () => {
      throw new Error("connect: connection refused")
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain("connection refused")
  })

  it("redactSmtpError：明文与 base64 都替换成 ***", () => {
    const password = "p@ss word"
    const redacted = redactSmtpError(
      new Error(`bad ${password} / ${encodeUtf8Base64(password)}`),
      password
    )
    expect(redacted).not.toContain(password)
    expect(redacted).not.toContain(encodeUtf8Base64(password))
    expect(redacted).toContain("***")
  })
})
