/**
 * 令牌存储层（B 单直接复用的地基能力）与名称规则的单测。
 *
 * 这里只驱动 `core/api-token.ts` / `core/import-token.ts`，不经路由：
 * - 名称规则是规格 §1 的硬口径（trim、≤40 码点、留空默认名），必须钉住；
 * - `api_tokens` 的 kind 建行固定、有效行列表、改名、按 id 吊销都要能独立验证；
 * - `import_tokens` 多行、`replaceExisting` 只留一枚有效行。
 */
import { describe, expect, it } from "vitest"
import {
  API_TOKEN_NAME_MAX,
  defaultTokenName,
  getLatestTokenRow,
  getTokenRowById,
  issueApiToken,
  listActiveTokens,
  parseTokenName,
  renameToken,
  revokeTokenById
} from "../src/core/api-token"
import {
  getImportTokenById,
  issueImportToken,
  listActiveImportTokens,
  parseImportTokenName,
  revokeImportTokenById
} from "../src/core/import-token"
import { getTokenScope } from "../src/core/token-scope"
import { adminSession, initializedContext } from "./support/app"
import type { TestContext } from "./support/app"

const PREFIX = "ciki_"

async function adminUserId(ctx: TestContext): Promise<number> {
  await adminSession(ctx.env)
  const row = ctx.db.db
    .prepare("SELECT id FROM ciki_users ORDER BY id LIMIT 1")
    .get() as { id: number }
  return row.id
}

describe("令牌名称规则（规格 §1）", () => {
  it("缺省 / 空白用默认名；普通输入 trim 后保留", () => {
    expect(parseTokenName(undefined, "read")).toEqual({
      ok: true,
      name: "只读 Token"
    })
    expect(parseTokenName(null, "write")).toEqual({
      ok: true,
      name: "读写 Token"
    })
    expect(parseTokenName("   ", "read")).toEqual({
      ok: true,
      name: defaultTokenName("read")
    })
    expect(parseTokenName("  My Key  ", "read")).toEqual({
      ok: true,
      name: "My Key"
    })
  })

  it("上限 40 个码点（emoji 按码点算），41 拒绝；非字符串拒绝", () => {
    const forty = "字".repeat(API_TOKEN_NAME_MAX)
    expect(parseTokenName(forty, "read")).toEqual({ ok: true, name: forty })
    expect(parseTokenName(`${forty}字`, "read")).toEqual({
      ok: false,
      reason: "INVALID_TOKEN_NAME"
    })

    // 40 个 emoji = 80 个 UTF-16 单元，但只有 40 个码点，应当通过。
    const emoji = "😀".repeat(API_TOKEN_NAME_MAX)
    expect(Array.from(emoji)).toHaveLength(API_TOKEN_NAME_MAX)
    expect(parseTokenName(emoji, "write")).toEqual({ ok: true, name: emoji })

    expect(parseTokenName(42, "read")).toEqual({
      ok: false,
      reason: "INVALID_TOKEN_NAME"
    })
  })

  it("导入令牌默认名「浏览器插件」，同一套 trim / 码点口径", () => {
    expect(parseImportTokenName(undefined)).toEqual({
      ok: true,
      name: "浏览器插件"
    })
    expect(parseImportTokenName("  ")).toEqual({
      ok: true,
      name: "浏览器插件"
    })
    expect(parseImportTokenName(" 插件甲 ")).toEqual({
      ok: true,
      name: "插件甲"
    })
    expect(parseImportTokenName("字".repeat(API_TOKEN_NAME_MAX + 1))).toEqual({
      ok: false,
      reason: "INVALID_TOKEN_NAME"
    })
  })
})

describe("api_tokens 存储层", () => {
  it("issueApiToken：kind 固定、名称与范围按新令牌行落库", async () => {
    const ctx = await initializedContext()
    const userId = await adminUserId(ctx)
    const issued = await issueApiToken(ctx.env.DB, PREFIX, userId, {
      kind: "read",
      name: "第一枚",
      scope: [1]
    })

    const row = await getTokenRowById(ctx.env.DB, PREFIX, userId, issued.id)
    expect(row).toMatchObject({
      id: issued.id,
      user_id: userId,
      kind: "read",
      name: "第一枚",
      created_at: issued.createdAt,
      last_used_at: null,
      revoked_at: null
    })
    expect(await getTokenScope(ctx.env.DB, PREFIX, issued.id)).toEqual([1])
  })

  it("有效行列表、改名不改 kind、按 id 吊销幂等；最新行含已吊销", async () => {
    const ctx = await initializedContext()
    const userId = await adminUserId(ctx)

    const first = await issueApiToken(ctx.env.DB, PREFIX, userId, {
      kind: "read",
      name: "甲"
    })
    const second = await issueApiToken(ctx.env.DB, PREFIX, userId, {
      kind: "read",
      name: "乙"
    })
    expect(
      (await listActiveTokens(ctx.env.DB, PREFIX, userId)).map((row) => row.id)
    ).toEqual([first.id, second.id])

    expect(
      await renameToken(ctx.env.DB, PREFIX, userId, second.id, "乙改名")
    ).toBe(true)
    const renamed = await getTokenRowById(ctx.env.DB, PREFIX, userId, second.id)
    expect(renamed?.name).toBe("乙改名")
    expect(renamed?.kind).toBe("read")

    expect(await revokeTokenById(ctx.env.DB, PREFIX, userId, second.id)).toBe(
      true
    )
    expect(await revokeTokenById(ctx.env.DB, PREFIX, userId, second.id)).toBe(
      false
    )
    expect(
      (await listActiveTokens(ctx.env.DB, PREFIX, userId)).map((row) => row.id)
    ).toEqual([first.id])
    expect(
      await renameToken(ctx.env.DB, PREFIX, userId, second.id, "再改")
    ).toBe(false)

    // 最新一行含已吊销：旧端点的范围沿用与状态回读都依赖这一点。
    const latest = await getLatestTokenRow(ctx.env.DB, PREFIX, userId, "read")
    expect(latest?.id).toBe(second.id)
    expect(latest?.revoked_at).not.toBeNull()
  })
})

describe("import_tokens 存储层", () => {
  it("多行新建、默认名、按 id 吊销；replaceExisting 只留一枚有效行", async () => {
    const ctx = await initializedContext()
    const userId = await adminUserId(ctx)

    const first = await issueImportToken(ctx.env.DB, PREFIX, userId)
    const second = await issueImportToken(ctx.env.DB, PREFIX, userId, {
      name: "插件乙"
    })
    expect(
      (await listActiveImportTokens(ctx.env.DB, PREFIX, userId)).map(
        (row) => row.name
      )
    ).toEqual(["浏览器插件", "插件乙"])
    expect(
      (await getImportTokenById(ctx.env.DB, PREFIX, userId, first.id))?.name
    ).toBe("浏览器插件")

    expect(
      await revokeImportTokenById(ctx.env.DB, PREFIX, userId, first.id)
    ).toBe(true)
    expect(
      await revokeImportTokenById(ctx.env.DB, PREFIX, userId, first.id)
    ).toBe(false)
    expect(
      (await listActiveImportTokens(ctx.env.DB, PREFIX, userId)).map(
        (row) => row.id
      )
    ).toEqual([second.id])

    // 旧端点的「重置」走 replaceExisting：旧有效行吊销，只留新行有效。
    const third = await issueImportToken(ctx.env.DB, PREFIX, userId, {
      replaceExisting: true
    })
    expect(
      (await listActiveImportTokens(ctx.env.DB, PREFIX, userId)).map(
        (row) => row.id
      )
    ).toEqual([third.id])
  })
})
