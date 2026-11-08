/**
 * waker 接入的唯一开关（规格 §3）：只认 `WAKER_SIGNING_KEY` 配没配，不设 `WAKER_MODE`。
 *
 * 口径与部署脚本 scripts/materialize-secrets.mjs 完全一致：
 * trim 后为空、或仍是 `*_PLACEHOLDER` 模板值，一律算「未配置」。
 * 两个入口都从这里取判定，绝不各写一套：
 *   - 已配置 → waker 回调接管，`scheduled()` 自行跳过；
 *   - 未配置 → 内置 Cron Trigger 执行，waker 回调口由 SDK fail closed
 *     （500 `signing_key_missing`）。
 */
import type { Env } from "../types"

/** 解析生效的 signing key；未配置返回 `null`（绝不返回空串顶替）。 */
export function wakerSigningKey(
  env: Pick<Env, "WAKER_SIGNING_KEY">
): string | null {
  const raw = env.WAKER_SIGNING_KEY
  if (typeof raw !== "string") return null
  const key = raw.trim()
  if (key.length === 0) return null
  if (key.endsWith("_PLACEHOLDER")) return null
  return key
}

/** 是否已把月度清理交给 waker（= signing key 已配置）。 */
export function isWakerConfigured(
  env: Pick<Env, "WAKER_SIGNING_KEY">
): boolean {
  return wakerSigningKey(env) !== null
}
