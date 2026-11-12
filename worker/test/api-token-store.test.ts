/**
 * 令牌存储层（管理 API 直接复用的地基能力）与名称规则的单测。
 *
 * 这里只驱动 `core/api-token.ts` / `core/import-token.ts`，不经路由：
 * - 名称规则是规格 §1 的硬口径（trim、≤40 码点、留空默认名），必须钉住；
 * - `api_tokens` 的 kind 建行固定、有效行列表、改名、按 id 吊销都要能独立验证；
 * - `import_tokens` 多行、吊销按行、创建是追加。
 */
import { describe, expect, it } from "vitest"
import {
  API_TOKEN_NAME_MAX,
  defaultTokenName,
  getTokenRowById,
  issueApiToken,
  listActiveTokens,
  parseTokenName,
  parseTokenNameUpdate,
  renameToken,
  revokeTokenById
} from "../src/core/api-token"
import {
  issueImportToken,
  listActiveImportTokens,
  parseImportTokenName,
  revokeImportTokenById
} from "../src/core/import-token"
import { getTokenScope, listUserTokenScopes } from "../src/core/token-scope"
import { adminSession, initializedContext, userSession } from "./support/app"
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

  it("改名口径：trim 后 1–40 码点，空白不是「用默认名」", () => {
    expect(parseTokenNameUpdate("  新名  ")).toEqual({ ok: true, name: "新名" })
    expect(parseTokenNameUpdate("")).toEqual({
      ok: false,
      reason: "INVALID_TOKEN_NAME"
    })
    expect(parseTokenNameUpdate("   ")).toEqual({
      ok: false,
      reason: "INVALID_TOKEN_NAME"
    })
    expect(parseTokenNameUpdate("字".repeat(41))).toEqual({
      ok: false,
      reason: "INVALID_TOKEN_NAME"
    })
    expect(parseTokenNameUpdate("😀".repeat(API_TOKEN_NAME_MAX))).toMatchObject(
      {
        ok: true
      }
    )
    expect(parseTokenNameUpdate(42)).toEqual({
      ok: false,
      reason: "INVALID_TOKEN_NAME"
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

  it("有效行列表、改名不改 kind、按 id 吊销幂等；范围按令牌行各存各的", async () => {
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

    // 列表只含未吊销行（已吊销的 second 不再出现）。
    const active = await listActiveTokens(ctx.env.DB, PREFIX, userId)
    expect(active.map((row) => row.id)).toEqual([first.id])
  })

  it("listUserTokenScopes：一次查齐本人有效令牌的范围，无行不在 Map 里", async () => {
    const ctx = await initializedContext()
    const admin = await adminSession(ctx.env)
    const userId = (
      ctx.db.db
        .prepare("SELECT id FROM ciki_users WHERE email = ?")
        .get("admin@example.com") as { id: number }
    ).id
    const scoped = await issueApiToken(ctx.env.DB, PREFIX, userId, {
      kind: "read",
      scope: [3, 1]
    })
    const plain = await issueApiToken(ctx.env.DB, PREFIX, userId, {
      kind: "write"
    })
    await userSession(ctx.env, admin, "other@example.com")
    const other = (
      ctx.db.db
        .prepare("SELECT id FROM ciki_users WHERE email = ?")
        .get("other@example.com") as { id: number }
    ).id

    const scopes = await listUserTokenScopes(ctx.env.DB, PREFIX, userId)
    expect(scopes.get(scoped.id)).toEqual([1, 3])
    expect(scopes.has(plain.id)).toBe(false)
    // 别人的令牌不在结果里。
    const foreign = await issueApiToken(ctx.env.DB, PREFIX, other, {
      kind: "read",
      scope: [2]
    })
    expect(
      (await listUserTokenScopes(ctx.env.DB, PREFIX, userId)).has(foreign.id)
    ).toBe(false)
  })
})

describe("import_tokens 存储层", () => {
  it("多行新建、默认名、按 id 吊销只断一枚", async () => {
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
      (await listActiveImportTokens(ctx.env.DB, PREFIX, userId))[0].name
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

    // 新建是追加：吊销一枚不影响另一枚，新行也不覆盖旧行。
    const third = await issueImportToken(ctx.env.DB, PREFIX, userId)
    expect(
      (await listActiveImportTokens(ctx.env.DB, PREFIX, userId)).map(
        (row) => row.id
      )
    ).toEqual([second.id, third.id])
  })
})
