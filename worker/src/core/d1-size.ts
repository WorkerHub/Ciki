/**
 * 库体积口径：Cloudflare D1 REST API 的 `file_size`（字节）。
 *
 * 为什么不再用 SQLite 页计数：D1 运行时拒绝 `PRAGMA page_count`（SQLITE_AUTH，
 * 官方兼容清单没有这一项），页计数在线上恒为「不可得」。这里改走控制面 API：
 *
 *   GET /accounts/{account_id}/d1/database/{database_id}?fields=file_size
 *   → result.file_size
 *
 * 这个数字就是整库字节数（与 Cloudflare 控制台 D1 详情页一致）。令牌复用组织级
 * 共用的 `CLOUDFLARE_API_TOKEN`（部署也是这一把，需含 D1 读）；账号与库 ID 来自
 * 同一批 CI 注入值（部署脚本把它们一并作为 Worker secret 上传）。
 *
 * 失败一律回 `null` + `unavailable`，**绝不估算**：配置缺失（未设置 / 空值 /
 * `*_PLACEHOLDER`）连请求都不发；HTTP 非 2xx、超时、非 JSON、`file_size` 不是
 * 有限非负数同样回 null。日志只记状态码与错误消息——URL 含账号与库 ID、请求头
 * 里有 token，两者都不进日志。
 *
 * 缓存：isolate 内的单条记录（一个部署只关心一个库），成功 5 分钟、失败 60 秒，
 * 避免管理员反复刷新把 API 打穿。
 */
import type { Env } from "../types"

export interface DatabaseSize {
  bytes: number | null
  measure: "cloudflare-d1-api" | "unavailable"
}

export type DatabaseSizeConfig = Pick<
  Env,
  "CLOUDFLARE_API_TOKEN" | "CLOUDFLARE_ACCOUNT_ID" | "D1_DATABASE_ID"
>

const API_BASE = "https://api.cloudflare.com/client/v4"
/** 单次请求上限：管理页不该为一个体积数字干等。 */
const REQUEST_TIMEOUT_MS = 3000
const SUCCESS_TTL_MS = 5 * 60 * 1000
const FAILURE_TTL_MS = 60 * 1000

/**
 * 取生效的配置值；未配置返回 `null`。口径与 `src/core/waker-gate.ts` 一致：
 * trim 后为空、或仍是部署模板里的 `*_PLACEHOLDER`，一律算未配置。
 */
function configured(value: string | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.endsWith("_PLACEHOLDER")) return null
  return trimmed
}

interface CacheEntry {
  /** `${accountId}/${databaseId}`：换库不会串值。 */
  key: string
  bytes: number | null
  expiresAt: number
}

let cache: CacheEntry | null = null

/** 清空 isolate 内的缓存（测试用；线上靠 TTL 自然过期）。 */
export function resetD1SizeCache(): void {
  cache = null
}

function resultOf(bytes: number | null): DatabaseSize {
  return {
    bytes,
    measure: bytes === null ? "unavailable" : "cloudflare-d1-api"
  }
}

/** 401/403 几乎总是令牌权限问题，日志里直接点名，省得对着状态码猜。 */
function permissionHint(status: number): string {
  return status === 401 || status === 403
    ? "（检查 CLOUDFLARE_API_TOKEN 是否含 D1 读权限）"
    : ""
}

async function fetchFileSize(
  token: string,
  accountId: string,
  databaseId: string
): Promise<number | null> {
  const url =
    `${API_BASE}/accounts/${encodeURIComponent(accountId)}` +
    `/d1/database/${encodeURIComponent(databaseId)}?fields=file_size`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!res.ok) {
      console.warn(
        `D1 size API failed: HTTP ${res.status}${permissionHint(res.status)}`
      )
      return null
    }
    const body = (await res.json()) as { result?: { file_size?: unknown } }
    const size = body?.result?.file_size
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
      console.warn("D1 size API returned no usable file_size")
      return null
    }
    return size
  } catch (err) {
    console.warn(
      "D1 size API request failed:",
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

/**
 * 读本库体积（字节）。取不到回 `{ bytes: null, measure: "unavailable" }`，
 * 调用方据此显示「不可得」，不拿行数或页数估算顶替。
 */
export async function readDatabaseSize(
  env: DatabaseSizeConfig
): Promise<DatabaseSize> {
  const token = configured(env.CLOUDFLARE_API_TOKEN)
  const accountId = configured(env.CLOUDFLARE_ACCOUNT_ID)
  const databaseId = configured(env.D1_DATABASE_ID)
  if (token === null || accountId === null || databaseId === null) {
    return resultOf(null)
  }

  const key = `${accountId}/${databaseId}`
  const now = Date.now()
  if (cache !== null && cache.key === key && cache.expiresAt > now) {
    return resultOf(cache.bytes)
  }

  const bytes = await fetchFileSize(token, accountId, databaseId)
  cache = {
    key,
    bytes,
    expiresAt: now + (bytes === null ? FAILURE_TTL_MS : SUCCESS_TTL_MS)
  }
  return resultOf(bytes)
}
