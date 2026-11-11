/**
 * 邮件服务（#48 契约第 3/6/7 条）：`system_settings.smtp_config` 的**唯一消费方**。
 *
 * 存储形状（JSON，只有 `password` 是密文，其余明文）：
 * ```json
 * { "host": "smtp.example.com", "port": 587, "encryption": "starttls",
 *   "username": "mailer@example.com", "password": "v1.<iv>.<ct>",
 *   "from": "noreply@example.com", "fromName": "Ciki" }
 * ```
 * `password` 复用 `core/secret-box.ts` 的 AES-GCM，AAD 固定 `ciki:smtp:password`；
 * GET 永不回密码，只回 `passwordSet`。PUT 语义：缺省/空串/纯 `•` 掩码 = 保留原
 * 密文，`null` = 清空，其它非空字符串 = 重新加密（每次新 IV）。
 *
 * `emailConfigured` 只看非密字段（host/port/encryption/from 合法）——不解密、
 * 不探测网络、永不抛错，登录页与找回密码入口都可以安全地读它。
 */

import type { EmailCodePurpose } from "../core/email-code"
import { decryptSecret, encryptSecret } from "../core/secret-box"
import { getSetting, setSetting } from "../db/queries/settings"
import { getTablePrefix } from "../lib/table-prefix"
import type { Env } from "../types"
import {
  type SmtpEncryption,
  type SmtpTransportConfig,
  sendSmtpMessage
} from "./smtp-transport"

export const SMTP_CONFIG_KEY = "smtp_config"

/** SMTP 密码密文的 AAD（无用户维度，契约固定值）。 */
export const SMTP_PASSWORD_AAD = "ciki:smtp:password"

export const SMTP_ENCRYPTIONS: readonly SmtpEncryption[] = [
  "tls",
  "starttls",
  "none"
]

/** 与注册/登录/改密同一口径的邮箱格式校验（同时挡掉 CR/LF 头注入）。 */
export const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

export function isValidEmailAddress(email: string): boolean {
  return EMAIL_RE.test(email)
}

function isValidHost(host: string): boolean {
  return (
    host.length > 0 &&
    host.length <= 253 &&
    !/[\s:@]/.test(host) &&
    !/[\r\n]/.test(host)
  )
}

function isValidPort(port: unknown): port is number {
  return (
    typeof port === "number" &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535
  )
}

function isValidEncryption(value: unknown): value is SmtpEncryption {
  return (
    typeof value === "string" &&
    (SMTP_ENCRYPTIONS as readonly string[]).includes(value)
  )
}

// ── 存储读写 ────────────────────────────────────────────────────────────────

export interface StoredSmtpConfig {
  host: string
  port: number
  /** 运行期按 `SMTP_ENCRYPTIONS` 校验；这里保留 string 以便回显坏配置让管理员修。 */
  encryption: string
  username: string
  /** AES-GCM 密文（`v1.<iv>.<ct>`）；空串 = 未设置密码。 */
  password: string
  from: string
  fromName: string
}

export interface PublicSmtpConfig {
  host: string
  port: number
  encryption: string
  username: string
  passwordSet: boolean
  from: string
  fromName: string
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** 解析库里的 JSON；只有“不是 JSON 对象”才算损坏（返回 null）。 */
export function parseStoredSmtpConfig(
  raw: string | null
): StoredSmtpConfig | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null
  }
  const record = parsed as Record<string, unknown>
  const port =
    typeof record.port === "number"
      ? Math.trunc(record.port)
      : typeof record.port === "string" && /^\d+$/.test(record.port.trim())
        ? Number(record.port.trim())
        : 0
  return {
    host: asString(record.host),
    port,
    encryption: asString(record.encryption),
    username: asString(record.username),
    password: asString(record.password),
    from: asString(record.from),
    fromName: asString(record.fromName)
  }
}

export async function readStoredSmtpConfig(
  env: Env
): Promise<StoredSmtpConfig | null> {
  const raw = await getSetting(env.DB, getTablePrefix(env), SMTP_CONFIG_KEY)
  return parseStoredSmtpConfig(raw)
}

/** 判定只看非密字段：host/port/encryption/from 合法即视为已配置。 */
export function isSmtpConfigUsable(
  config: StoredSmtpConfig | null
): config is StoredSmtpConfig {
  if (!config) return false
  return (
    isValidHost(config.host) &&
    isValidPort(config.port) &&
    isValidEncryption(config.encryption) &&
    isValidEmailAddress(config.from)
  )
}

