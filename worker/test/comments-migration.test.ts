/**
 * `schema_v5` 的升级通道演练（规格「页尾评论」基建条款）：部署了代码、管理员在
 * 「系统管理 → 数据库维护」点一次升级之前，评论表还不存在；点完之后表与索引一次建全，
 * 账本登记 `schema_v5`，再点只显示 `skipped`。
 *
 * 用真实 SQLite（测试替身 node:sqlite）走线上同一条 `runSetup` → 迁移执行器。
 */
import { describe, expect, it } from "vitest"
import { runSetup } from "../src/lib/setup"
import {
  TEST_SETUP_SECRET,
  initializedContext,
  makeContext,
  request,
  type TestContext
} from "./support/app"

function tableNames(context: TestContext): string[] {
  return (
    context.db.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name)
}

function indexNames(context: TestContext): string[] {
  return (
    context.db.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name)
}

function commentColumns(context: TestContext): string[] {
  return (
    context.db.db.prepare("PRAGMA table_info(ciki_comments)").all() as Array<{
      name: string
    }>
  ).map((column) => column.name)
}

/** 复现「部署了代码、管理员还没点升级」的库：评论表被去掉、账本里没有 schema_v5。 */
function simulatePreUpgrade(context: TestContext): void {
  context.db.exec("DROP TABLE ciki_comments")
  context.db.exec(
    "DELETE FROM _ciki_schema_migrations WHERE name = 'schema_v5'"
  )
}

describe("schema_v5：评论表与升级通道", () => {
  it("全新库：setup 一次建出 comments 表与三个索引，列形状照契约", async () => {
    const context = makeContext()
    const res = await request(context.env, "/api/setup", {
      method: "POST",
      headers: { "x-setup-secret": TEST_SETUP_SECRET }
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      migrations: Array<{ name: string; status: string }>
    }
    expect(body.migrations[body.migrations.length - 1]).toEqual({
      name: "schema_v5",
      status: "applied"
    })

    expect(tableNames(context)).toContain("ciki_comments")
    for (const index of [
      "ciki_comments_page_created",
      "ciki_comments_parent",
      "ciki_comments_author"
    ]) {
      expect(indexNames(context)).toContain(index)
    }
    expect(commentColumns(context)).toEqual([
      "id",
      "page_id",
      "parent_id",
      "author_id",
      "body_md",
      "created_at",
      "edited_at",
      "deleted_at"
    ])
  })

  it("升级前的库：点一次升级补上表与索引并记账，再点全部 skipped", async () => {
    const context = await initializedContext()
    simulatePreUpgrade(context)
    expect(tableNames(context)).not.toContain("ciki_comments")

    const result = await runSetup(context.env)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v2", status: "skipped" },
      { name: "schema_v3", status: "skipped" },
      { name: "schema_v4", status: "skipped" },
      { name: "schema_v5", status: "applied" }
    ])

    expect(tableNames(context)).toContain("ciki_comments")
    expect(indexNames(context)).toContain("ciki_comments_page_created")
    const ledger = context.db.db
      .prepare("SELECT name FROM _ciki_schema_migrations WHERE name = ?")
      .get("schema_v5") as { name: string } | undefined
    expect(ledger?.name).toBe("schema_v5")

    // 幂等：再点一次只显示 skipped，结构不变。
    const again = await runSetup(context.env)
    expect(again.success).toBe(true)
    if (!again.success) return
    expect(again.migrations[again.migrations.length - 1]).toEqual({
      name: "schema_v5",
      status: "skipped"
    })
    expect(commentColumns(context)).toHaveLength(8)
  })

  it("无前缀部署（TABLE_PREFIX 显式置空）：表名不带前缀，索引同一套 helper", async () => {
    const context = await initializedContext({ TABLE_PREFIX: "" })
    expect(tableNames(context)).toContain("comments")
    expect(tableNames(context)).not.toContain("ciki_comments")
    expect(indexNames(context)).toContain("comments_page_created")
    expect(indexNames(context)).toContain("comments_parent")
    expect(indexNames(context)).toContain("comments_author")
  })
})
