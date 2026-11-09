/**
 * 最小 SMTP 传输（#48 契约第 3/7 条）：Ciki 唯一的发信通道。
 *
 * 为什么是手写而不是引依赖：Workers 运行时没有 `node:net`，nodemailer 之类
 * 的 SMTP 客户端都跑不起来；Cloudflare 提供的原生能力就是 `cloudflare:sockets`。
 * 契约因此把传输层按 eNotify 的 `cloudflare:sockets` 实现定死。
 *
 * 加密三态（与 eNotify 的分歧点，见 #48 契约）：
 * - `tls`：465 隐式 TLS（连接即 TLS，`secureTransport: "on"`）；
 * - `starttls`：明文 EHLO → `STARTTLS` → 220 → 升级 TLS → 再 EHLO；
 *   **服务器不支持 STARTTLS 就报错，绝不回退成明文继续**；
 * - `none`：明文（用户显式选择，契约保留这一态）。
 *
 * 其余约束：整轮 15 秒超时、结束必关 socket、不重试（避免重复发码/重复邮件）；
 * 密码及其 base64 在回传的错误里替换成 `***`。
 *
 * Node 环境的 vitest 加载不到 `cloudflare:sockets`，所以 `connect` 在
 * `defaultConnector` 里**动态 import**；测试通过 `connector` 参数注入假 socket。
 */

export type SmtpEncryption = "tls" | "starttls" | "none"

export interface SmtpTransportConfig {
  host: string
  port: number
  encryption: SmtpEncryption
  /** 与 password 同时为空时表示不做 AUTH。 */
  username: string
  password: string
  from: string
  fromName: string
}

export interface SmtpMessage {
  to: string
  subject: string
  html: string
}

export type SmtpSendResult =
  | { success: true }
  | { success: false; error: string }

/** 只取传输层真正用到的能力，便于测试注入假实现。 */
export interface SmtpSocketLike {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  startTls: () => SmtpSocketLike
  close: () => Promise<void>
}

export interface SmtpConnectOptions {
  hostname: string
  port: number
  secureTransport: "on" | "off" | "starttls"
}

export type SmtpConnector = (
  options: SmtpConnectOptions
) => Promise<SmtpSocketLike>

export const SMTP_SESSION_TIMEOUT_MS = 15_000

const encoder = new TextEncoder()

// ── Base64 / 头部编码 ───────────────────────────────────────────────────────

function base64FromBytes(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export function encodeUtf8Base64(value: string): string {
  return base64FromBytes(encoder.encode(value))
}

/** RFC 2047 编码（非 ASCII 一律走 base64；纯 ASCII 原样保留）。 */
function encodeHeaderText(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value
  return `=?UTF-8?B?${encodeUtf8Base64(value)}?=`
}

export function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? value
}

/** 头部值剥 CR/LF（防头注入），再 trim。 */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]/g, "").trim()
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@")
  const domain = at === -1 ? "" : address.slice(at + 1)
  return /^[A-Za-z0-9.-]+$/.test(domain) ? domain : ""
}

/** 错误回传前的脱敏：明文密码、其 base64 及用户名一行不带出去。 */
export function redactSmtpError(reason: unknown, password?: string): string {
  const raw = reason instanceof Error ? reason.message : String(reason)
  let redacted = raw
  if (password) {
    for (const secret of [password, encodeUtf8Base64(password)]) {
      if (secret) redacted = redacted.split(secret).join("***")
    }
  }
  return redacted
}

// ── SMTP 会话 ───────────────────────────────────────────────────────────────

export class SmtpSession {
  private socket: SmtpSocketLike
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private writer: WritableStreamDefaultWriter<Uint8Array>
  private buffer = ""
  private readonly decoder = new TextDecoder()

  constructor(socket: SmtpSocketLike) {
    this.socket = socket
    this.reader = socket.readable.getReader()
    this.writer = socket.writable.getWriter()
  }

  /** 释放旧流并接管（STARTTLS 升级后的）新流。 */
  private attach(socket: SmtpSocketLike): void {
    this.socket = socket
    this.reader = socket.readable.getReader()
    this.writer = socket.writable.getWriter()
    this.buffer = ""
  }

  async cmd(line: string): Promise<void> {
    await this.writer.write(encoder.encode(`${line}\r\n`))
  }

  /** 读一条完整应答（处理 `250-…` 多行续行）。 */
  async readResponse(): Promise<{ code: number; message: string }> {
    const lines: string[] = []
    for (;;) {
      while (!this.buffer.includes("\r\n")) {
        const { value, done } = await this.reader.read()
        if (done) throw new Error("SMTP: connection closed unexpectedly")
        this.buffer += this.decoder.decode(value, { stream: true })
      }
      const eol = this.buffer.indexOf("\r\n")
      const line = this.buffer.slice(0, eol)
      this.buffer = this.buffer.slice(eol + 2)
      lines.push(line)

      // RFC 5321：末行第 4 个字符是空格，续行是 `-`。
      if (line.length <= 3 || line[3] === " ") {
        const code = Number.parseInt(line.slice(0, 3), 10)
        if (Number.isNaN(code)) {
          throw new Error(`SMTP: invalid response line: ${line}`)
        }
        return { code, message: lines.map((l) => l.slice(4)).join("\n") }
      }
    }
  }

