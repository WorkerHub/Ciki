/**
 * 「令牌表隔离」的唯一判定点：读侧两张表都认，写侧只认 `write_tokens`。
 *
 * 三套令牌（导入 / 只读 / 读写）互不通用靠表隔离落地，不靠路由层的前置判断：
 * - 读中间件（middleware/read-token.ts）认只读与读写两张表，范围按命中的那种取；
 * - 写中间件只认 `write_tokens`，只读令牌与导入令牌因此一律 401；
 * - 导入中间件只认 `import_tokens`，另两种令牌同样进不来。
 *
 * 判定放在这里，单 B / C 的中间件直接调用，不各自拼「先查哪张表」的顺序。
 */
import { findReadToken } from "./read-token"
import { findWriteToken } from "./write-token"
import type { TokenKind } from "./token-scope"

export interface ApiTokenIdentity {
  userId: number
  /** 站点角色：`admin` 在令牌接口里等于「可见全部空间」。 */
  role: string
  /** 命中的令牌种类：空间范围要按它自己那一份（`token_kind`）取。 */
  kind: TokenKind
}

/** 校验 `Authorization: Bearer` 的明文：先只读令牌、再读写令牌；都不命中返回 null。 */
export async function findApiToken(
  db: D1Database,
  prefix: string,
  token: string
): Promise<ApiTokenIdentity | null> {
  const read = await findReadToken(db, prefix, token)
  if (read) return { ...read, kind: "read" }
  const write = await findWriteToken(db, prefix, token)
  if (write) return { ...write, kind: "write" }
  return null
}