/** 公开 DTO：永不包含密码，只给 `passwordSet`。 */
export function publicSmtpConfig(
  config: StoredSmtpConfig | null
): PublicSmtpConfig | null {
  if (!config) return null
  return {
    host: config.host,
    port: config.port,
    encryption: config.encryption,
    username: config.username,
    passwordSet: config.password !== "",
    from: config.from,
    fromName: config.fromName
  }
}

/** 站点级“能不能发信”判定：不解密、不探测、永不抛错。 */
export async function isEmailConfigured(env: Env): Promise<boolean> {
  try {
    const config = await readStoredSmtpConfig(env)
    return isSmtpConfigUsable(config)
  } catch {
    return false
  }
}

// ── 写入校验 ────────────────────────────────────────────────────────────────

/** PUT 里的密码语义（见文件头）。 */
export type SmtpPasswordInput =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "set"; value: string }

export interface SmtpConfigDraft {
  host: string
  port: number
  encryption: SmtpEncryption
  username: string
  from: string
  fromName: string
  password: SmtpPasswordInput
}

export type SmtpConfigValidation =
  | { ok: true; value: SmtpConfigDraft }
  | { ok: false; reason: string }

/** 纯 `•` 掩码按“保留”处理，避免前端回传掩码被当成新密码加密。 */
function parsePasswordInput(value: unknown): SmtpPasswordInput | null {
  if (value === undefined) return { kind: "keep" }
  if (value === null) return { kind: "clear" }
  if (typeof value !== "string") return null
  if (value === "" || /^•+$/.test(value)) return { kind: "keep" }
  return { kind: "set", value }
}

function readPort(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim())
  }
  return null
}

/**
 * 校验 PUT 请求体（全量替换非密字段）。`existing` 用于判断“保留密码”时
 * 当前是否已有密文，从而落实 `username` 与 `password` 同时有/同时空的规则。
 */
export function validateSmtpConfigInput(
  body: unknown,
  existing: StoredSmtpConfig | null
): SmtpConfigValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "request body must be a JSON object" }
  }
  const record = body as Record<string, unknown>

  const host = typeof record.host === "string" ? record.host.trim() : ""
  if (!isValidHost(host)) {
    return {
      ok: false,
      reason:
        "host is required, at most 253 characters, without spaces, CR/LF, ':' or '@'"
    }
  }

  const port = readPort(record.port)
  if (port === null || !isValidPort(port)) {
    return { ok: false, reason: "port must be an integer between 1 and 65535" }
  }

  if (!isValidEncryption(record.encryption)) {
    return {
      ok: false,
      reason: "encryption must be one of tls, starttls, none"
    }
  }
  const encryption = record.encryption

  const username =
    record.username === undefined || record.username === null
      ? ""
      : typeof record.username === "string"
        ? record.username.trim()
        : null
  if (username === null || username.length > 320) {
    return {
      ok: false,
      reason: "username must be a string of at most 320 characters"
    }
  }

  const from = typeof record.from === "string" ? record.from.trim() : ""
  if (from.length > 320 || !isValidEmailAddress(from)) {
    return { ok: false, reason: "from must be a valid email address" }
  }

  const fromName =
    record.fromName === undefined || record.fromName === null
      ? ""
      : typeof record.fromName === "string"
        ? record.fromName.replace(/[\r\n]/g, "").trim()
        : null
  if (fromName === null || fromName.length > 64) {
    return {
      ok: false,
      reason: "fromName must be a string of at most 64 characters"
    }
  }

  const password = parsePasswordInput(record.password)
  if (password === null) {
    return { ok: false, reason: "password must be a string or null" }
  }

  const passwordPresent =
    password.kind === "set"
      ? password.value !== ""
      : password.kind === "clear"
        ? false
        : existing?.password !== "" && existing?.password !== undefined
  if (passwordPresent && username === "") {
    return {
      ok: false,
      reason: "username is required when a password is set"
    }
  }
  if (!passwordPresent && username !== "") {
    return {
      ok: false,
      reason: "username must be empty when no password is set"
    }
  }

  return {
    ok: true,
    value: {
      host,
      port,
      encryption,
      username,
      from,
      fromName,
      password
    }
  }
}

