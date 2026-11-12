/**
 * 接口 E 单独立验证（Jim）：二/三期 §7 合并矩阵一次验完。
 *
 * 环境：本地 Node + `SqliteD1`（miniflare 同源 SQLite 白名单）+ 内存 R2 替身，
 * **不是生产实测**（团队无 Cloudflare 写凭据，生产升级点击由用户本人执行）。
 *
 * 每条 `it` 对应矩阵里的一行，布景独立、断言只来自冻结契约
 * （docs/api-contract.md 与三期规格 §1/§2/§4/§5），不复用主单自测的断言条件。
 * 用例是验证产物：只读调用产品端点，不替开发改实现。
 */
import { describe, expect, it } from "vitest"
import { sha256Hex } from "../src/core/auth"
import { runSetup } from "../src/lib/setup"
import { migrationsTable, tableName } from "../src/lib/tables"
import {
  adminSession,
  createApiToken,
  createImportToken,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"
import type { TestContext } from "./support/app"
import { createV8Database, rowsOf, seedV8Database } from "./support/v8-schema"
import type { Env } from "../src/types"

const PREFIX = "ciki_"
const table = (name: string) => tableName(PREFIX, name)

/** 限流失败桶的动作名（契约：按 IP 20 次 / 5 分钟，先拒后验）。 */
const READ_AUTH_FAIL = "read_auth_fail"
const WRITE_AUTH_FAIL = "write_auth_fail"

/** 会话 Cookie 的 `name=value`（测试里只是个字符串）。 */
type Cookie = string

/** 一张最小的合法 PNG（魔数 + 头几个字节），只为过类型嗅探。 */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52
])

interface SpaceDto {
  id: number
  slug: string
  name: string
  isDefault: boolean
  createdAt: string
}

interface PageMeta {
  id: number
  space_id: number
  parent_id: number | null
  sort_order: number
  title: string
  updated_at: string
}

interface TreeRow {
  id: number
  title: string
  parent_id: number | null
  space_id: number
  sort_order: number
  updated_at: string
}

function doc(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }]
  }
}

function docJson(text: string): string {
  return JSON.stringify(doc(text))
}

/** 富结构正文：标题、粗斜体/行内代码/链接、列表、代码块、引用、表格、分割线。 */
const RICH_DOC = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "往返保真" }]
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "普通 " },
        { type: "text", marks: [{ type: "bold" }], text: "粗体" },
        { type: "text", marks: [{ type: "italic" }], text: "斜体" },
        { type: "text", marks: [{ type: "code" }], text: "行内码" },
        {
          type: "text",
          marks: [
            {
              type: "link",
              attrs: { href: "https://example.com/a", target: null }
            }
          ],
          text: "链接"
        }
      ]
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "条目一" }] }
          ]
        },
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "条目二" }] }
          ]
        }
      ]
    },
    {
      type: "codeBlock",
      attrs: { language: "ts", collapsed: false },
      content: [{ type: "text", text: "const x = 1" }]
    },
    {
      type: "blockquote",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "引用一行" }] }
      ]
    },
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              attrs: { colspan: 1, rowspan: 1 },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "头" }] }
              ]
            }
          ]
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              attrs: { colspan: 1, rowspan: 1 },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "值" }] }
              ]
            }
          ]
        }
      ]
    },
    { type: "horizontalRule" }
  ]
})

function expectStatus(res: Response, status: number, note: string) {
  expect(res.status, `${note}: 期望 ${status}，实际 ${res.status}`).toBe(status)
}

function bearer(
  env: Env,
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`
  }
  if (body !== undefined) headers["content-type"] = "application/json"
  return request(env, path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

function formWith(bytes: Uint8Array, type: string): FormData {
  const form = new FormData()
  form.append("file", new File([bytes], "upload.bin", { type }))
  return form
}

function upload(env: Env, path: string, token: string, form: FormData) {
  return request(env, path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form
  })
}

async function listSpaces(env: Env, cookie: Cookie): Promise<SpaceDto[]> {
  const res = await jsonRequest(env, "GET", "/api/spaces", undefined, cookie)
  expectStatus(res, 200, "GET /api/spaces")
  return (await res.json()) as SpaceDto[]
}

async function defaultSpaceId(env: Env, cookie: Cookie): Promise<number> {
  const row = (await listSpaces(env, cookie)).find((space) => space.isDefault)
  if (!row) throw new Error("默认空间不存在")
  return row.id
}

async function createSpace(
  env: Env,
  cookie: Cookie,
  name: string
): Promise<SpaceDto> {
  const res = await jsonRequest(env, "POST", "/api/spaces", { name }, cookie)
  expectStatus(res, 201, `POST /api/spaces ${name}`)
  return (await res.json()) as SpaceDto
}

async function meId(env: Env, cookie: Cookie): Promise<number> {
  const res = await jsonRequest(env, "GET", "/api/me", undefined, cookie)
  expectStatus(res, 200, "GET /api/me")
  return ((await res.json()) as { id: number }).id
}

/**
 * 把用户设成空间里的指定角色。
 * 自助注册会自动加入默认空间（editor），所以「已在空间」的 409 先 PUT 改角色；
 * 其余状态码仍按契约断言。
 */
async function addMember(
  env: Env,
  admin: Cookie,
  spaceId: number,
  userId: number,
  role: "admin" | "editor" | "viewer"
): Promise<void> {
  const res = await jsonRequest(
    env,
    "POST",
    `/api/spaces/${spaceId}/members`,
    { userId, role },
    admin
  )
  if (res.status === 201) return
  expectStatus(res, 409, `POST /api/spaces/${spaceId}/members`)
  expect(await res.json()).toMatchObject({ code: "ALREADY_MEMBER" })
  expectStatus(
    await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${spaceId}/members/${userId}`,
      { role },
      admin
    ),
    200,
    `PUT /api/spaces/${spaceId}/members/${userId}`
  )
}

/** 站内会话建页（数据面用例的布景，不经过令牌）。 */
async function sessionPage(
  env: Env,
  cookie: Cookie,
  input: { title: string; spaceId?: number; text?: string }
): Promise<PageMeta & { spaceId: number }> {
  const text = input.text ?? input.title
  const res = await jsonRequest(
    env,
    "POST",
    "/api/pages",
    {
      title: input.title,
      parentId: null,
      spaceId: input.spaceId ?? null,
      contentJson: docJson(text),
      contentHtml: `<p>${text}</p>`,
      contentText: text
    },
    cookie
  )
  expectStatus(res, 201, `站内建页 ${input.title}`)
  const body = (await res.json()) as {
    id: number
    spaceId: number
    parentId: number | null
    sortOrder: number
    title: string
    updatedAt: string
  }
  return {
    id: body.id,
    space_id: body.spaceId,
    parent_id: body.parentId,
    sort_order: body.sortOrder,
    title: body.title,
    updated_at: body.updatedAt,
    spaceId: body.spaceId
  }
}

function countRows(ctx: TestContext, sql: string, ...binds: unknown[]) {
  return (ctx.db.db.prepare(sql).get(...binds) as { n: number } | undefined)?.n
}

function seedCounter(
  ctx: TestContext,
  action: string,
  account: string,
  ip: string,
  count: number
): void {
  const now = Math.floor(Date.now() / 1000)
  ctx.db.db
    .prepare(
      `INSERT INTO ${table("auth_counters")}
        (key, action, account, ip, count, window_start, locked_until, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = excluded.count,
         window_start = excluded.window_start,
         updated_at = excluded.updated_at`
    )
    .run(`${action}:${account}:${ip}`, action, account, ip, count, now, now)
}

function readSpaces(env: Env, token: string) {
  return bearer(env, token, "GET", "/api/read/spaces")
}

async function readSpaceIds(env: Env, token: string): Promise<number[]> {
  const res = await readSpaces(env, token)
  expectStatus(res, 200, "GET /api/read/spaces")
  const body = (await res.json()) as {
    spaces: Array<{ id: number; name: string; slug: string }>
  }
  return body.spaces.map((space) => space.id)
}

async function readTree(env: Env, token: string): Promise<TreeRow[]> {
  const res = await bearer(env, token, "GET", "/api/read/tree")
  expectStatus(res, 200, "GET /api/read/tree")
  return (await res.json()) as TreeRow[]
}

async function readSearchIds(
  env: Env,
  token: string,
  query: string
): Promise<number[]> {
  const res = await bearer(
    env,
    token,
    "GET",
    `/api/read/search?q=${encodeURIComponent(query)}`
  )
  expectStatus(res, 200, "GET /api/read/search")
  return ((await res.json()) as Array<{ id: number }>).map((row) => row.id)
}

// ════════════════════════════════════════════════════════════════════════════
// §7 第 1 条：迁移
// ════════════════════════════════════════════════════════════════════════════

const LEGACY = {
  read: { u1: "legacy-read-u1", u2: "legacy-read-u2" },
  write: { u1: "legacy-write-u1", u2Revoked: "legacy-write-u2" },
  imports: { u1: "legacy-import-u1", u2: "legacy-import-u2" }
}
const LEGACY_NOW = "2026-03-01T00:00:00.000Z"
const LEGACY_USED = "2026-03-02T00:00:00.000Z"

/**
 * 「当前生产形态」夹具 = v1 基线结构 + 账本 v1/v2 + v2 的两张令牌表。
 * 令牌按矩阵要求每类两行（读写其中一枚已吊销），范围 4 行、导入 2 行，
 * 升级后逐项对账（按 kind 令牌数 / scope 行数 / 导入数）。
 */
