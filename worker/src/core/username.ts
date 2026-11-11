/**
 * 用户名唯一性：新建号取名（注册 / 管理员建号）与存量重名消解（迁移）。
 *
 * 唯一权威是 `users.username` 上的唯一索引（大小写不敏感、空串除外）。下面两条
 * 路径都只是「尽量一次写对」的辅助：
 * - 新建号先查重拿空位，写入仍撞键就换下一个后缀重试——查重与写入之间的竞态由
 *   索引兜底，不会 500；
 * - 迁移在建索引之前先按「id 最小者保留原名、其余 -2/-3、空串归一『用户』」
 *   把存量重名消解掉，否则唯一索引建不上。
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

/** 每批 UPDATE 条数：单次 `db.batch()` 别塞太大，用户量也不大。 */
const RENAMES_PER_BATCH = 100

/** 唯一性比较口径：与索引的 COLLATE NOCASE 对齐（只折 ASCII 大小写）。 */
function usernameKey(name: string): string {
  return name.toLowerCase()
}

/**
 * 消解一张 users 表（正式表或重建用的 `v7_users` 临时表）里的重名，返回改名条数。
 *
 * 按 id 升序逐行分配：候选名先按 `cleanUsername` 规范化（去控制字符、trim、截到
 * 40 码点、空串→「用户」），被先前的行占用就继续 `-2`、`-3`…找空位。只对真的
 * 变了的行发 UPDATE，`updated_at` 不动（这是结构归一，不是用户改名）。
 *
 * 幂等：干净的表上一条 UPDATE 都不会发。调用方必须在建唯一索引之前调用它。
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
    const base = cleanUsername(row.username ?? "")
    let candidate = base
    let n = 2
    while (taken.has(usernameKey(candidate))) {
      candidate = usernameWithSuffix(base, n)
      n += 1
    }
    taken.add(usernameKey(candidate))
    if (candidate !== row.username) {
      updates.push({ id: row.id, username: candidate })
    }
  }

  for (let start = 0; start < updates.length; start += RENAMES_PER_BATCH) {
    const batch = updates.slice(start, start + RENAMES_PER_BATCH)
    await db.batch(
      batch.map((entry) =>
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
