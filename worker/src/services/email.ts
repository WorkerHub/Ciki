/**
 * 邮件服务（#48 契约 + backend 标准 §5.5A）：`system_settings` 里邮件配置的**唯一消费方**。
 *
 * 三态单选（`none` / `smtp` / `resend`）由 `email_provider` 决定，一次只走一个通道，
 * 不做双通道也不做自动故障转移。业务侧只调 `sendEmail(env, {to, subject, html, text})`，
 * 不感知通道；验证码邮件的文案统一由 `locales/email.ts` 渲染。
 *
 * `isEmailConfigured()` 是全站「邮件能否真正发出去」的**唯一判定**：provider 为 none /
 * 缺键、smtp 缺 host/port/encryption/from、resend 缺 api_key，都算未配置。依赖邮件的
 * 功能（找回密码入口、注册邮箱验证开关）只读这个布尔值，绝不各判一套。
 *
 * 凭据只写不读：接口读回只有 `passwordSet` / `apiKeySet`，保存时留空表示不改。
 * SMTP 密码与 Resend API key 复用 `core/secret-box.ts` 的 AES-GCM：
 * - SMTP：AAD 固定 `ciki:smtp:password`；
 * - Resend：AAD 固定 `ciki:resend:api_key`。
 */

import type { EmailCodePurpose } from "../core/email-code"
import { DEFAULT_SITE_NAME } from "../core/identity"
import type { Language } from "../core/language"
import { decryptSecret, encryptSecret } from "../core/secret-box"
import { getSetting, setSetting } from "../db/queries/settings"
import { getTablePrefix } from "../lib/table-prefix"
import { renderCodeEmail } from "../locales/email"
import type { Env } from "../types"
import {
  type SmtpEncryption,
  type SmtpTransportConfig,
  sendSmtpMessage
} from "./smtp-transport"

export const SMTP_CONFIG_KEY = "smtp_config"
export const RESEND_CONFIG_KEY = "resend_config"
export const EMAIL_PROVIDER_KEY = "email_provider"

/** SMTP 密码密文的 AAD（无用户维度，契约固定值）。 */
export const SMTP_PASSWORD_AAD = "ciki:smtp:password"
/** Resend API key 密文的 AAD（无用户维度，契约固定值）。 */
export const RESEND_API_KEY_AAD = "ciki:resend:api_key"

export type EmailProvider = "none" | "smtp" | "resend"

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