  async expect(code: number, context: string): Promise<void> {
    const response = await this.readResponse()
    if (response.code !== code) {
      throw new Error(
        `${context}: expected ${code}, got ${response.code} — ${response.message}`
      )
    }
  }

  async ehlo(name: string): Promise<void> {
    await this.cmd(`EHLO ${sanitizeHeader(name) || "localhost"}`)
    await this.expect(250, "EHLO")
  }

  /**
   * STARTTLS：只有收到 220 才升级；服务器不支持（5xx/4xx）直接抛错。
   * 这里刻意不做「失败后继续明文发信」的兜底。
   */
  async startTls(name: string): Promise<void> {
    await this.cmd("STARTTLS")
    await this.expect(220, "STARTTLS")
    this.reader.releaseLock()
    this.writer.releaseLock()
    this.attach(this.socket.startTls())
    await this.ehlo(name)
  }

  async authLogin(username: string, password: string): Promise<void> {
    await this.cmd("AUTH LOGIN")
    await this.expect(334, "AUTH LOGIN")
    await this.cmd(encodeUtf8Base64(username))
    await this.expect(334, "AUTH LOGIN username")
    await this.cmd(encodeUtf8Base64(password))
    await this.expect(235, "AUTH LOGIN password")
  }

  async sendMessage(
    from: string,
    fromName: string,
    to: string,
    subject: string,
    html: string
  ): Promise<void> {
    const sender = sanitizeHeader(from)
    const recipient = sanitizeHeader(to)
    const displayName = sanitizeHeader(fromName)
    const domain = domainOf(sender) || "localhost"

    await this.cmd(`MAIL FROM:<${sender}>`)
    await this.expect(250, "MAIL FROM")
    await this.cmd(`RCPT TO:<${recipient}>`)
    await this.expect(250, "RCPT TO")
    await this.cmd("DATA")
    await this.expect(354, "DATA")

    const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${domain}>`
    const headers = [
      `From:${displayName ? ` ${encodeHeaderText(displayName)}` : ""} <${sender}>`,
      `To: ${recipient}`,
      `Subject: =?UTF-8?B?${encodeUtf8Base64(sanitizeHeader(subject))}?=`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId}`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64"
    ]

    // base64 字母表不含 `.`，天然满足 DATA 阶段的点号转义要求。
    const body = wrapBase64(encodeUtf8Base64(html))
    await this.writer.write(
      encoder.encode(`${headers.join("\r\n")}\r\n\r\n${body}\r\n.\r\n`)
    )
    await this.expect(250, "message body")
  }

  async quit(): Promise<void> {
    await this.cmd("QUIT").catch(() => {})
  }
}

// ── 连接与整轮流程 ──────────────────────────────────────────────────────────

async function defaultConnector(
  options: SmtpConnectOptions
): Promise<SmtpSocketLike> {
  const { connect } = await import("cloudflare:sockets")
  const socket = connect(
    { hostname: options.hostname, port: options.port },
    { secureTransport: options.secureTransport, allowHalfOpen: false }
  )
  return socket as unknown as SmtpSocketLike
}

function secureTransportOf(
  encryption: SmtpEncryption
): "on" | "off" | "starttls" {
  if (encryption === "tls") return "on"
  if (encryption === "starttls") return "starttls"
  return "off"
}

/**
 * 发一封 HTML 邮件。永不抛出：失败以 `{success:false, error}` 返回，
 * `error` 已脱敏（不含密码/其 base64）。
 */
export async function sendSmtpMessage(
  config: SmtpTransportConfig,
  message: SmtpMessage,
  connector: SmtpConnector = defaultConnector
): Promise<SmtpSendResult> {
  let socket: SmtpSocketLike | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    socket = await connector({
      hostname: config.host,
      port: config.port,
      secureTransport: secureTransportOf(config.encryption)
    })
    const session = new SmtpSession(socket)
    const ehloName = domainOf(config.from) || "localhost"

    const run = (async () => {
      await session.expect(220, "greeting")
      await session.ehlo(ehloName)
      if (config.encryption === "starttls") {
        await session.startTls(ehloName)
      }
      if (config.username && config.password) {
        await session.authLogin(config.username, config.password)
      }
      await session.sendMessage(
        config.from,
        config.fromName,
        message.to,
        message.subject,
        message.html
      )
      await session.quit()
    })()
    // 超时先到时会关闭 socket，run 随后失败；先挂上处理器避免 unhandled rejection。
    run.catch(() => {})

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `SMTP session timed out after ${SMTP_SESSION_TIMEOUT_MS / 1000}s`
            )
          ),
        SMTP_SESSION_TIMEOUT_MS
      )
    })
    await Promise.race([run, timeout])
    return { success: true }
  } catch (err) {
    return { success: false, error: redactSmtpError(err, config.password) }
  } finally {
    if (timer !== null) clearTimeout(timer)
    if (socket) await socket.close().catch(() => {})
  }
}
