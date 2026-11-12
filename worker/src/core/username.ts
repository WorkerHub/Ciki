/**
 * 用户名唯一性：新建号取名（注册 / 管理员建号）。
 *
 * 唯一权威是 `users.username` 上的唯一索引（大小写不敏感、空串除外），它自 `schema_v1`
 * 基线起就在（全新库一步建全），所以不存在「先消重再建索引」的存量升级步骤。下面这条
 * 路径只是「尽量一次写对」的辅助：先查重拿空位，写入仍撞键就换下一个后缀重试——查重与
 * 写入之间的竞态由索引兜底，不会 500。
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
