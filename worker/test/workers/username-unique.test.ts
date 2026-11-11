/**
 * username 唯一索引在 **workerd + 真实 D1** 里的并发与报错分类护栏（#92 A）。
 *
 * 为什么必须在这里跑：Node 侧的用例喂的是手写错误字符串，而 workerd/Miniflare 的
 * D1 会在报错尾部追加 `(extended: SQLITE_CONSTRAINT_UNIQUE)`——手写串盖不住这个
 * 差异，结果就是 CI 全绿、运行时并发注册回 500（#92 实测同邮箱并发 3/3 轮 500）。
 * 这里用本地 D1 真跑：真撞一次唯一约束看分类、再并发建号看会不会 500。
 *
 * 只用本地 Miniflare，不连远端；表结构按 `schema.ts` 的 users 关键列手工建，
 * 不依赖 `test/support/*`（那套是 Node 专用的 D1 替身）。
 */
import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { isEmailConflict, isUsernameConflict } from "../../src/core/identity"
import { insertWithUniqueUsername } from "../../src/core/username"

const DB = env.DB
const TABLE = "ciki_users"

/** 定版结构里与用户名相关的部分 + 与 SCHEMA_INDEXES 同一条唯一索引。 */
async function seedSchema(): Promise<void> {
  // 一条语句一行：D1 的 exec() 按行切分，多行 CREATE 会被拆坏。
  await DB.prepare(`DROP TABLE IF EXISTS ${TABLE}`).run()
  await DB.prepare(
    `CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, ` +
      `email TEXT UNIQUE NOT NULL, username TEXT NOT NULL DEFAULT '')`
  ).run()
  await DB.prepare(
    `CREATE UNIQUE INDEX ${TABLE}_username ON ${TABLE}(username COLLATE NOCASE) WHERE username <> ''`
  ).run()
}

async function insertUser(email: string, username: string): Promise<void> {
  await DB.prepare(`INSERT INTO ${TABLE} (email, username) VALUES (?, ?)`)
    .bind(email, username)
    .run()
}

async function usernames(): Promise<string[]> {
  const rows = await DB.prepare(
    `SELECT username FROM ${TABLE} ORDER BY id`
  ).all<{
    username: string
  }>()
  return rows.results.map((row) => row.username)
}

describe("workerd：username 唯一索引与并发取名", () => {
  beforeEach(async () => {
    await seedSchema()
  })

  it("真实 D1 的撞键报错被识别成用户名冲突，邮箱撞键不会被误判", async () => {
    await insertUser("taken@example.com", "dup")

    let usernameErr: unknown
    try {
      await insertUser("other@example.com", "DUP")
    } catch (err) {
      usernameErr = err
    }
    expect(usernameErr).toBeInstanceOf(Error)
    expect(isUsernameConflict(usernameErr)).toBe(true)

    let emailErr: unknown
    try {
      await insertUser("taken@example.com", "another")
    } catch (err) {
      emailErr = err
    }
    expect(emailErr).toBeInstanceOf(Error)
    expect(isUsernameConflict(emailErr)).toBe(false)
    // 另一端：邮箱撞键必须仍被识别成邮箱冲突（路由据此回 409 EMAIL_TAKEN，
    // 不是 500）——同邮箱并发注册曾因用户名/邮箱两条唯一约束同时存在而炸成 500。
    expect(isEmailConflict(emailErr)).toBe(true)
  })

  it("查重后写入才撞键：换下一个后缀落库，不抛错", async () => {
    let injected = false
    const name = await insertWithUniqueUsername(
      DB,
      "ciki_",
      "fresh",
      async (username) => {
        if (!injected) {
          // 查重与写入之间，另一个请求抢先占了这个名字。
          injected = true
          await insertUser("blocker@example.com", username)
        }
        await insertUser(`u-${username}@example.com`, username)
        return username
      }
    )
    expect(name).toBe("fresh-2")
    expect(await usernames()).toEqual(["fresh", "fresh-2"])
  })

  it("并发取名：同一前缀同时建号，全部成功且名字互不相同", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        insertWithUniqueUsername(DB, "ciki_", "dup", async (username) => {
          await insertUser(`u${index}@example.com`, username)
          return username
        })
      )
    )

    expect(new Set(results).size).toBe(results.length)
    expect((await usernames()).sort()).toEqual([...results].sort())
  })
})
