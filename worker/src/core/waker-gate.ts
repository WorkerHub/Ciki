/**
 * waker 接入的唯一开关（规格 §3）：只认 `WAKER_SIGNING_KEY` 的取值，不设 `WAKER_MODE`。
 *
 * 三态判定（唯一判定处，两个入口都从这里取，绝不各写一套）：
 *   - `unconfigured`（未配置）→ 内置 Cron Trigger 执行清理，waker 回调口由 SDK
 *     fail closed（500 `signing_key_missing`）；
 *   - `disabled`（显式关闭，保留值 `false`）→ 两个入口都不自动跑清理，
 *     `scheduled()` 跳过且**不**回落 Cron；回调口同样 fail closed；
 *   - `configured`（已配置）→ waker 回调接管，`scheduled()` 自行跳过。
 *
 * 「未配置」的口径与部署脚本 scripts/materialize-secrets.mjs 完全一致：
 * 非字符串、trim 后为空、或仍是 `*_PLACEHOLDER` 模板值。
 *
 * 保留值只认小写 `false`（大小写敏感）：`False` / `FALSE` 按真 key 处理，
 * 即已配置态。`false` 只在判定层被识别，绝不作为验签钥交给 waker SDK。
 */
import type { Env } from "../types"

/** 保留值：把 `WAKER_SIGNING_KEY` 设为它表示显式关闭自动清理（大小写敏感）。 */
export const WAKER_SIGNING_KEY_DISABLED = "false"

/** 三态：未配置 / 显式关闭 / 已配置。 */
export type WakerGateState = "unconfigured" | "disabled" | "configured"

/** 归一化：非字符串、trim 后为空、`*_PLACEHOLDER` 一律返回 `null`（= 未配置）。 */
function normalizeKey(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null
  const key = raw.trim()
  if (key.length === 0) return null
  if (key.endsWith("_PLACEHOLDER")) return null
  return key
}

/** 判定当前处于哪一态；月度清理的两个入口都只读这一个函数。 */
export function wakerGateState(
  env: Pick<Env, "WAKER_SIGNING_KEY">
): WakerGateState {
  const key = normalizeKey(env.WAKER_SIGNING_KEY)
  if (key === null) return "unconfigured"
  if (key === WAKER_SIGNING_KEY_DISABLED) return "disabled"
  return "configured"
}

/**
 * 解析生效的 signing key：只有「已配置」态才返回字符串，
 * 未配置与显式关闭一律返回 `null`（绝不返回空串、也绝不把 `false` 当钥）。
 */
export function wakerSigningKey(
  env: Pick<Env, "WAKER_SIGNING_KEY">
): string | null {
  const key = normalizeKey(env.WAKER_SIGNING_KEY)
  if (key === null || key === WAKER_SIGNING_KEY_DISABLED) return null
  return key
}
