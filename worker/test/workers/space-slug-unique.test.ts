/**
 * spaces slug 唯一索引在 **workerd + 真实 D1** 里的报错分类护栏。
 *
 * 验证 workerd/Miniflare D1 报出 `(extended: SQLITE_CONSTRAINT_UNIQUE)` 尾部时，
 * `isSpaceSlugConflict` 能正确判定为 slug 冲突，且其它约束错误不会被误认。
 */
import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import {
  isSpaceSlugConflict,
  isUsernameConflict
} from "../../src/core/identity"

const DB = env.DB
const TABLE = "ciki_spaces"

async function seedSchema(): Promise<void> {
  await DB.prepare(`DROP TABLE IF EXISTS ${TABLE}`).run()
  await DB.prepare(
    `CREATE TABLE ${TABLE} (` +
      `id INTEGER PRIMARY KEY AUTOINCREMENT, ` +
      `slug TEXT NOT NULL, ` +
      `name TEXT NOT NULL, ` +
      `description TEXT NOT NULL DEFAULT '', ` +
      `is_default INTEGER NOT NULL DEFAULT 0, ` +
      `created_by INTEGER NOT NULL DEFAULT 0, ` +
      `created_at TEXT NOT NULL, ` +
      `updated_at TEXT NOT NULL)`
  ).run()
  await DB.prepare(`CREATE UNIQUE INDEX ${TABLE}_slug ON ${TABLE}(slug)`).run()
}

async function insertSpace(slug: string, name: string): Promise<void> {
  const now = new Date().toISOString()
  await DB.prepare(
    `INSERT INTO ${TABLE} (slug, name, description, is_default, created_by, created_at, updated_at) ` +
      `VALUES (?, ?, '', 0, 1, ?, ?)`
  )
    .bind(slug, name, now, now)
    .run()
}

describe("workerd：spaces slug 唯一索引与报错分类", () => {
  beforeEach(async () => {
    await seedSchema()
  })

  it("真实 D1 的 slug 撞键报错被识别为 slug 冲突，且不被误认为 username 冲突", async () => {
    await insertSpace("research-lab", "Research Lab")

    let slugErr: unknown
    try {
      await insertSpace("research-lab", "Another Lab")
    } catch (err) {
      slugErr = err
    }
    expect(slugErr).toBeInstanceOf(Error)
    expect(isSpaceSlugConflict(slugErr)).toBe(true)
    expect(isUsernameConflict(slugErr)).toBe(false)
  })

  it("非唯一约束错误（如 NOT NULL）不被误判为 slug 冲突", async () => {
    let notNullErr: unknown
    try {
      await DB.prepare(
        `INSERT INTO ${TABLE} (slug, name, created_at, updated_at) VALUES (NULL, ?, ?, ?)`
      )
        .bind(
          "Null Slug",
          "2026-11-26T00:00:00.000Z",
          "2026-11-26T00:00:00.000Z"
        )
        .run()
    } catch (err) {
      notNullErr = err
    }
    expect(notNullErr).toBeInstanceOf(Error)
    expect(isSpaceSlugConflict(notNullErr)).toBe(false)
  })
})
