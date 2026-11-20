/**
 * 「注册需邮箱验证」开关的读写与有效判定（规格 §5.6 第 4 条）。
 *
 * 键名沿用 setup 播种的 `registration_email_verification_enabled`（默认开）。
 * 与 project-template 对齐，但 Ciki 无 APP_MODE（恒多用户）、无 SIGNING_SECRET
 * （验证走 6 位码存库，不靠签名 token），所以 `emailVerificationEnforced` 只判
 * 「开关开 + 邮件已配置」。
 */
import { isEmailConfigured } from "../services/email"
import { getBooleanSetting, setSetting } from "../db/queries/settings"
import { getTablePrefix } from "./table-prefix"
import type { Env } from "../types"

export const REGISTRATION_EMAIL_VERIFICATION_KEY =
  "registration_email_verification_enabled"

/** 开关当前值（缺省/未播种一律按默认「开」处理）。 */
export async function registrationEmailVerificationRequired(
  env: Env
): Promise<boolean> {
  return getBooleanSetting(
    env.DB,
    getTablePrefix(env),
    REGISTRATION_EMAIL_VERIFICATION_KEY,
    true
  )
}

/**
 * 「注册需邮箱验证」是否**真的能执行**：开关开着、邮件已配置。
 * 注册与登录都按这个有效值判定，所以 provider 事后被清空也不会把已注册未验证的
 * 用户锁死（规格 §5.6 第 4 条）。开关本身保持原值不动。
 */
export async function emailVerificationEnforced(env: Env): Promise<boolean> {
  if (!(await registrationEmailVerificationRequired(env))) return false
  return isEmailConfigured(env)
}

export type WriteEmailVerificationResult =
  | { ok: true }
  | { ok: false; code: "EMAIL_NOT_CONFIGURED"; error: string }

/** 写开关；邮件未配置时拒绝开启（未配置守卫）。 */
export async function writeRegistrationEmailVerification(
  env: Env,
  value: boolean
): Promise<WriteEmailVerificationResult> {
  if (value && !(await isEmailConfigured(env))) {
    return {
      ok: false,
      code: "EMAIL_NOT_CONFIGURED",
      error:
        "Email delivery is not configured; the verification requirement cannot be enabled"
    }
  }
  await setSetting(
    env.DB,
    getTablePrefix(env),
    REGISTRATION_EMAIL_VERIFICATION_KEY,
    value ? "true" : "false"
  )
  return { ok: true }
}