/** 落库（全量替换非密字段；密码按 PUT 语义保留/清空/重新加密）。 */
export async function saveSmtpConfig(
  env: Env,
  draft: SmtpConfigDraft,
  existing: StoredSmtpConfig | null
): Promise<StoredSmtpConfig> {
  let password = ""
  if (draft.password.kind === "keep") {
    password = existing?.password ?? ""
  } else if (draft.password.kind === "set") {
    password = await encryptSecret(
      env.ENCRYPTION_KEY,
      draft.password.value,
      SMTP_PASSWORD_AAD
    )
  }

  const stored: StoredSmtpConfig = {
    host: draft.host,
    port: draft.port,
    encryption: draft.encryption,
    username: draft.username,
    from: draft.from,
    fromName: draft.fromName,
    password
  }
  await setSetting(
    env.DB,
    getTablePrefix(env),
    SMTP_CONFIG_KEY,
    JSON.stringify(stored)
  )
  return stored
}

// ── 发信 ────────────────────────────────────────────────────────────────────

export interface OutgoingEmail {
  to: string
  subject: string
  html: string
}

export type SendEmailResult =
  | { success: true }
  | { success: false; error: string }

function transportConfigOf(
  config: StoredSmtpConfig,
  password: string
): SmtpTransportConfig {
  return {
    host: config.host,
    port: config.port,
    encryption: config.encryption as SmtpEncryption,
    username: config.username,
    password,
    from: config.from,
    fromName: config.fromName
  }
}

/**
 * 发一封邮件（唯一读取 `smtp_config` 并发信的入口）。永不抛出：
 * - 未配置 → `{success:false, error:"Email delivery is not configured"}`；
 * - 密文解密失败（ENCRYPTION_KEY 换过）→ 可操作的 502 原因，不回显密文；
 * - SMTP 失败 → `SMTP send failed: <已脱敏原因>`。
 */
export async function sendTransactionalEmail(
  env: Env,
  message: OutgoingEmail
): Promise<SendEmailResult> {
  const config = await readStoredSmtpConfig(env)
  if (!isSmtpConfigUsable(config)) {
    return { success: false, error: "Email delivery is not configured" }
  }
  if (!isValidEmailAddress(message.to)) {
    return { success: false, error: "Invalid recipient email address" }
  }

  let password = ""
  if (config.password) {
    try {
      password = await decryptSecret(
        env.ENCRYPTION_KEY,
        config.password,
        SMTP_PASSWORD_AAD
      )
    } catch {
      return {
        success: false,
        error:
          "SMTP send failed: the stored SMTP password cannot be decrypted; ENCRYPTION_KEY may have changed — re-enter the SMTP password in the admin page"
      }
    }
  }

  const result = await sendSmtpMessage(transportConfigOf(config, password), {
    to: message.to,
    subject: message.subject,
    html: message.html
  })
  if (result.success) return { success: true }
  return { success: false, error: `SMTP send failed: ${result.error}` }
}

/**
 * 验证码邮件文案。`intro` 为空表示「只给验证码与有效期、不加多余话术」
 * （注册验证邮件的口径）：开场句与「若非本人操作」句一并省略。
 */
const EMAIL_CODE_COPY: Record<
  EmailCodePurpose,
  { subject: string; intro?: string }
> = {
  password_reset: {
    subject: "Ciki 密码重置验证码",
    intro: "你正在重置 Ciki 账号的密码"
  },
  "2fa_login": {
    subject: "Ciki 登录验证码",
    intro: "你正在使用邮箱验证码登录 Ciki"
  },
  "2fa_enable": {
    subject: "Ciki 邮箱验证码启用确认",
    intro: "你正在为 Ciki 账号启用邮箱验证码两步验证"
  },
  register_verify: {
    subject: "Ciki 注册验证码"
  }
}

/** 验证码邮件（固定中文文案，不读用户 language；服务端无 i18n）。 */
export async function sendEmailCodeMessage(
  env: Env,
  options: {
    to: string
    code: string
    purpose: EmailCodePurpose
    expiresInSeconds?: number
  }
): Promise<SendEmailResult> {
  const copy = EMAIL_CODE_COPY[options.purpose]
  const minutes = Math.round((options.expiresInSeconds ?? 600) / 60)
  const html =
    (copy.intro ? `<p>${copy.intro}，验证码是：</p>` : "<p>验证码是：</p>") +
    `<p style="font-size:24px;font-weight:bold;letter-spacing:4px">${options.code}</p>` +
    `<p>验证码 ${minutes} 分钟内有效，${
      copy.intro
        ? "且只能使用一次。若非本人操作，请忽略本邮件。"
        : "只能使用一次。"
    }</p>`
  return sendTransactionalEmail(env, {
    to: options.to,
    subject: copy.subject,
    html
  })
}
