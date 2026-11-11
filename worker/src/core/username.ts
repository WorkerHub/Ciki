/**
 * 用户名唯一性：新建号取名（注册 / 管理员建号）与存量重名消解（迁移）。
 *
 * 唯一权威是 `users.username` 上的唯一索引（大小写不敏感、空串除外）。下面两条
 * 路径都只是「尽量一次写对」的辅助：
 * - 新建号先查重拿空位，写入仍撞键就换下一个后缀重试——查重与写入之间的竞态由
 *   索引兜底，不会 500；
 * - 迁移在建索引之前先把存量重名消解掉（id 最小者保留原名、其余 -2/-3），否则
 *   唯一索引建不上。
 *
 * 后缀口径与 `usernameWithSuffix` 同一份实现：后缀算在 40 码点之内。
 */
import {
  cleanUsername,
  isUsernameConflict,
  usernameWithSuffix
} from "./identity"
import { usernameTaken } from "../db/queries/users"

/** 撞名重试上限：留足余量，正常一次就中。超过说明基础名被占得离谱，直接报错。 */
export const MAX_USERNAME_ATTEMPTS = 50

/**
 * 唯一性比较口径与索引的 `COLLATE NOCASE` 完全一致：只折 ASCII 大写字母。
 * 不能用 `toLowerCase()`——它会把 `é`/`É` 也当成重名（索引认为两者不同），
 * 白白改掉一个本来不重名的用户名。
 */
function usernameKey(name: string): string {
  return name.replace(/[A-Z]/g, (char) => char.toLowerCase())
}

/**
 * 消解一张 users 表（正式表或重建用的 `v7_users` 临时表）里的重名，返回改名条数。
 *
 * 只做一件事：给真正的重名（大小写不敏感）补 `-2`、`-3` 后缀（后缀算在 40 码点内，
 * 基础名太长时截短腾位），同一名字里 id 最小者保留原名。**其余用户名一字不改**：
 * 不 trim、不截断、空串也不改写（索引的 `WHERE username <> ''` 已把空串排除在唯一
 * 约束之外，它不会造成撞键）。
 *
 * 只对真的变了的行发 UPDATE，全部改动在一次 `db.batch()`（D1 的事务单位）里提交：
 * 要么全改、要么一条都不改（升级失败时旧库的用户名原样保留）；`updated_at` 不动。
 * 幂等：干净的表上一条 UPDATE 都不会发。
 */
export async function resolveDuplicateUsernames(
  db: D1Database,
  table: string
): Promise<number> {
  const rows = await db
    .prepare(`SELECT id, username FROM ${table} ORDER BY id`)
    .all<{ id: number; username: string }>()

  const taken = new Set<string>()
  const updates: Array<{ id: number; username: string }> = []

  for (const row of rows.results) {
    // 空串不参与唯一约束，也不占用任何名字：原样留着，多个空串可以共存。
    if (row.username === "") continue

    let candidate = row.username
    let n = 2
    while (taken.has(usernameKey(candidate))) {
      candidate = usernameWithSuffix(row.username, n)
      n += 1
    }
    taken.add(usernameKey(candidate))
    if (candidate !== row.username) {
      updates.push({ id: row.id, username: candidate })
    }
  }

  if (updates.length > 0) {
    await db.batch(
      updates.map((entry) =>
        db
          .prepare(`UPDATE ${table} SET username = ? WHERE id = ?`)
          .bind(entry.username, entry.id)
      )
    )
  }

  return updates.length
}

/**
 * 以 `base` 为起点取一个没被占用的用户名并写入。
 *
 * `insert` 是真正的建号语句，拿到候选名后执行；它抛用户名唯一约束冲突（并发下
 * 别人刚好占了这个名字）就换下一个后缀重试，其它错误原样抛给调用方（邮箱冲突仍
 * 由路由层映射成 409）。attempt 1 就是 `base` 本身，之后依次 `-2`、`-3`…。
 *
 * 回调返回 `null`（注册的首个用户守卫在写库那一刻发现表已非空、一个字节都没写）
 * 时**原样返回、不重试**：那是路由层 503 `EMAIL_NOT_CONFIGURED` 的唯一来源，
 * 吞掉它去重试只会把 503 变成重试耗尽后的 500。
 */
export async function insertWithUniqueUsername<T>(
  db: D1Database,
  prefix: string,
  base: string,
  insert: (username: string) => Promise<T>
): Promise<T> {
  const startingName = cleanUsername(base)
  for (let attempt = 1; attempt <= MAX_USERNAME_ATTEMPTS; attempt += 1) {
    const candidate = usernameWithSuffix(startingName, attempt)
    if (await usernameTaken(db, prefix, candidate)) continue
    try {
      return await insert(candidate)
    } catch (err) {
      if (isUsernameConflict(err)) continue
      throw err
    }
  }
  throw new Error(
    "Could not allocate a unique username: too many collisions for this display name"
  )
}