function hasHeaderInjection(value: string): boolean {
  return /[\r\n]/.test(value)
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

export interface StoredResendConfig {
  /** AES-GCM 密文（`v1.<iv>.<ct>`）；空串 = 未设置 API key。 */
  api_key: string
  from: string
  fromName: string
}

export interface PublicResendConfig {
  from: string
  fromName: string
  apiKeySet: boolean
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

export function parseStoredResendConfig(
  raw: string | null
): StoredResendConfig | null {
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
  return {
    api_key: asString(record.api_key),
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

export async function readStoredResendConfig(
  env: Env
): Promise<StoredResendConfig | null> {
  const raw = await getSetting(env.DB, getTablePrefix(env), RESEND_CONFIG_KEY)
  return parseStoredResendConfig(raw)
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

/** 公开 DTO：永不包含密码，只给 `passwordSet`；从未存过 host 时回 null。 */
export function publicSmtpConfig(
  config: StoredSmtpConfig | null
): PublicSmtpConfig | null {
  if (!config || config.host === "") return null
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

/** 判定 Resend 是否可用：必须有 api_key 且发件邮箱合法。 */
export function isResendConfigUsable(
  config: StoredResendConfig | null
): config is StoredResendConfig {
  if (!config) return false
  return config.api_key !== "" && isValidEmailAddress(config.from)
}

/** 公开 DTO：永不包含 key，只给 `apiKeySet`。 */
export function publicResendConfig(
  config: StoredResendConfig | null
): PublicResendConfig | null {
  if (!config) return null
  return {
    from: config.from,
    fromName: config.fromName,
    apiKeySet: config.api_key !== ""
  }
}

// ── provider 与全站判定 ─────────────────────────────────────────────────────

export async function readEmailProvider(env: Env): Promise<EmailProvider> {
  const raw = await getSetting(env.DB, getTablePrefix(env), EMAIL_PROVIDER_KEY)
  return raw === "smtp" || raw === "resend" ? raw : "none"
}

/** 站点级“能不能发信”判定：不解密、不探测、永不抛错。 */
export async function isEmailConfigured(env: Env): Promise<boolean> {
  try {
    const provider = await readEmailProvider(env)
    if (provider === "none") return false
    if (provider === "resend") {
      const config = await readStoredResendConfig(env)
      return isResendConfigUsable(config)
    }
    const config = await readStoredSmtpConfig(env)
    return isSmtpConfigUsable(config)
  } catch {
    return false
  }
}

// ── 发信 ────────────────────────────────────────────────────────────────────

export interface OutgoingEmail {
  to: string
  subject: string
  html: string
  /** 纯文本替代体（Resend 用它兜底不支持 HTML 的客户端）。 */
  text?: string
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
 * 发一封邮件（唯一按 `email_provider` 分发的入口）。永不抛出：
 * - provider 为 none / 缺键 → `{success:false, error:"Email delivery is not configured"}`；
 * - 密文解密失败（ENCRYPTION_KEY 换过）→ 可操作的 502 原因，不回显密文；
 * - SMTP / Resend 失败 → 原样带上脱敏后的通道错误。
 */
export async function sendEmail(
  env: Env,
  message: OutgoingEmail
): Promise<SendEmailResult> {
  if (!isValidEmailAddress(message.to)) {
    return { success: false, error: "Invalid recipient email address" }
  }

  const provider = await readEmailProvider(env)
  if (provider === "none") {
    return { success: false, error: "Email delivery is not configured" }
  }
  if (provider === "resend") return sendViaResend(env, message)
  return sendViaSmtp(env, message)
}

async function sendViaResend(
  env: Env,
  message: OutgoingEmail
): Promise<SendEmailResult> {
  const config = await readStoredResendConfig(env)
  if (!config || config.api_key === "") {
    return { success: false, error: "Resend API key not configured" }
  }
  if (!isValidEmailAddress(config.from)) {
    return {
      success: false,
      error: "Resend from address not configured or invalid"
    }
  }

  let apiKey = ""
  try {
    apiKey = await decryptSecret(
      env.ENCRYPTION_KEY,
      config.api_key,
      RESEND_API_KEY_AAD
    )
  } catch {
    return {
      success: false,
      error:
        "Resend send failed: the stored Resend API key cannot be decrypted; ENCRYPTION_KEY may have changed — re-enter the Resend API key in the admin page"
    }
  }

  const from = config.from
  const fromName = (config.fromName || DEFAULT_SITE_NAME).replace(/[\r\n]/g, "")

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: `${fromName} <${from}>`,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      ...(message.text ? { text: message.text } : {})
    })
  })

  if (!response.ok) {
    // 原文回显：管理面的「发送测试邮件」要把 Resend 的真实报错给管理员看。
    const error = await response.text()
    return { success: false, error: `Resend error: ${error}` }
  }
  return { success: true }
}

async function sendViaSmtp(
  env: Env,
  message: OutgoingEmail
): Promise<SendEmailResult> {
  const config = await readStoredSmtpConfig(env)
  if (!isSmtpConfigUsable(config)) {
    return { success: false, error: "Email delivery is not configured" }
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
 * 验证码邮件：文案来自 `locales/email.ts`（服务端不引 i18n 框架，i18n 规格 §2.8），
 * 按调用方给的语言选文案（已注册用户传账号语言，注册首封传注册入参语言；调用方用
 * `normalizeLanguage` 归一）。统一走 `sendEmail` 分发。
 */
export async function sendEmailCodeMessage(
  env: Env,
  options: {
    to: string
    code: string
    purpose: EmailCodePurpose
    language: Language
    expiresInSeconds?: number
  }
): Promise<SendEmailResult> {
  const content = renderCodeEmail(
    options.language,
    options.purpose,
    options.code,
    options.expiresInSeconds ?? 600
  )
  return sendEmail(env, {
    to: options.to,
    subject: content.subject,
    html: content.html,
    text: content.text
  })
}

// ── 写入校验（#48 契约的 /system/smtp 全量替换语义） ───────────────────────

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

// ── 系统管理侧的读取（脱敏）与保存 ────────────────────────────────────────────

export interface EmailSettingsView {
  provider: EmailProvider
  configured: boolean
  smtp: {
    host: string
    port: number
    encryption: string
    username: string
    from: string
    fromName: string
    /** 是否已存密码；密码本身永不返回。 */
    passwordSet: boolean
  }
  resend: {
    from: string
    fromName: string
    /** 是否已存 API key；key 本身永不返回。 */
    apiKeySet: boolean
  }
}

export async function readEmailSettings(env: Env): Promise<EmailSettingsView> {
  const provider = await readEmailProvider(env)
  const smtp = await readStoredSmtpConfig(env)
  const resend = await readStoredResendConfig(env)
  return {
    provider,
    configured: await isEmailConfigured(env),
    smtp: {
      host: smtp?.host ?? "",
      port: Number(smtp?.port) || 587,
      encryption: smtp?.encryption ?? "starttls",
      username: smtp?.username ?? "",
      from: smtp?.from ?? "",
      fromName: smtp?.fromName ?? "",
      passwordSet: Boolean(smtp?.password)
    },
    resend: {
      from: resend?.from ?? "",
      fromName: resend?.fromName ?? "",
      apiKeySet: Boolean(resend?.api_key)
    }
  }
}

export interface EmailSettingsPatch {
  provider?: EmailProvider
  smtp?: {
    host?: string
    port?: number | string
    encryption?: string
    username?: string
    /** 缺省/空串/纯• = 不改已存密码；null = 清空密码。 */
    password?: string | null
    from?: string
    fromName?: string
  }
  resend?: {
    /** 缺省/空串/纯• = 不改已存 key；null = 清空 key。 */
    apiKey?: string | null
    from?: string
    fromName?: string
  }
}

export type SaveEmailSettingsResult =
  | { ok: true }
  | { ok: false; error: string }

const PROVIDERS: EmailProvider[] = ["none", "smtp", "resend"]

type SecretPatchAction =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "set"; value: string }
  | { kind: "invalid" }

/**
 * 凭据字段部分更新解析：
 * - undefined / "" / 纯 `•` 掩码 → "keep"（保留已存密文，不改动）
 * - null → "clear"（显式清空凭据）
 * - 非空有效字符串 → "set"（待加密并落库）
 * - 其它类型（数字、布尔、对象等）→ "invalid"（非法入参，由调用方打回 400）
 */
function parseSecretPatch(value: unknown, trim = false): SecretPatchAction {
  if (value === undefined) return { kind: "keep" }
  if (value === null) return { kind: "clear" }
  if (typeof value !== "string") return { kind: "invalid" }
  const val = trim ? value.trim() : value
  if (val === "" || /^•+$/.test(val)) return { kind: "keep" }
  return { kind: "set", value: val }
}

async function writeJsonSetting(
  env: Env,
  key: string,
  value: Record<string, unknown>
): Promise<void> {
  await setSetting(env.DB, getTablePrefix(env), key, JSON.stringify(value))
}

/**
 * 保存邮件配置（标准 `/settings` 的部分补丁语义）。规则：
 * - provider 必须三态之一；
 * - 只应用给出的字段；凭据字段缺省/留空/掩码表示保留原值，null 表示显式置空，非字符串/非空类型打回 400；
 * - 地址类字段做 CR/LF 与邮箱格式校验（头部注入拦截）；
 * - 所有非凭据字段均有严格的运行时 typeof 守卫，避免非法 JSON 导致 500；
 * - 存一个不完整的配置是允许的（`configured` 会如实为假），但字段值本身必须合法。
 */
export async function saveEmailSettings(
  env: Env,
  patch: EmailSettingsPatch
): Promise<SaveEmailSettingsResult> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, error: "email settings patch must be an object" }
  }

  if (patch.provider !== undefined) {
    if (
      typeof patch.provider !== "string" ||
      !PROVIDERS.includes(patch.provider)
    ) {
      return { ok: false, error: "Unknown email provider" }
    }
  }

  if (patch.smtp !== undefined) {
    if (
      !patch.smtp ||
      typeof patch.smtp !== "object" ||
      Array.isArray(patch.smtp)
    ) {
      return { ok: false, error: "smtp config must be an object" }
    }
    const existing = (await readStoredSmtpConfig(env)) ?? {
      host: "",
      port: 587,
      encryption: "starttls",
      username: "",
      password: "",
      from: "",
      fromName: ""
    }
    const next: StoredSmtpConfig = { ...existing }

    if (patch.smtp.host !== undefined) {
      if (typeof patch.smtp.host !== "string") {
        return { ok: false, error: "smtp.host must be a string" }
      }
      const host = patch.smtp.host.trim()
      if (hasHeaderInjection(host)) {
        return { ok: false, error: "smtp.host must not contain CR/LF" }
      }
      if (host !== "" && !isValidHost(host)) {
        return {
          ok: false,
          error:
            "smtp.host must be at most 253 characters, without spaces, CR/LF, ':' or '@'"
        }
      }
      next.host = host
    }
    if (patch.smtp.port !== undefined) {
      const port = readPort(patch.smtp.port)
      if (port === null || !isValidPort(port)) {
        return {
          ok: false,
          error: "smtp.port must be an integer between 1 and 65535"
        }
      }
      next.port = port
    }
    if (patch.smtp.encryption !== undefined) {
      if (
        typeof patch.smtp.encryption !== "string" ||
        !isValidEncryption(patch.smtp.encryption)
      ) {
        return {
          ok: false,
          error: "smtp.encryption must be one of tls, starttls, none"
        }
      }
      next.encryption = patch.smtp.encryption
    }
    if (patch.smtp.username !== undefined) {
      if (typeof patch.smtp.username !== "string") {
        return { ok: false, error: "smtp.username must be a string" }
      }
      const username = patch.smtp.username.trim()
      if (hasHeaderInjection(username)) {
        return { ok: false, error: "smtp.username must not contain CR/LF" }
      }
      if (username.length > 320) {
        return {
          ok: false,
          error: "smtp.username must be at most 320 characters"
        }
      }
      next.username = username
    }
    if (patch.smtp.from !== undefined) {
      if (typeof patch.smtp.from !== "string") {
        return { ok: false, error: "smtp.from must be a string" }
      }
      const from = patch.smtp.from.trim()
      if (hasHeaderInjection(from)) {
        return { ok: false, error: "smtp.from must not contain CR/LF" }
      }
      if (from !== "" && (from.length > 320 || !isValidEmailAddress(from))) {
        return { ok: false, error: "smtp.from must be a valid email address" }
      }
      next.from = from
    }
    if (patch.smtp.fromName !== undefined) {
      if (typeof patch.smtp.fromName !== "string") {
        return { ok: false, error: "smtp.fromName must be a string" }
      }
      const fromName = patch.smtp.fromName.trim()
      if (hasHeaderInjection(fromName)) {
        return { ok: false, error: "smtp.fromName must not contain CR/LF" }
      }
      if (fromName.length > 64) {
        return {
          ok: false,
          error: "smtp.fromName must be at most 64 characters"
        }
      }
      next.fromName = fromName
    }
    if (patch.smtp.password !== undefined) {
      const secret = parseSecretPatch(patch.smtp.password)
      if (secret.kind === "invalid") {
        return { ok: false, error: "smtp.password must be a string or null" }
      }
      if (secret.kind === "clear") {
        next.password = ""
      } else if (secret.kind === "set") {
        if (hasHeaderInjection(secret.value)) {
          return { ok: false, error: "smtp.password must not contain CR/LF" }
        }
        next.password = await encryptSecret(
          env.ENCRYPTION_KEY,
          secret.value,
          SMTP_PASSWORD_AAD
        )
      }
    }

    await writeJsonSetting(
      env,
      SMTP_CONFIG_KEY,
      next as unknown as Record<string, unknown>
    )
  }

  if (patch.resend !== undefined) {
    if (
      !patch.resend ||
      typeof patch.resend !== "object" ||
      Array.isArray(patch.resend)
    ) {
      return { ok: false, error: "resend config must be an object" }
    }
    const existing = (await readStoredResendConfig(env)) ?? {
      api_key: "",
      from: "",
      fromName: ""
    }
    const next: StoredResendConfig = { ...existing }

    if (patch.resend.from !== undefined) {
      if (typeof patch.resend.from !== "string") {
        return { ok: false, error: "resend.from must be a string" }
      }
      const from = patch.resend.from.trim()
      if (hasHeaderInjection(from)) {
        return { ok: false, error: "resend.from must not contain CR/LF" }
      }
      if (from !== "" && (from.length > 320 || !isValidEmailAddress(from))) {
        return { ok: false, error: "resend.from must be a valid email address" }
      }
      next.from = from
    }
    if (patch.resend.fromName !== undefined) {
      if (typeof patch.resend.fromName !== "string") {
        return { ok: false, error: "resend.fromName must be a string" }
      }
      const fromName = patch.resend.fromName.trim()
      if (hasHeaderInjection(fromName)) {
        return { ok: false, error: "resend.fromName must not contain CR/LF" }
      }
      if (fromName.length > 64) {
        return {
          ok: false,
          error: "resend.fromName must be at most 64 characters"
        }
      }
      next.fromName = fromName
    }
    if (patch.resend.apiKey !== undefined) {
      const secret = parseSecretPatch(patch.resend.apiKey, true)
      if (secret.kind === "invalid") {
        return { ok: false, error: "resend.apiKey must be a string or null" }
      }
      if (secret.kind === "clear") {
        next.api_key = ""
      } else if (secret.kind === "set") {
        if (hasHeaderInjection(secret.value)) {
          return { ok: false, error: "resend.apiKey must not contain CR/LF" }
        }
        next.api_key = await encryptSecret(
          env.ENCRYPTION_KEY,
          secret.value,
          RESEND_API_KEY_AAD
        )
      }
    }

    await writeJsonSetting(
      env,
      RESEND_CONFIG_KEY,
      next as unknown as Record<string, unknown>
    )
  }

  if (patch.provider !== undefined) {
    await setSetting(
      env.DB,
      getTablePrefix(env),
      EMAIL_PROVIDER_KEY,
      patch.provider
    )
  }

  return { ok: true }
}
