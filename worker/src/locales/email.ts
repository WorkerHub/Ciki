/**
 * 邮件模板（对齐 WorkerHub 标准）：中文 + 英文各一份，键一一对应。
 *
 * 覆盖四类验证码邮件与测试邮件：
 * - 注册验证（register_verify）
 * - 登录两步验证（2fa_login）
 * - 启用两步验证（2fa_enable）
 * - 找回密码（password_reset）
 * - 测试邮件（test_email）
 *
 * 项目名取 `core/identity.ts` 的 DEFAULT_SITE_NAME。
 * 中文与英文字符串由 `worker/test/i18n-language.test.ts` 锁定，逐字一致。
 */

import { DEFAULT_SITE_NAME } from "../core/identity"
import type { EmailCodePurpose } from "../core/email-code"
import { type Language, SUPPORTED_LANGUAGES } from "../core/language"

export type EmailLanguage = Language

export { SUPPORTED_LANGUAGES }

/**
 * 解析邮件模板语言：只接受支持集（支持大小写归一与空白修剪），非法/缺失一律 null。
 *
 * 区别于 `core/language.ts` 的 `normalizeLanguage`（后者静默回退默认语言 `zh`）；
 * 本函数返回 null 让调用方可依次链式回退（例如：显式入参 ?? 账号语言 ?? DEFAULT_LANGUAGE）。
 */
export function parseEmailLanguage(value: unknown): EmailLanguage | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(normalized)
    ? (normalized as EmailLanguage)
    : null
}

/** 兼容别名：解析邮件语言，非法返回 null。 */
export const normalizeLanguage = parseEmailLanguage

export interface EmailContent {
  subject: string
  html: string
  text?: string
}

export type CodeEmailPurpose = EmailCodePurpose

interface EmailCodeCopyItem {
  subject: string
  intro?: string
}

interface EmailCodeLocaleCopy {
  introJoin: string
  lead: string
  trail: string
  plainTrail: string
  purposes: Record<CodeEmailPurpose, EmailCodeCopyItem>
}

const EMAIL_CODE_COPY: Record<EmailLanguage, EmailCodeLocaleCopy> = {
  zh: {
    introJoin: "，",
    lead: "验证码是：",
    trail:
      "验证码 {minutes} 分钟内有效，且只能使用一次。若非本人操作，请忽略本邮件。",
    plainTrail: "验证码 {minutes} 分钟内有效，只能使用一次。",
    purposes: {
      password_reset: {
        subject: `${DEFAULT_SITE_NAME} 密码重置验证码`,
        intro: `你正在重置 ${DEFAULT_SITE_NAME} 账号的密码`
      },
      "2fa_login": {
        subject: `${DEFAULT_SITE_NAME} 登录验证码`,
        intro: `你正在使用邮箱验证码登录 ${DEFAULT_SITE_NAME}`
      },
      "2fa_enable": {
        subject: `${DEFAULT_SITE_NAME} 邮箱验证码启用确认`,
        intro: `你正在为 ${DEFAULT_SITE_NAME} 账号启用邮箱验证码两步验证`
      },
      register_verify: {
        subject: `${DEFAULT_SITE_NAME} 注册验证码`
      }
    }
  },
  en: {
    introJoin: " ",
    lead: "Your verification code is:",
    trail:
      "The code is valid for {minutes} minutes and can be used only once. If you did not request this, you can ignore this email.",
    plainTrail:
      "The code is valid for {minutes} minutes and can be used only once.",
    purposes: {
      password_reset: {
        subject: `${DEFAULT_SITE_NAME} password reset code`,
        intro: `You are resetting the password for your ${DEFAULT_SITE_NAME} account.`
      },
      "2fa_login": {
        subject: `${DEFAULT_SITE_NAME} sign-in code`,
        intro: `You are signing in to ${DEFAULT_SITE_NAME} with an email code.`
      },
      "2fa_enable": {
        subject: `${DEFAULT_SITE_NAME} email code setup`,
        intro: `You are turning on email verification codes for your ${DEFAULT_SITE_NAME} account.`
      },
      register_verify: {
        subject: `${DEFAULT_SITE_NAME} registration code`
      }
    }
  }
}

/** 渲染验证码邮件（按收件账号语言）。 */
export function renderCodeEmail(
  language: EmailLanguage,
  purpose: CodeEmailPurpose,
  code: string,
  expiresInSeconds = 600
): EmailContent {
  const copy = EMAIL_CODE_COPY[language]
  const item = copy.purposes[purpose]
  const minutes = Math.round(expiresInSeconds / 60)
  const trailText = (item.intro ? copy.trail : copy.plainTrail).replace(
    "{minutes}",
    String(minutes)
  )

  const leadHtml = item.intro
    ? `<p>${item.intro}${copy.introJoin}${copy.lead}</p>`
    : `<p>${copy.lead}</p>`
  const codeHtml = `<p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p>`
  const trailHtml = `<p>${trailText}</p>`

  const html = `${leadHtml}${codeHtml}${trailHtml}`

  const leadText = item.intro
    ? `${item.intro}${copy.introJoin}${copy.lead}`
    : copy.lead
  const text = `${leadText}\n${code}\n${trailText}`

  return {
    subject: item.subject,
    html,
    text
  }
}

/** 系统管理「发送测试邮件」用的模板（按管理员账号语言）。 */
export function renderTestEmail(
  language: EmailLanguage,
  sentAtIso?: string
): EmailContent {
  const timestamp = sentAtIso ?? new Date().toISOString()
  const templates: Record<EmailLanguage, EmailContent> = {
    zh: {
      subject: `${DEFAULT_SITE_NAME} 测试邮件`,
      html: `<p>这是一封测试邮件。收到它说明邮件配置可用。</p><p>发送时间：${timestamp}</p>`,
      text: `这是一封测试邮件。收到它说明邮件配置可用。发送时间：${timestamp}`
    },
    en: {
      subject: `${DEFAULT_SITE_NAME} test email`,
      html: `<p>This is a test email. Receiving it means the mail configuration works.</p><p>Sent at: ${timestamp}</p>`,
      text: `This is a test email. Receiving it means the mail configuration works. Sent at: ${timestamp}`
    }
  }
  return templates[language]
}