async function v2Context(): Promise<TestContext> {
  const ctx = await initializedContext()
  // FTS5 的影子表（`ciki_pages_fts_*`）随虚拟表一起消失，单独 DROP 会报
  // 「no such table」；列表里剔掉它们，只删虚拟表本身。
  for (const name of (
    ctx.db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name)) {
    const mine = name.startsWith(PREFIX) || name === migrationsTable(PREFIX)
    if (!mine) continue
    if (/^ciki_pages_fts_/.test(name)) continue
    await ctx.db.exec(`DROP TABLE ${name}`)
  }
  await createV8Database(ctx, ["schema_v1", "schema_v2"])
  await ctx.db.exec(`CREATE TABLE ${table("write_tokens")} (
  user_id      INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
)`)
  await ctx.db.exec(
    `CREATE UNIQUE INDEX ${table("write_tokens_token_hash")}
       ON ${table("write_tokens")}(token_hash)`
  )
  await ctx.db.exec(`CREATE TABLE ${table("token_space_scopes")} (
  token_kind TEXT NOT NULL CHECK (token_kind IN ('read', 'write')),
  user_id    INTEGER NOT NULL,
  space_id   INTEGER NOT NULL,
  PRIMARY KEY (token_kind, user_id, space_id)
)`)

  await seedV8Database(ctx)

  // 种子里的单行占位令牌换成矩阵要的「每类两行、可回放明文」。
  await ctx.db.db.prepare(`DELETE FROM ${table("read_tokens")}`).run()
  await ctx.db.db.prepare(`DELETE FROM ${table("import_tokens")}`).run()

  const insertRead = ctx.db.db.prepare(
    `INSERT INTO ${table("read_tokens")}
      (user_id, token_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)`
  )
  insertRead.run(1, await sha256Hex(LEGACY.read.u1), LEGACY_NOW, LEGACY_USED)
  insertRead.run(2, await sha256Hex(LEGACY.read.u2), LEGACY_NOW, null)

  const insertWrite = ctx.db.db.prepare(
    `INSERT INTO ${table("write_tokens")}
      (user_id, token_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  insertWrite.run(
    1,
    await sha256Hex(LEGACY.write.u1),
    LEGACY_NOW,
    LEGACY_USED,
    null
  )
  insertWrite.run(
    2,
    await sha256Hex(LEGACY.write.u2Revoked),
    LEGACY_NOW,
    LEGACY_USED,
    LEGACY_USED
  )

  const insertImport = ctx.db.db.prepare(
    `INSERT INTO ${table("import_tokens")}
      (user_id, token_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, NULL, NULL)`
  )
  insertImport.run(1, await sha256Hex(LEGACY.imports.u1), LEGACY_NOW)
  insertImport.run(2, await sha256Hex(LEGACY.imports.u2), LEGACY_NOW)

  // 用户 2 是空间 1 的 editor（种子已加）；范围按 (kind, user_id) 存。
  await ctx.db.db
    .prepare(
      `INSERT INTO ${table("token_space_scopes")} (token_kind, user_id, space_id)
       VALUES ('read', 1, 1), ('read', 2, 1), ('write', 1, 2), ('write', 2, 1)`
    )
    .run()

  return ctx
}

async function setup(ctx: TestContext) {
  const result = await runSetup(ctx.env)
  if (!result.success) throw new Error(result.error)
  return result
}

function ledgerNames(ctx: TestContext): string[] {
  return (
    ctx.db.db
      .prepare(`SELECT name FROM ${migrationsTable(PREFIX)} ORDER BY name`)
      .all() as Array<{ name: string }>
  ).map((row) => row.name)
}

function columnsOf(ctx: TestContext, name: string) {
  return (
    ctx.db.db.prepare(`PRAGMA table_info(${name})`).all() as Array<{
      name: string
      pk: number
    }>
  ).map(({ name: column, pk }) => ({ name: column, pk }))
}

function tableNames(ctx: TestContext): string[] {
  return (
    ctx.db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name)
}

function indexNames(ctx: TestContext): string[] {
  return (
    ctx.db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name)
}

describe("E 验证·迁移", () => {
  it("新装形态：一次 setup 即最终三表、账本 v1+v2+v3，旧单行令牌表不存在", async () => {
    const ctx = await initializedContext()
    const result = await setup(ctx)

    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v2", status: "skipped" },
      { name: "schema_v3", status: "skipped" }
    ])

    const tables = tableNames(ctx)
    expect(tables).toContain(table("api_tokens"))
    expect(tables).toContain(table("import_tokens"))
    expect(tables).toContain(table("token_space_scopes"))
    expect(tables).not.toContain(table("read_tokens"))
    expect(tables).not.toContain(table("write_tokens"))
    expect(ledgerNames(ctx)).toEqual(["schema_v1", "schema_v2", "schema_v3"])

    expect(columnsOf(ctx, table("api_tokens"))).toEqual([
      { name: "id", pk: 1 },
      { name: "user_id", pk: 0 },
      { name: "kind", pk: 0 },
      { name: "name", pk: 0 },
      { name: "token_hash", pk: 0 },
      { name: "created_at", pk: 0 },
      { name: "last_used_at", pk: 0 },
      { name: "revoked_at", pk: 0 }
    ])
    expect(columnsOf(ctx, table("token_space_scopes"))).toEqual([
      { name: "token_id", pk: 1 },
      { name: "space_id", pk: 2 }
    ])
    expect(columnsOf(ctx, table("import_tokens"))).toEqual([
      { name: "id", pk: 1 },
      { name: "user_id", pk: 0 },
      { name: "name", pk: 0 },
      { name: "token_hash", pk: 0 },
      { name: "created_at", pk: 0 },
      { name: "last_used_at", pk: 0 },
      { name: "revoked_at", pk: 0 }
    ])

    const indexes = indexNames(ctx)
    expect(indexes).toContain(table("api_tokens_token_hash"))
    expect(indexes).toContain(table("import_tokens_token_hash"))

    // 空库 smoke：新装后管理接口与数据面都能直接用（kind 约束由 DDL 兜底）。
    const admin = await adminSession(ctx.env)
    const created = await createApiToken(ctx.env, admin, "read")
    expect(await readSpaceIds(ctx.env, created.token)).toEqual([
      await defaultSpaceId(ctx.env, admin)
    ])
    const insertBogus = ctx.db.db.prepare(
      `INSERT INTO ${table("api_tokens")}
        (user_id, kind, name, token_hash, created_at)
       VALUES (1, 'bogus', 'x', 'hash-bogus', ?)`
    )
    expect(() => insertBogus.run(LEGACY_NOW)).toThrow()
  })

  it("v2 存量升级：按 kind 令牌数 / scope 行数 / 导入数前后一致，字段原样搬运", async () => {
    const ctx = await v2Context()

    const before = {
      read: countRows(ctx, `SELECT COUNT(*) AS n FROM ${table("read_tokens")}`),
      write: countRows(
        ctx,
        `SELECT COUNT(*) AS n FROM ${table("write_tokens")}`
      ),
      scopes: countRows(
        ctx,
        `SELECT COUNT(*) AS n FROM ${table("token_space_scopes")}`
      ),
      imports: countRows(
        ctx,
        `SELECT COUNT(*) AS n FROM ${table("import_tokens")}`
      )
    }
    expect(before).toEqual({ read: 2, write: 2, scopes: 4, imports: 2 })

    const result = await setup(ctx)
    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v2", status: "skipped" },
      { name: "schema_v3", status: "applied" }
    ])

    const apiRows = rowsOf(ctx.db, table("api_tokens")) as Array<
      Record<string, unknown>
    >
    expect(apiRows).toHaveLength(before.read + before.write)
    expect(apiRows.filter((row) => row.kind === "read")).toHaveLength(
      before.read
    )
    expect(apiRows.filter((row) => row.kind === "write")).toHaveLength(
      before.write
    )
    expect(apiRows.filter((row) => row.revoked_at !== null)).toHaveLength(1)
    expect(
      countRows(ctx, `SELECT COUNT(*) AS n FROM ${table("token_space_scopes")}`)
    ).toBe(before.scopes)
    expect(rowsOf(ctx.db, table("import_tokens"))).toHaveLength(before.imports)

    const byHash = new Map(apiRows.map((row) => [row.token_hash, row]))
    const u1Read = byHash.get(await sha256Hex(LEGACY.read.u1))
    expect(u1Read).toMatchObject({
      user_id: 1,
      kind: "read",
      name: "只读 Token",
      created_at: LEGACY_NOW,
      last_used_at: LEGACY_USED,
      revoked_at: null
    })
    const u2Read = byHash.get(await sha256Hex(LEGACY.read.u2))
    expect(u2Read).toMatchObject({
      user_id: 2,
      kind: "read",
      last_used_at: null
    })
    const u1Write = byHash.get(await sha256Hex(LEGACY.write.u1))
    expect(u1Write).toMatchObject({
      user_id: 1,
      kind: "write",
      name: "读写 Token",
      revoked_at: null
    })
    const u2Write = byHash.get(await sha256Hex(LEGACY.write.u2Revoked))
    expect(u2Write).toMatchObject({
      user_id: 2,
      kind: "write",
      revoked_at: LEGACY_USED
    })

    // 范围按 (user_id, kind) 映射到迁移后的令牌行，逐行对得上。
    const scopeRows = rowsOf(ctx.db, table("token_space_scopes")) as Array<{
      token_id: number
      space_id: number
    }>
    expect(scopeRows).toHaveLength(4)
    const scopesOf = (tokenId: unknown) =>
      scopeRows
        .filter((row) => row.token_id === tokenId)
        .map((row) => row.space_id)
        .sort((a, b) => a - b)
    expect(scopesOf(u1Read?.id)).toEqual([1])
    expect(scopesOf(u2Read?.id)).toEqual([1])
    expect(scopesOf(u1Write?.id)).toEqual([2])
    expect(scopesOf(u2Write?.id)).toEqual([1])

    // 导入令牌搬成多行并自动命名「浏览器插件」，hash 原样。
    const importRows = rowsOf(ctx.db, table("import_tokens")) as Array<
      Record<string, unknown>
    >
    expect(importRows.map((row) => row.name)).toEqual([
      "浏览器插件",
      "浏览器插件"
    ])
    expect(new Set(importRows.map((row) => row.token_hash))).toEqual(
      new Set([
        await sha256Hex(LEGACY.imports.u1),
        await sha256Hex(LEGACY.imports.u2)
      ])
    )

    expect(tableNames(ctx)).not.toContain(table("read_tokens"))
    expect(tableNames(ctx)).not.toContain(table("write_tokens"))
  })

  it("存量只读/读写/导入明文令牌升级后仍可鉴权，已吊销与表隔离不变", async () => {
    const ctx = await v2Context()
    await setup(ctx)
    const { env } = ctx

    // 只读令牌（用户 1，范围空间 1）：读接口放行，写接口 401。
    expectStatus(
      await readSpaces(env, LEGACY.read.u1),
      200,
      "存量只读令牌 GET /api/read/spaces"
    )
    expect(await readSpaceIds(env, LEGACY.read.u1)).toEqual([1])
    expectStatus(
      await bearer(env, LEGACY.read.u1, "POST", "/api/write/pages", {
        title: "存量只读越界",
        content_json: docJson("越界")
      }),
      401,
      "存量只读令牌调写接口"
    )

    // 读写令牌（用户 1，范围空间 2）：写接口可建页，读接口也可调。
    expectStatus(
      await bearer(env, LEGACY.write.u1, "POST", "/api/write/pages", {
        space_id: 2,
        title: "存量读写建页",
        content_json: docJson("存量读写建页")
      }),
      201,
      "存量读写令牌建页"
    )
    expect(await readSpaceIds(env, LEGACY.write.u1)).toEqual([2])

    // 导入明文：导入接口 200，读接口 401；只读令牌也进不了导入接口。
    expectStatus(
      await bearer(env, LEGACY.imports.u1, "GET", "/api/import/spaces"),
      200,
      "存量导入令牌 GET /api/import/spaces"
    )
    expectStatus(
      await bearer(env, LEGACY.imports.u2, "GET", "/api/import/spaces"),
      200,
      "第二枚存量导入令牌"
    )
    expectStatus(
      await bearer(env, LEGACY.imports.u1, "GET", "/api/read/spaces"),
      401,
      "存量导入令牌调读接口"
    )
    expectStatus(
      await bearer(env, LEGACY.read.u1, "GET", "/api/import/spaces"),
      401,
      "存量只读令牌调导入接口"
    )

    // 已吊销的读写令牌：读、写都 401（吊销状态原样保留）。
    expectStatus(
      await bearer(env, LEGACY.write.u2Revoked, "GET", "/api/read/spaces"),
      401,
      "已吊销存量读写令牌调读接口"
    )
    expectStatus(
      await bearer(env, LEGACY.write.u2Revoked, "POST", "/api/write/pages", {
        title: "吊销后",
        content_json: docJson("吊销后")
      }),
      401,
      "已吊销存量读写令牌调写接口"
    )
  })

  it("迁移幂等：重复 setup 全部 skipped，三张令牌表逐行不变", async () => {
    const ctx = await v2Context()
    await setup(ctx)
    const before = {
      api: rowsOf(ctx.db, table("api_tokens")),
      scopes: rowsOf(ctx.db, table("token_space_scopes")),
      imports: rowsOf(ctx.db, table("import_tokens")),
      ledger: ledgerNames(ctx)
    }

    const again = await setup(ctx)
    expect(again.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
      { name: "schema_v2", status: "skipped" },
      { name: "schema_v3", status: "skipped" }
    ])
    expect(ledgerNames(ctx)).toEqual(before.ledger)
    expect(rowsOf(ctx.db, table("api_tokens"))).toEqual(before.api)
    expect(rowsOf(ctx.db, table("token_space_scopes"))).toEqual(before.scopes)
    expect(rowsOf(ctx.db, table("import_tokens"))).toEqual(before.imports)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// §7 第 2 条：多令牌
// ════════════════════════════════════════════════════════════════════════════

describe("E 验证·多令牌", () => {
  it("建 2 只读 + 1 读写，吊销其一枚只读 → 其余两支不受影响", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const readOne = await createApiToken(env, admin, "read")
    const readTwo = await createApiToken(env, admin, "read")
    const write = await createApiToken(env, admin, "write")

    for (const token of [readOne, readTwo, write]) {
      expectStatus(
        await readSpaces(env, token.token),
        200,
        `建好后 ${token.kind} 令牌可读`
      )
    }

    expectStatus(
      await jsonRequest(
        env,
        "DELETE",
        `/api/me/tokens/${readOne.id}`,
        undefined,
        admin
      ),
      200,
      "吊销第一枚只读"
    )

    expectStatus(
      await readSpaces(env, readOne.token),
      401,
      "已吊销只读令牌调读接口"
    )
    for (const survivor of [readTwo, write]) {
      expectStatus(
        await readSpaces(env, survivor.token),
        200,
        `幸存令牌 ${survivor.kind} 仍可读`
      )
    }
    expectStatus(
      await bearer(env, write.token, "POST", "/api/write/pages", {
        title: "吊销旁证",
        content_json: docJson("吊销旁证")
      }),
      201,
      "读写令牌建页"
    )

    const list = (await (
      await jsonRequest(env, "GET", "/api/me/tokens", undefined, admin)
    ).json()) as { tokens: Array<{ id: number }> }
    expect(list.tokens.map((row) => row.id)).toEqual([readTwo.id, write.id])
  })

  it("三支令牌的范围互不干扰：改一支不影响另两支", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const defaultId = await defaultSpaceId(env, admin)
    const spaceA = await createSpace(env, admin, "范围甲")
    const spaceB = await createSpace(env, admin, "范围乙")

    const readA = await createApiToken(env, admin, "read", {
      spaceIds: [defaultId]
    })
    const readB = await createApiToken(env, admin, "read", {
      spaceIds: [spaceA.id]
    })
    const write = await createApiToken(env, admin, "write", {
      spaceIds: [defaultId, spaceA.id]
    })

    expect(await readSpaceIds(env, readA.token)).toEqual([defaultId])
    expect(await readSpaceIds(env, readB.token)).toEqual([spaceA.id])
    expect(await readSpaceIds(env, write.token)).toEqual([defaultId, spaceA.id])

    // 改 A 的范围：B 与读写令牌的范围行原样不动。
    expectStatus(
      await jsonRequest(
        env,
        "PUT",
        `/api/me/tokens/${readA.id}/spaces`,
        { spaceIds: [spaceB.id] },
        admin
      ),
      200,
      "改第一枚只读的范围"
    )
    expect(await readSpaceIds(env, readA.token)).toEqual([spaceB.id])
    expect(await readSpaceIds(env, readB.token)).toEqual([spaceA.id])
    expect(await readSpaceIds(env, write.token)).toEqual([defaultId, spaceA.id])

    const scopeRows = db.db
      .prepare(
        `SELECT token_id, space_id FROM ${table("token_space_scopes")}
          ORDER BY token_id, space_id`
      )
      .all() as Array<{ token_id: number; space_id: number }>
    const scopesOf = (tokenId: number) =>
      scopeRows
        .filter((row) => row.token_id === tokenId)
        .map((row) => row.space_id)
    expect(scopesOf(readA.id)).toEqual([spaceB.id])
    expect(scopesOf(readB.id)).toEqual([spaceA.id])
    expect(scopesOf(write.id)).toEqual(
      [defaultId, spaceA.id].sort((a, b) => a - b)
    )
  })

  it("改名生效：列表与库里的名称都变，kind 与明文鉴权不变", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const token = await createApiToken(env, admin, "read", { name: "原名" })

    expectStatus(
      await jsonRequest(
        env,
        "PUT",
        `/api/me/tokens/${token.id}/name`,
        { name: "  新名字  " },
        admin
      ),
      200,
      "改名"
    )

    const list = (await (
      await jsonRequest(env, "GET", "/api/me/tokens", undefined, admin)
    ).json()) as {
      tokens: Array<{ id: number; name: string; kind: string }>
    }
    const row = list.tokens.find((entry) => entry.id === token.id)
    expect(row).toMatchObject({ name: "新名字", kind: "read" })
    const dbRow = db.db
      .prepare(`SELECT name, kind FROM ${table("api_tokens")} WHERE id = ?`)
      .get(token.id) as { name: string; kind: string }
    expect(dbRow).toEqual({ name: "新名字", kind: "read" })
    // 改名不换明文：原明文仍能鉴权。
    expectStatus(await readSpaces(env, token.token), 200, "改名后原明文")
  })

  it("名称留空自动名：缺键 / 空串 / 纯空白都落默认名（三类令牌）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const noKey = await jsonRequest(
      env,
      "POST",
      "/api/me/tokens",
      { kind: "read" },
      admin
    )
    expectStatus(noKey, 201, "缺 name 键建只读")
    expect(((await noKey.json()) as { name: string }).name).toBe("只读 Token")

    const empty = await jsonRequest(
      env,
      "POST",
      "/api/me/tokens",
      { kind: "write", name: "" },
      admin
    )
    expectStatus(empty, 201, "空串 name 建读写")
    expect(((await empty.json()) as { name: string }).name).toBe("读写 Token")

    const blank = await jsonRequest(
      env,
      "POST",
      "/api/me/tokens",
      { kind: "read", name: "   " },
      admin
    )
    expectStatus(blank, 201, "纯空白 name 建只读")
    expect(((await blank.json()) as { name: string }).name).toBe("只读 Token")

    const plugin = await jsonRequest(
      env,
      "POST",
      "/api/me/import-tokens",
      {},
      admin
    )
    expectStatus(plugin, 201, "缺 name 建插件凭证")
    expect(((await plugin.json()) as { name: string }).name).toBe("浏览器插件")

    const list = (await (
      await jsonRequest(env, "GET", "/api/me/tokens", undefined, admin)
    ).json()) as { tokens: Array<{ name: string }> }
    expect(list.tokens.map((row) => row.name).sort()).toEqual([
      "只读 Token",
      "只读 Token",
      "读写 Token"
    ])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// §7 第 3 条：管理校验
// ════════════════════════════════════════════════════════════════════════════

describe("E 验证·管理校验", () => {
  it("范围空数组 400，创建与改范围都零写入", async () => {
    const ctx = await initializedContext()
    const { env } = ctx
    const admin = await adminSession(env)
    const defaultId = await defaultSpaceId(env, admin)

    const tokenCountBefore = countRows(
      ctx,
      `SELECT COUNT(*) AS n FROM ${table("api_tokens")}`
    )
    const created = await jsonRequest(
      env,
      "POST",
      "/api/me/tokens",
      { kind: "read", spaceIds: [] },
      admin
    )
    expectStatus(created, 400, "空数组建令牌")
    expect(await created.json()).toMatchObject({ code: "INVALID_SPACE_SCOPE" })
    expect(
      countRows(ctx, `SELECT COUNT(*) AS n FROM ${table("api_tokens")}`)
    ).toBe(tokenCountBefore)
    expect(
      countRows(ctx, `SELECT COUNT(*) AS n FROM ${table("token_space_scopes")}`)
    ).toBe(0)

    // 改范围同样不接受空数组，且旧范围原样。
    const token = await createApiToken(env, admin, "read", {
      spaceIds: [defaultId]
    })
    const updated = await jsonRequest(
      env,
      "PUT",
      `/api/me/tokens/${token.id}/spaces`,
      { spaceIds: [] },
      admin
    )
    expectStatus(updated, 400, "空数组改范围")
    expect(await updated.json()).toMatchObject({ code: "INVALID_SPACE_SCOPE" })
    expect(await readSpaceIds(env, token.token)).toEqual([defaultId])
    // 缺键同样是 400（改范围必填）。
    expectStatus(
      await jsonRequest(
        env,
        "PUT",
        `/api/me/tokens/${token.id}/spaces`,
        {},
        admin
      ),
      400,
      "改范围缺键"
    )
    expect(await readSpaceIds(env, token.token)).toEqual([defaultId])
  })

  it("不可见空间 400 且零写入（普通用户不是成员的空间）", async () => {
    const ctx = await initializedContext()
    const { env } = ctx
    const admin = await adminSession(env)
    const defaultId = await defaultSpaceId(env, admin)
    const hidden = await createSpace(env, admin, "别人家的空间")
    const user = await userSession(env, admin, "hmqx@example.com")
    const userId = await meId(env, user)
    await addMember(env, admin, defaultId, userId, "editor")

    const beforeTokens = countRows(
      ctx,
      `SELECT COUNT(*) AS n FROM ${table("api_tokens")} WHERE user_id = ?`,
      userId
    )
    const beforeScopes = countRows(
      ctx,
      `SELECT COUNT(*) AS n FROM ${table("token_space_scopes")}`
    )

    const created = await jsonRequest(
      env,
      "POST",
      "/api/me/tokens",
      { kind: "read", spaceIds: [hidden.id] },
      user
    )
    expectStatus(created, 400, "不可见空间建令牌")
    expect(await created.json()).toMatchObject({ code: "INVALID_SPACE_SCOPE" })
    expect(
      countRows(
        ctx,
        `SELECT COUNT(*) AS n FROM ${table("api_tokens")} WHERE user_id = ?`,
        userId
      )
    ).toBe(beforeTokens)
    expect(
      countRows(ctx, `SELECT COUNT(*) AS n FROM ${table("token_space_scopes")}`)
    ).toBe(beforeScopes)

    // 已有令牌改到不可见空间：400，旧范围不动。
    const token = await createApiToken(env, user, "read", {
      spaceIds: [defaultId]
    })
    const updated = await jsonRequest(
      env,
      "PUT",
      `/api/me/tokens/${token.id}/spaces`,
      { spaceIds: [defaultId, hidden.id] },
      user
    )
    expectStatus(updated, 400, "改到不可见空间")
    expect(await readSpaceIds(env, token.token)).toEqual([defaultId])
  })

  it("他人令牌 id 操作一律 404，且目标行不被改动", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const defaultId = await defaultSpaceId(env, admin)
    const owner = await userSession(env, admin, "owner@example.com")
    const other = await userSession(env, admin, "other@example.com")
    const ownerId = await meId(env, owner)
    const otherId = await meId(env, other)
    await addMember(env, admin, defaultId, ownerId, "editor")
    await addMember(env, admin, defaultId, otherId, "editor")

    const token = await createApiToken(env, owner, "read", {
      name: "主人的令牌",
      spaceIds: [defaultId]
    })

    expectStatus(
      await jsonRequest(
        env,
        "PUT",
        `/api/me/tokens/${token.id}/name`,
        { name: "偷改" },
        other
      ),
      404,
      "他人改名"
    )
    expectStatus(
      await jsonRequest(
        env,
        "PUT",
        `/api/me/tokens/${token.id}/spaces`,
        { spaceIds: null },
        other
      ),
      404,
      "他人改范围"
    )
    expectStatus(
      await jsonRequest(
        env,
        "DELETE",
        `/api/me/tokens/${token.id}`,
        undefined,
        other
      ),
      404,
      "他人吊销"
    )
    // 不存在的 id 与畸形 id 同为 404（不泄露存在性）。
    expectStatus(
      await jsonRequest(
        env,
        "PUT",
        "/api/me/tokens/999999/name",
        { name: "x" },
        other
      ),
      404,
      "不存在的 id 改名"
    )
    expectStatus(
      await jsonRequest(env, "DELETE", "/api/me/tokens/abc", undefined, owner),
      404,
      "畸形 id 吊销"
    )

    const row = db.db
      .prepare(
        `SELECT name, revoked_at FROM ${table("api_tokens")} WHERE id = ?`
      )
      .get(token.id) as { name: string; revoked_at: string | null }
    expect(row).toEqual({ name: "主人的令牌", revoked_at: null })
    expect(await readSpaceIds(env, token.token)).toEqual([defaultId])
  })

  it("名称超限 400（按码点，创建与改名都拦）", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const forty = "码".repeat(40)
    const fortyOne = "码".repeat(41)

    const ok = await jsonRequest(
      env,
      "POST",
      "/api/me/tokens",
      { kind: "read", name: ` ${forty} ` },
      admin
    )
    expectStatus(ok, 201, "40 码点名称")
    expect(((await ok.json()) as { name: string }).name).toBe(forty)

    const tooLong = await jsonRequest(
      env,
      "POST",
      "/api/me/tokens",
      { kind: "read", name: fortyOne },
      admin
    )
    expectStatus(tooLong, 400, "41 码点名称")
    expect(await tooLong.json()).toEqual({ error: "Invalid token name" })

    const emojiOk = await jsonRequest(
      env,
      "POST",
      "/api/me/tokens",
      { kind: "write", name: "🙂".repeat(40) },
      admin
    )
    expectStatus(emojiOk, 201, "40 个 emoji（按码点）")

    const token = await createApiToken(env, admin, "read", { name: "可改名" })
    expectStatus(
      await jsonRequest(
        env,
        "PUT",
        `/api/me/tokens/${token.id}/name`,
        { name: fortyOne },
        admin
      ),
      400,
      "改名超 40 码点"
    )
    // 改名不是「恢复默认名」：空白同样 400。
    expectStatus(
      await jsonRequest(
        env,
        "PUT",
        `/api/me/tokens/${token.id}/name`,
        { name: "  " },
        admin
      ),
      400,
      "改名空白"
    )
    expectStatus(
      await jsonRequest(
        env,
        "PUT",
        `/api/me/tokens/${token.id}/name`,
        { name: 42 },
        admin
      ),
      400,
      "改名非字符串"
    )
    const row = db.db
      .prepare(`SELECT name FROM ${table("api_tokens")} WHERE id = ?`)
      .get(token.id) as { name: string }
    expect(row.name).toBe("可改名")
  })

  it("类型创建后无变更入口：改 kind 的请求全部 404/400，库内 kind 不变", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const token = await createApiToken(env, admin, "read")

    // 契约里没有改 kind 的端点：任何方法打 /tokens/:id 都不存在。
    for (const method of ["PUT", "POST", "PATCH"]) {
      expectStatus(
        await jsonRequest(
          env,
          method,
          `/api/me/tokens/${token.id}`,
          { kind: "write" },
          admin
        ),
        404,
        `${method} /api/me/tokens/:id`
      )
    }
    expectStatus(
      await jsonRequest(
        env,
        "PUT",
        `/api/me/tokens/${token.id}/kind`,
        { kind: "write" },
        admin
      ),
      404,
      "PUT /tokens/:id/kind"
    )

    // 改名 / 改范围即使夹带 kind 也不生效。
    expectStatus(
      await jsonRequest(
        env,
        "PUT",
        `/api/me/tokens/${token.id}/name`,
        { name: "还是只读", kind: "write" },
        admin
      ),
      200,
      "改名夹带 kind"
    )
    expectStatus(
      await jsonRequest(
        env,
        "PUT",
        `/api/me/tokens/${token.id}/spaces`,
        { spaceIds: null, kind: "write" },
        admin
      ),
      200,
      "改范围夹带 kind"
    )
    const row = db.db
      .prepare(`SELECT kind, name FROM ${table("api_tokens")} WHERE id = ?`)
      .get(token.id) as { kind: string; name: string }
    expect(row).toEqual({ kind: "read", name: "还是只读" })

    // 建令牌时非法 kind 直接 400。
    expectStatus(
      await jsonRequest(
        env,
        "POST",
        "/api/me/tokens",
        { kind: "admin" },
        admin
      ),
      400,
      "非法 kind 建令牌"
    )
    expectStatus(
      await jsonRequest(env, "POST", "/api/me/tokens", {}, admin),
      400,
      "缺 kind 建令牌"
    )
  })
})

// ════════════════════════════════════════════════════════════════════════════
// §7 第 4 条：隔离与数据面回归（二期 §7 数据面条目 + 三期 §4 隔离矩阵）
// ════════════════════════════════════════════════════════════════════════════

describe("E 验证·数据面回归", () => {
  it("spaces 形状与顺序：精确三键；默认在前，再按名称大小写不敏感、创建时间", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const defaultId = await defaultSpaceId(env, admin)
    const zeta = await createSpace(env, admin, "Zeta")
    const beta = await createSpace(env, admin, "beta")
    const upperAlpha = await createSpace(env, admin, "Alpha")
    const lowerAlpha = await createSpace(env, admin, "alpha")
    // 同名不同大小写（COLLATE NOCASE 视为并列）靠 created_at 决序：写死三个时间，
    // 断言不依赖 create 调用的毫秒差，避免慢机/快机上的偶发倒序。
    const stamp = db.db.prepare(
      `UPDATE ${table("spaces")} SET created_at = ? WHERE id = ?`
    )
    stamp.run("2026-01-01T00:00:00.000Z", upperAlpha.id)
    stamp.run("2026-01-02T00:00:00.000Z", lowerAlpha.id)
    stamp.run("2026-01-03T00:00:00.000Z", beta.id)
    stamp.run("2026-01-04T00:00:00.000Z", zeta.id)

    const token = await createApiToken(env, admin, "read")
    const res = await readSpaces(env, token.token)
    expectStatus(res, 200, "GET /api/read/spaces")
    const body = (await res.json()) as {
      spaces: Array<Record<string, unknown>>
    }
    expect(Object.keys(body)).toEqual(["spaces"])
    for (const row of body.spaces) {
      expect(Object.keys(row).sort()).toEqual(["id", "name", "slug"])
    }
    const names = body.spaces.map((row) => row.name as string)
    expect(names[0]).toBe("默认空间")
    // 名称大小写不敏感：Alpha / alpha 同名组内按创建时间（Alpha 先建）。
    expect(names.slice(1)).toEqual(["Alpha", "alpha", "beta", "Zeta"])
    expect(body.spaces[0].id).toBe(defaultId)
    // 与站内空间列表同一份顺序。
    expect((await listSpaces(env, admin)).map((row) => row.name)).toEqual(names)
  })

  it("范围收窄在 tree/search/pages/spaces 四处一致，清空范围后四处一起放开", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const defaultId = await defaultSpaceId(env, admin)
    const spaceA = await createSpace(env, admin, "范围一半")
    const spaceB = await createSpace(env, admin, "范围二半")
    const pageA = await sessionPage(env, admin, {
      title: "斑马甲",
      spaceId: spaceA.id,
      text: "共振斑马 甲"
    })
    const pageB = await sessionPage(env, admin, {
      title: "斑马乙",
      spaceId: spaceB.id,
      text: "共振斑马 乙"
    })

    const token = await createApiToken(env, admin, "read", {
      spaceIds: [spaceB.id]
    })
    expect(await readSpaceIds(env, token.token)).toEqual([spaceB.id])
    expect((await readTree(env, token.token)).map((row) => row.id)).toEqual([
      pageB.id
    ])
    expect(await readSearchIds(env, token.token, "共振斑马")).toEqual([
      pageB.id
    ])
    expectStatus(
      await bearer(env, token.token, "GET", `/api/read/pages/${pageA.id}`),
      404,
      "范围外页面直链"
    )
    expectStatus(
      await bearer(env, token.token, "GET", `/api/read/pages/${pageB.id}`),
      200,
      "范围内页面直链"
    )

    // 清空范围（null = 不限制）：四处同时放开，不需要换明文。
    expectStatus(
      await jsonRequest(
        env,
        "PUT",
        `/api/me/tokens/${token.id}/spaces`,
        { spaceIds: null },
        admin
      ),
      200,
      "清空范围"
    )
    expect(await readSpaceIds(env, token.token)).toEqual([
      defaultId,
      spaceA.id,
      spaceB.id
    ])
    const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b)
    expect(
      sorted((await readTree(env, token.token)).map((row) => row.id))
    ).toEqual(sorted([pageA.id, pageB.id]))
    expect(sorted(await readSearchIds(env, token.token, "共振斑马"))).toEqual(
      sorted([pageA.id, pageB.id])
    )
    expectStatus(
      await bearer(env, token.token, "GET", `/api/read/pages/${pageA.id}`),
      200,
      "放开后范围外页面"
    )
  })

  it("写四端点：建页 / 改页 / 移动 / 删页（六键元信息、revision、作者、派生列）", async () => {
    const ctx = await initializedContext()
    const { env } = ctx
    const admin = await adminSession(env)
    const writerId = await meId(env, admin)
    const { token } = await createApiToken(env, admin, "write")
    const base = await sessionPage(env, admin, {
      title: "母页",
      text: "母页正文"
    })

    // 1) 建页
    const created = await bearer(env, token, "POST", "/api/write/pages", {
      title: "写接口页",
      parent_id: base.id,
      content_json: docJson("第一版正文")
    })
    expectStatus(created, 201, "POST /api/write/pages")
    const meta = (await created.json()) as PageMeta
    expect(Object.keys(meta).sort()).toEqual([
      "id",
      "parent_id",
      "sort_order",
      "space_id",
      "title",
      "updated_at"
    ])
    expect(meta).toMatchObject({
      title: "写接口页",
      space_id: base.space_id,
      parent_id: base.id
    })
    const rowAfterCreate = ctx.db.db
      .prepare(
        `SELECT created_by, updated_by, content_html, content_text, content_md
           FROM ${table("pages")} WHERE id = ?`
      )
      .get(meta.id) as {
      created_by: number
      updated_by: number
      content_html: string
      content_text: string
      content_md: string
    }
    expect(rowAfterCreate.created_by).toBe(writerId)
    expect(rowAfterCreate.updated_by).toBe(writerId)
    expect(rowAfterCreate.content_html).toContain("第一版正文")
    expect(rowAfterCreate.content_text).toContain("第一版正文")
    expect(rowAfterCreate.content_md).toContain("第一版正文")

    const revisionsOf = async (pageId: number) =>
      (await (
        await jsonRequest(
          env,
          "GET",
          `/api/pages/${pageId}/revisions`,
          undefined,
          admin
        )
      ).json()) as Array<{ versionNo: number }>
    const versionNos = async (pageId: number) =>
      (await revisionsOf(pageId))
        .map((row) => row.versionNo)
        .sort((a, b) => a - b)
    expect(await versionNos(meta.id)).toEqual([1])

    // 2) 改页（正文）：追加 revision；只改标题不产版本。
    expectStatus(
      await bearer(env, token, "PUT", `/api/write/pages/${meta.id}`, {
        content_json: docJson("第二版正文")
      }),
      200,
      "PUT /api/write/pages/:id"
    )
    expect(await versionNos(meta.id)).toEqual([1, 2])
    expectStatus(
      await bearer(env, token, "PUT", `/api/write/pages/${meta.id}`, {
        title: "改过名的页"
      }),
      200,
      "只改标题"
    )
    expect(await versionNos(meta.id)).toEqual([1, 2])

    // 3) 移动（换父）
    expectStatus(
      await bearer(env, token, "POST", `/api/write/pages/${meta.id}/move`, {
        parent_id: null,
        index: 0
      }),
      200,
      "POST /api/write/pages/:id/move"
    )
    const moved = ctx.db.db
      .prepare(`SELECT parent_id FROM ${table("pages")} WHERE id = ?`)
      .get(meta.id) as { parent_id: number | null }
    expect(moved.parent_id).toBeNull()

    // 4) 删页（软删，进回收站）
    expectStatus(
      await bearer(env, token, "DELETE", `/api/write/pages/${meta.id}`),
      200,
      "DELETE /api/write/pages/:id"
    )
    const deleted = ctx.db.db
      .prepare(`SELECT deleted_at FROM ${table("pages")} WHERE id = ?`)
      .get(meta.id) as { deleted_at: string | null }
    expect(deleted.deleted_at).not.toBeNull()
  })

  it("移动稠密重排：同级 sort_order 恒为 0..n-1，tree 顺序与库内排序一致", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const { token } = await createApiToken(env, admin, "write")

    const ids: number[] = []
    for (const title of ["甲页", "乙页", "丙页"]) {
      const res = await bearer(env, token, "POST", "/api/write/pages", {
        title,
        content_json: docJson(title)
      })
      expectStatus(res, 201, `建页 ${title}`)
      ids.push(((await res.json()) as PageMeta).id)
    }

    const roots = () =>
      (
        db.db
          .prepare(
            `SELECT id FROM ${table("pages")}
              WHERE deleted_at IS NULL AND parent_id IS NULL
              ORDER BY sort_order, created_at`
          )
          .all() as Array<{ id: number }>
      ).map((row) => row.id)
    const rootSort = () =>
      (
        db.db
          .prepare(
            `SELECT sort_order FROM ${table("pages")}
              WHERE deleted_at IS NULL AND parent_id IS NULL
              ORDER BY sort_order`
          )
          .all() as Array<{ sort_order: number }>
      ).map((row) => row.sort_order)

    expect(await roots()).toEqual(ids)
    expect(rootSort()).toEqual([0, 1, 2])
    expectStatus(
      await bearer(env, token, "POST", `/api/write/pages/${ids[2]}/move`, {
        parent_id: null,
        index: 0
      }),
      200,
      "把丙移到最前"
    )
    expect(await roots()).toEqual([ids[2], ids[0], ids[1]])
    expect(rootSort()).toEqual([0, 1, 2])

    // 移到子级：父页下三个子页的 sort_order 各自稠密。
    const parent = ids[0]
    const childIds: number[] = []
    for (const title of ["子一", "子二"]) {
      const res = await bearer(env, token, "POST", "/api/write/pages", {
        title,
        parent_id: parent,
        content_json: docJson(title)
      })
      expectStatus(res, 201, `建子页 ${title}`)
      childIds.push(((await res.json()) as PageMeta).id)
    }
    expectStatus(
      await bearer(env, token, "POST", `/api/write/pages/${ids[1]}/move`, {
        parent_id: parent,
        index: 0
      }),
      200,
      "把乙移进子级首位"
    )
    const childRows = db.db
      .prepare(
        `SELECT id, sort_order FROM ${table("pages")}
          WHERE parent_id = ? AND deleted_at IS NULL
          ORDER BY sort_order`
      )
      .all(parent) as Array<{ id: number; sort_order: number }>
    expect(childRows.map((row) => row.sort_order)).toEqual([0, 1, 2])
    expect(childRows[0].id).toBe(ids[1])
    expect(rootSort()).toEqual([0, 1])

    // 读接口的 tree 按契约「空间 → 同级顺序 → 创建时间」排序：
    // 逐行比较 (space_id, sort_order) 单调不减，且集合与库内未删页面一致。
    const readToken = await createApiToken(env, admin, "read")
    const tree = await readTree(env, readToken.token)
    const expectedIds = (
      db.db
        .prepare(`SELECT id FROM ${table("pages")} WHERE deleted_at IS NULL`)
        .all() as Array<{ id: number }>
    ).map((row) => row.id)
    expect(tree.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [...expectedIds].sort((a, b) => a - b)
    )
    for (let index = 1; index < tree.length; index += 1) {
      const previous = tree[index - 1]
      const current = tree[index]
      const monotonic =
        current.space_id > previous.space_id ||
        (current.space_id === previous.space_id &&
          current.sort_order >= previous.sort_order)
      expect(
        monotonic,
        `tree 第 ${index} 行破坏了「空间 → 同级顺序」排序`
      ).toBe(true)
    }
  })

  it("软删进回收站：read/tree/search 排除，站内回收站可见并可恢复", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const spaceId = await defaultSpaceId(env, admin)
    const { token } = await createApiToken(env, admin, "write")
    const parent = await sessionPage(env, admin, {
      title: "待删母页",
      text: "清理词 母"
    })
    const child = await sessionPage(env, admin, {
      title: "待删子页",
      text: "清理词 子"
    })
    expectStatus(
      await jsonRequest(
        env,
        "POST",
        `/api/pages/${child.id}/move`,
        { parentId: parent.id, index: 0 },
        admin
      ),
      200,
      "站内移动子页"
    )

    expectStatus(
      await bearer(env, token, "DELETE", `/api/write/pages/${parent.id}`),
      200,
      "写接口软删母页"
    )

    const readToken = await createApiToken(env, admin, "read")
    const treeIds = (await readTree(env, readToken.token)).map((row) => row.id)
    expect(treeIds).not.toContain(parent.id)
    expect(treeIds).not.toContain(child.id)
    expect(await readSearchIds(env, readToken.token, "清理词")).toEqual([])
    expectStatus(
      await bearer(env, readToken.token, "GET", `/api/read/pages/${parent.id}`),
      404,
      "软删页读接口"
    )
    expectStatus(
      await bearer(env, readToken.token, "GET", `/api/read/pages/${child.id}`),
      404,
      "软删子树读接口"
    )

    const trash = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/trash?spaceId=${spaceId}`,
        undefined,
        admin
      )
    ).json()) as Array<{ id: number; title: string }>
    expect(trash.map((row) => row.id)).toEqual([parent.id])

    // 子树一起恢复，并重新进 FTS。
    expectStatus(
      await jsonRequest(
        env,
        "POST",
        `/api/pages/${parent.id}/restore`,
        undefined,
        admin
      ),
      200,
      "站内恢复"
    )
    const restoredIds = (await readTree(env, readToken.token)).map(
      (row) => row.id
    )
    expect(restoredIds).toContain(parent.id)
    expect(restoredIds).toContain(child.id)
    expect(await readSearchIds(env, readToken.token, "清理词")).toEqual(
      expect.arrayContaining([parent.id, child.id])
    )
  })

  it("JSON 往返保真：写进去的 content_json 原样读回，派生 MD 正确且回写不涨版本", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { token } = await createApiToken(env, admin, "write")

    const created = await bearer(env, token, "POST", "/api/write/pages", {
      title: "往返页",
      content_json: RICH_DOC
    })
    expectStatus(created, 201, "建富结构页")
    const page = (await created.json()) as PageMeta

    const jsonRes = await bearer(
      env,
      token,
      "GET",
      `/api/read/pages/${page.id}?format=json`
    )
    expectStatus(jsonRes, 200, "读回 format=json")
    const detail = (await jsonRes.json()) as Record<string, unknown>
    expect(Object.keys(detail).sort()).toEqual([
      "content_json",
      "created_at",
      "id",
      "parent_id",
      "sort_order",
      "space_id",
      "title",
      "updated_at"
    ])
    // 字符串入参按原文落库：字节级相等才算保真。
    expect(detail.content_json).toBe(RICH_DOC)

    const mdRes = await bearer(env, token, "GET", `/api/read/pages/${page.id}`)
    expectStatus(mdRes, 200, "读回 markdown")
    const markdown = ((await mdRes.json()) as { markdown: string }).markdown
    expect(markdown).toContain("## 往返保真")
    expect(markdown).toContain("**粗体**")
    expect(markdown).toContain("`行内码`")
    expect(markdown).toContain("[链接](https://example.com/a)")
    expect(markdown).toContain("- 条目一")
    expect(markdown).toContain("```ts")
    expect(markdown).toContain("> 引用一行")
    expect(markdown).toContain("| 头 |")

    const versionsBefore = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${page.id}/revisions`,
        undefined,
        admin
      )
    ).json()) as Array<{ versionNo: number }>
    expectStatus(
      await bearer(env, token, "PUT", `/api/write/pages/${page.id}`, {
        content_json: detail.content_json
      }),
      200,
      "回写读回原文"
    )
    const versionsAfter = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${page.id}/revisions`,
        undefined,
        admin
      )
    ).json()) as Array<{ versionNo: number }>
    expect(versionsAfter).toEqual(versionsBefore)

    const sessionDetail = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${page.id}?format=json`,
        undefined,
        admin
      )
    ).json()) as { contentJson: string }
    expect(sessionDetail.contentJson).toBe(RICH_DOC)
  })
})

describe("E 验证·三期 §4 隔离矩阵", () => {
  it("read kind 进写接口五个端点全 401（no-store），已吊销 write 同样 401", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const readToken = await createApiToken(env, admin, "read")
    const doomed = await createApiToken(env, admin, "write")
    expectStatus(
      await jsonRequest(
        env,
        "DELETE",
        `/api/me/tokens/${doomed.id}`,
        undefined,
        admin
      ),
      200,
      "吊销 write 令牌"
    )

    for (const token of [readToken.token, doomed.token]) {
      const calls: Array<[string, string, unknown?]> = [
        [
          "POST",
          "/api/write/pages",
          { title: "x", content_json: docJson("x") }
        ],
        ["PUT", "/api/write/pages/1", { title: "x" }],
        ["POST", "/api/write/pages/1/move", { parent_id: null, index: 0 }],
        ["DELETE", "/api/write/pages/1"],
        ["POST", "/api/write/files"]
      ]
      for (const [method, path, body] of calls) {
        const res =
          path === "/api/write/files"
            ? await upload(env, path, token, formWith(PNG, "image/png"))
            : await bearer(env, token, method, path, body)
        expectStatus(res, 401, `${method} ${path}（${token.slice(0, 12)}…）`)
        expect(res.headers.get("cache-control")).toContain("no-store")
      }
    }
  })

  it("三令牌双向隔离：api_tokens↔import、会话 Cookie↔令牌接口", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const readToken = await createApiToken(env, admin, "read")
    const writeToken = await createApiToken(env, admin, "write")
    const importToken = await createImportToken(env, admin)

    for (const token of [readToken.token, writeToken.token]) {
      expectStatus(
        await bearer(env, token, "GET", "/api/import/spaces"),
        401,
        "接口令牌调导入接口"
      )
    }
    expectStatus(
      await bearer(env, importToken.token, "GET", "/api/read/spaces"),
      401,
      "导入凭证调读接口"
    )
    expectStatus(
      await bearer(env, importToken.token, "POST", "/api/write/pages", {
        title: "x",
        content_json: docJson("x")
      }),
      401,
      "导入凭证调写接口"
    )

    // 会话 Cookie 在三个令牌入口一律无效。
    for (const path of [
      "/api/read/spaces",
      "/api/write/pages",
      "/api/import/spaces"
    ]) {
      const res = await request(env, path, {
        method: path === "/api/write/pages" ? "POST" : "GET",
        headers: {
          cookie: admin,
          "content-type": "application/json"
        },
        body:
          path === "/api/write/pages"
            ? JSON.stringify({ title: "x", content_json: docJson("x") })
            : undefined
      })
      expectStatus(res, 401, `会话 Cookie 调 ${path}`)
    }

    // 令牌也登不上会话接口。
    for (const token of [
      readToken.token,
      writeToken.token,
      importToken.token
    ]) {
      expectStatus(
        await bearer(env, token, "GET", "/api/me"),
        401,
        "令牌调 /api/me"
      )
      expectStatus(
        await bearer(env, token, "GET", "/api/me/tokens"),
        401,
        "令牌调 /api/me/tokens"
      )
    }
  })

  it("吊销一律 401：三类令牌各断各的，其它令牌照常", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const readOne = await createApiToken(env, admin, "read")
    const readTwo = await createApiToken(env, admin, "read")
    const writeToken = await createApiToken(env, admin, "write")
    const importOne = await createImportToken(env, admin)
    const importTwo = await createImportToken(env, admin)

    expectStatus(
      await jsonRequest(
        env,
        "DELETE",
        `/api/me/tokens/${readOne.id}`,
        undefined,
        admin
      ),
      200,
      "吊销只读"
    )
    expectStatus(
      await jsonRequest(
        env,
        "DELETE",
        `/api/me/tokens/${writeToken.id}`,
        undefined,
        admin
      ),
      200,
      "吊销读写"
    )
    expectStatus(
      await jsonRequest(
        env,
        "DELETE",
        `/api/me/import-tokens/${importOne.id}`,
        undefined,
        admin
      ),
      200,
      "吊销导入"
    )

    expectStatus(await readSpaces(env, readOne.token), 401, "吊销的只读")
    expectStatus(
      await bearer(env, writeToken.token, "GET", "/api/read/spaces"),
      401,
      "吊销的读写（读）"
    )
    expectStatus(
      await bearer(env, writeToken.token, "POST", "/api/write/pages", {
        title: "x",
        content_json: docJson("x")
      }),
      401,
      "吊销的读写（写）"
    )
    expectStatus(
      await bearer(env, importOne.token, "GET", "/api/import/spaces"),
      401,
      "吊销的导入"
    )

    expectStatus(await readSpaces(env, readTwo.token), 200, "未吊销的只读")
    expectStatus(
      await bearer(env, importTwo.token, "GET", "/api/import/spaces"),
      200,
      "未吊销的导入"
    )
  })

  it("last_used_at 按命中的令牌行更新：调用哪枚刷哪枚，另一枚不动", async () => {
    const ctx = await initializedContext()
    const { env } = ctx
    const admin = await adminSession(env)
    const readA = await createApiToken(env, admin, "read")
    const readB = await createApiToken(env, admin, "read")
    const write = await createApiToken(env, admin, "write")
    const importToken = await createImportToken(env, admin)

    const lastUsed = (id: number) =>
      (
        ctx.db.db
          .prepare(
            `SELECT last_used_at AS lastUsedAt FROM ${table("api_tokens")} WHERE id = ?`
          )
          .get(id) as { lastUsedAt: string | null }
      ).lastUsedAt

    expect([
      lastUsed(readA.id),
      lastUsed(readB.id),
      lastUsed(write.id)
    ]).toEqual([null, null, null])

    // 读接口用 B、写接口用读写令牌：各自只刷自己那一行。
    expectStatus(await readSpaces(env, readB.token), 200, "B 调读接口")
    expectStatus(
      await bearer(env, write.token, "POST", "/api/write/pages", {
        title: "刷时间",
        content_json: docJson("刷时间")
      }),
      201,
      "读写令牌建页"
    )
    expect(lastUsed(readA.id)).toBeNull()
    expect(lastUsed(readB.id)).not.toBeNull()
    expect(lastUsed(write.id)).not.toBeNull()

    const importLastUsed = () =>
      (
        ctx.db.db
          .prepare(
            `SELECT last_used_at AS lastUsedAt FROM ${table("import_tokens")} WHERE id = ?`
          )
          .get(importToken.id) as { lastUsedAt: string | null }
      ).lastUsedAt
    expect(importLastUsed()).toBeNull()
    expectStatus(
      await bearer(env, importToken.token, "GET", "/api/import/spaces"),
      200,
      "导入令牌调用"
    )
    expect(importLastUsed()).not.toBeNull()
  })

  it("限流桶沿用：read 3000 / write 600 按用户，失败 20 按 IP", async () => {
    const ctx = await initializedContext()
    const { env } = ctx
    const admin = await adminSession(env)
    const userId = await meId(env, admin)
    const readToken = await createApiToken(env, admin, "read")
    const writeToken = await createApiToken(env, admin, "write")

    // 正常调用写入的是 read / write 桶，没有新桶名。
    expectStatus(await readSpaces(env, readToken.token), 200, "读调用")
    expectStatus(
      await bearer(env, writeToken.token, "POST", "/api/write/pages", {
        title: "桶名",
        content_json: docJson("桶名")
      }),
      201,
      "写调用"
    )
    const actions = (
      ctx.db.db
        .prepare(
          `SELECT DISTINCT action FROM ${table("auth_counters")} ORDER BY action`
        )
        .all() as Array<{ action: string }>
    ).map((row) => row.action)
    expect(actions).toEqual(
      expect.arrayContaining(["read", "write", "login", "register"])
    )
    expect(actions).not.toContain("read_write")

    seedCounter(ctx, "read", String(userId), "", 3000)
    const readLimited = await readSpaces(env, readToken.token)
    expectStatus(readLimited, 429, "read 桶满")
    expect(await readLimited.json()).toMatchObject({ code: "RATE_LIMITED" })

    seedCounter(ctx, "write", String(userId), "", 600)
    const writeLimited = await bearer(
      env,
      writeToken.token,
      "POST",
      "/api/write/pages",
      { title: "限流", content_json: docJson("限流") }
    )
    expectStatus(writeLimited, 429, "write 桶满")

    seedCounter(ctx, READ_AUTH_FAIL, "", "unknown", 20)
    const readFail = await readSpaces(env, readToken.token)
    expectStatus(readFail, 429, "读失败桶满（先拒后验）")

    // 读写令牌调读接口的失败也计入同一个 read_auth_fail 桶。
    const ctxWrite = await initializedContext()
    const adminWrite = await adminSession(ctxWrite.env)
    const okWrite = await createApiToken(ctxWrite.env, adminWrite, "write")
    seedCounter(ctxWrite, WRITE_AUTH_FAIL, "", "unknown", 20)
    expectStatus(
      await bearer(ctxWrite.env, okWrite.token, "POST", "/api/write/pages", {
        title: "x",
        content_json: docJson("x")
      }),
      429,
      "写失败桶满（先拒后验）"
    )
  })

  it("创建令牌限流按 kind 分桶：10 次 / 5 分钟，读写桶互不影响", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    for (let index = 0; index < 10; index += 1) {
      expectStatus(
        await jsonRequest(
          env,
          "POST",
          "/api/me/tokens",
          { kind: "read" },
          admin
        ),
        201,
        `第 ${index + 1} 次只读创建`
      )
    }
    const eleventh = await jsonRequest(
      env,
      "POST",
      "/api/me/tokens",
      { kind: "read" },
      admin
    )
    expectStatus(eleventh, 429, "第 11 次只读创建")
    expect(await eleventh.json()).toMatchObject({ code: "RATE_LIMITED" })
    // 读写桶不受只读桶影响。
    expectStatus(
      await jsonRequest(
        env,
        "POST",
        "/api/me/tokens",
        { kind: "write" },
        admin
      ),
      201,
      "只读桶满后仍可建读写令牌"
    )
  })
})

// ════════════════════════════════════════════════════════════════════════════
// §7 第 5 条：写接口第五端点（POST /api/write/files）
// ════════════════════════════════════════════════════════════════════════════

interface UploadedImage {
  key: string
  url: string
  contentType: string
  size: number
}

describe("E 验证·写接口第五端点", () => {
  it("上传成功且响应形状与 /api/import/files 一致（四键、落 pages/ 与 imports/）", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)
    const writeToken = await createApiToken(env, admin, "write")
    const importToken = await createImportToken(env, admin)

    const writeRes = await upload(
      env,
      "/api/write/files",
      writeToken.token,
      formWith(PNG, "image/png")
    )
    expectStatus(writeRes, 201, "POST /api/write/files")
    const written = (await writeRes.json()) as UploadedImage
    const importRes = await upload(
      env,
      "/api/import/files",
      importToken.token,
      formWith(PNG, "image/png")
    )
    expectStatus(importRes, 201, "POST /api/import/files")
    const imported = (await importRes.json()) as UploadedImage

    expect(Object.keys(written).sort()).toEqual([
      "contentType",
      "key",
      "size",
      "url"
    ])
    expect(Object.keys(imported).sort()).toEqual(Object.keys(written).sort())
    expect(written.key).toMatch(/^pages\/[0-9a-f-]{36}\.png$/)
    expect(imported.key).toMatch(/^imports\/[0-9a-f-]{36}\.png$/)
    expect(written.url).toBe(`/api/files/${written.key}`)
    expect(written.contentType).toBe("image/png")
    expect(imported.contentType).toBe("image/png")
    expect(written.size).toBe(PNG.length)
    expect(imported.size).toBe(PNG.length)
    expect(r2.store.has(written.key)).toBe(true)
  })

  it("上传鉴权：read kind / 已吊销 write / 导入凭证 / 会话 Cookie 全 401", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const readToken = await createApiToken(env, admin, "read")
    const importToken = await createImportToken(env, admin)
    const revoked = await createApiToken(env, admin, "write")
    expectStatus(
      await jsonRequest(
        env,
        "DELETE",
        `/api/me/tokens/${revoked.id}`,
        undefined,
        admin
      ),
      200,
      "吊销 write 令牌"
    )

    for (const token of [
      readToken.token,
      importToken.token,
      revoked.token,
      "not-a-token"
    ]) {
      const res = await upload(
        env,
        "/api/write/files",
        token,
        formWith(PNG, "image/png")
      )
      expectStatus(res, 401, "写上传拒绝非 write 凭证")
      expect(res.headers.get("cache-control")).toContain("no-store")
    }

    const sessionOnly = await request(env, "/api/write/files", {
      method: "POST",
      headers: { cookie: admin },
      body: formWith(PNG, "image/png")
    })
    expectStatus(sessionOnly, 401, "会话 Cookie 上传")
  })

  it("上传引用写进 content_json 建页，读回 HTML 含文件地址", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const { token } = await createApiToken(env, admin, "write")
    const uploaded = (await (
      await upload(env, "/api/write/files", token, formWith(PNG, "image/png"))
    ).json()) as UploadedImage

    const created = await bearer(env, token, "POST", "/api/write/pages", {
      title: "带图页",
      content_json: JSON.stringify({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "正文引用图片" }]
          },
          { type: "image", attrs: { src: uploaded.url, alt: "图" } }
        ]
      })
    })
    expectStatus(created, 201, "带图建页")
    const page = (await created.json()) as PageMeta

    const sessionDetail = (await (
      await jsonRequest(env, "GET", `/api/pages/${page.id}`, undefined, admin)
    ).json()) as { contentHtml: string }
    expect(sessionDetail.contentHtml).toContain(uploaded.url)
    expect(sessionDetail.contentHtml).not.toContain("data-original-src")

    // 读接口的 JSON 与 MD 都能拿回同一地址（MD 里补成绝对地址）。
    const readJson = (await (
      await bearer(env, token, "GET", `/api/read/pages/${page.id}?format=json`)
    ).json()) as { content_json: string }
    expect(readJson.content_json).toContain(uploaded.url)
    const markdown = (
      (await (
        await bearer(env, token, "GET", `/api/read/pages/${page.id}`)
      ).json()) as { markdown: string }
    ).markdown
    expect(markdown).toContain(`https://ciki.oneboy.app${uploaded.url}`)
  })

  it("受范围限制的 write 令牌可上传，但引用建页到范围外空间仍 404 且零写入", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const defaultId = await defaultSpaceId(env, admin)
    const outside = await createSpace(env, admin, "范围外空间")
    const { token } = await createApiToken(env, admin, "write", {
      spaceIds: [defaultId]
    })

    const uploaded = (await (
      await upload(env, "/api/write/files", token, formWith(PNG, "image/png"))
    ).json()) as UploadedImage
    expect(uploaded.key).toMatch(/^pages\//)

    const before = (
      db.db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${table("pages")} WHERE space_id = ?`
        )
        .get(outside.id) as { n: number }
    ).n
    const res = await bearer(env, token, "POST", "/api/write/pages", {
      space_id: outside.id,
      title: "范围外带图页",
      content_json: JSON.stringify({
        type: "doc",
        content: [{ type: "image", attrs: { src: uploaded.url, alt: "图" } }]
      })
    })
    expectStatus(res, 404, "范围外空间建页")
    expect(await res.json()).toMatchObject({ code: "SPACE_NOT_FOUND" })
    const after = (
      db.db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${table("pages")} WHERE space_id = ?`
        )
        .get(outside.id) as { n: number }
    ).n
    expect(after).toBe(before)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// §7 第 6 条：导入多凭证与插件契约回归
// ════════════════════════════════════════════════════════════════════════════

describe("E 验证·导入多凭证", () => {
  it("两支凭证都能调 /api/import/*，吊销一支只断一支", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const first = await createImportToken(env, admin, "插件甲")
    const second = await createImportToken(env, admin, "插件乙")

    for (const token of [first, second]) {
      expectStatus(
        await bearer(env, token.token, "GET", "/api/import/spaces"),
        200,
        `凭证 ${token.name} 调 spaces`
      )
      const created = await bearer(
        env,
        token.token,
        "POST",
        "/api/import/pages",
        {
          title: `由 ${token.name} 建`,
          contentJson: docJson(`由 ${token.name} 建`),
          conflict: "create_copy"
        }
      )
      expectStatus(created, 201, `凭证 ${token.name} 建页`)
    }

    expectStatus(
      await jsonRequest(
        env,
        "DELETE",
        `/api/me/import-tokens/${first.id}`,
        undefined,
        admin
      ),
      200,
      "吊销凭证甲"
    )
    expectStatus(
      await bearer(env, first.token, "GET", "/api/import/spaces"),
      401,
      "吊销后的凭证甲"
    )
    expectStatus(
      await bearer(env, second.token, "GET", "/api/import/spaces"),
      200,
      "凭证乙不受影响"
    )
    const list = (await (
      await jsonRequest(env, "GET", "/api/me/import-tokens", undefined, admin)
    ).json()) as { tokens: Array<{ id: number; name: string }> }
    expect(list.tokens.map((row) => row.name)).toEqual(["插件乙"])
    // 已吊销再吊销一次：404（不是幂等成功）。
    expectStatus(
      await jsonRequest(
        env,
        "DELETE",
        `/api/me/import-tokens/${first.id}`,
        undefined,
        admin
      ),
      404,
      "重复吊销凭证甲"
    )
  })

  it("插件契约回归：spaces/parents/check/files/pages 行为与形状不变", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const defaultId = await defaultSpaceId(env, admin)
    const { token } = await createImportToken(env, admin)

    // spaces：精确三键 id/slug/name。
    const spacesRes = await bearer(env, token, "GET", "/api/import/spaces")
    expectStatus(spacesRes, 200, "GET /api/import/spaces")
    const spaces = (await spacesRes.json()) as Array<Record<string, unknown>>
    expect(spaces[0]).toEqual({
      id: defaultId,
      slug: expect.any(String),
      name: "默认空间"
    })
    expect(Object.keys(spaces[0]).sort()).toEqual(["id", "name", "slug"])

    // parents：精确三键 id/title/parentId。
    const parentsRes = await bearer(env, token, "GET", "/api/import/parents")
    expectStatus(parentsRes, 200, "GET /api/import/parents")
    const parents = (await parentsRes.json()) as Array<Record<string, unknown>>
    expect(parents).toEqual([])

    // check：不存在 → {exists:false}。
    const checkMissing = await bearer(env, token, "POST", "/api/import/check", {
      title: "插件页",
      parentId: null
    })
    expectStatus(checkMissing, 200, "check 不存在")
    expect(await checkMissing.json()).toEqual({ exists: false })

    // files：与写接口同形状，落 imports/。
    const filesRes = await upload(
      env,
      "/api/import/files",
      token,
      formWith(PNG, "image/png")
    )
    expectStatus(filesRes, 201, "POST /api/import/files")
    const image = (await filesRes.json()) as UploadedImage
    expect(Object.keys(image).sort()).toEqual([
      "contentType",
      "key",
      "size",
      "url"
    ])
    expect(image.key).toMatch(/^imports\//)

    // pages：新建 201 {pageId,url}，update 覆盖 200 同形状。
    const createRes = await bearer(env, token, "POST", "/api/import/pages", {
      title: "插件页",
      parentId: null,
      contentJson: docJson("插件第一版"),
      conflict: "update"
    })
    expectStatus(createRes, 201, "import/pages 新建")
    const created = (await createRes.json()) as { pageId: number; url: string }
    expect(Object.keys(created).sort()).toEqual(["pageId", "url"])
    expect(created.url).toBe(`/p/${created.pageId}`)

    const checkExisting = await bearer(
      env,
      token,
      "POST",
      "/api/import/check",
      {
        title: "插件页",
        parentId: null
      }
    )
    expectStatus(checkExisting, 200, "check 已存在")
    expect(await checkExisting.json()).toEqual({
      exists: true,
      pageId: created.pageId
    })

    const updateRes = await bearer(env, token, "POST", "/api/import/pages", {
      title: "插件页",
      parentId: null,
      contentJson: docJson("插件第二版"),
      conflict: "update"
    })
    expectStatus(updateRes, 200, "import/pages 覆盖")
    expect(await updateRes.json()).toEqual(created)

    const parentsAfter = (await (
      await bearer(env, token, "GET", "/api/import/parents")
    ).json()) as Array<Record<string, unknown>>
    expect(parentsAfter).toEqual([
      { id: created.pageId, title: "插件页", parentId: null }
    ])

    // 错误码：非法 conflict 400、空间不存在 404、无权空间 403。
    expectStatus(
      await bearer(env, token, "POST", "/api/import/pages", {
        title: "x",
        contentJson: docJson("x"),
        conflict: "overwrite"
      }),
      400,
      "非法 conflict"
    )
    expectStatus(
      await bearer(env, token, "POST", "/api/import/pages", {
        title: "x",
        space_id: 999999,
        contentJson: docJson("x"),
        conflict: "update"
      }),
      404,
      "空间不存在"
    )
    const outsider = await userSession(env, admin, "importer@example.com")
    const outsiderToken = await createImportToken(env, outsider)
    const closed = await createSpace(env, admin, "不许导入的空间")
    expectStatus(
      await bearer(env, outsiderToken.token, "POST", "/api/import/pages", {
        title: "x",
        space_id: closed.id,
        contentJson: docJson("x"),
        conflict: "update"
      }),
      403,
      "无权空间 403"
    )
  })

  it("导入调用限流沿用 import 桶（3000 次 / 5 分钟）", async () => {
    const ctx = await initializedContext()
    const { env } = ctx
    const admin = await adminSession(env)
    const userId = await meId(env, admin)
    const { token } = await createImportToken(env, admin)

    expectStatus(
      await bearer(env, token, "GET", "/api/import/spaces"),
      200,
      "导入正常调用"
    )
    seedCounter(ctx, "import", String(userId), "", 3000)
    const limited = await bearer(env, token, "GET", "/api/import/spaces")
    expectStatus(limited, 429, "import 桶满")
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED" })
  })
})
