/**
 * 读侧二期单 B：`/api/read/spaces` + 三个既有读接口的范围过滤 + 读中间件认读写令牌。
 *
 * 口径来自 API-PHASE2-SPEC 的 §1 / §2.5 / §3.1（已冻结）：
 * - `spaces`：集合 = 令牌的**有效可见空间**（主人可见空间 ∩ 范围），排序与站内空间列表
 *   一致（默认空间在前 → 名称大小写不敏感 → 创建时间），每项**只有** id / name / slug；
 * - 范围是叠在现行成员过滤之外的一层（不替代它），范围外一律按不存在处理：
 *   tree / search 不返回该空间的行，pages/:id 与范围外空间一律 404，不泄露存在性；
 * - 读写令牌可调四个读接口，范围取它自己那一份（`token_kind='write'`），
 *   调用计入现行 `read` 桶（不新开桶），`last_used_at` 只更新命中那张表。
 *
 * 这里断言的是**精确键集合**与「同一条规则在四个接口一致」，多一个键少一个键都算破坏契约。
 */
import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"
import type { Env } from "../src/types"

const READ_TOKEN_PATH = "/api/me/read-token"
const WRITE_TOKEN_PATH = "/api/me/write-token"

interface SpaceBrief {
  id: number
  name: string
  slug: string
}

interface PageBrief {
  id: string
  title: string
}

async function issueToken(
  env: Env,
  cookie: string,
  path: string,
  body: unknown = {}
): Promise<string> {
  const res = await jsonRequest(env, "POST", path, body, cookie)
  expect(res.status).toBe(200)
  return ((await res.json()) as { token: string }).token
}

function readGet(env: Env, token: string, path: string): Promise<Response> {
  return request(env, path, { headers: { authorization: `Bearer ${token}` } })
}

/** GET /api/read/spaces 的 `spaces` 数组（同时断言外层只有这一个键）。 */
async function spaces(env: Env, token: string): Promise<SpaceBrief[]> {
  const res = await readGet(env, token, "/api/read/spaces")
  expect(res.status).toBe(200)
  const body = (await res.json()) as { spaces: SpaceBrief[] }
  expect(Object.keys(body)).toEqual(["spaces"])
  return body.spaces
}

async function treeIds(env: Env, token: string): Promise<string[]> {
  const res = await readGet(env, token, "/api/read/tree")
  expect(res.status).toBe(200)
  const rows = (await res.json()) as Array<{ id: string }>
  return rows.map((row) => row.id)
}

async function searchIds(
  env: Env,
  token: string,
  query: string
): Promise<string[]> {
  const res = await readGet(
    env,
    token,
    `/api/read/search?q=${encodeURIComponent(query)}`
  )
  expect(res.status).toBe(200)
  const rows = (await res.json()) as Array<{ id: string }>
  return rows.map((row) => row.id)
}

async function createSpace(
  env: Env,
  cookie: string,
  name: string
): Promise<SpaceBrief> {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/spaces",
    { name, description: "" },
    cookie
  )
  expect(res.status).toBe(201)
  return (await res.json()) as SpaceBrief
}

async function createPage(
  env: Env,
  cookie: string,
  input: { title: string; text?: string; spaceId?: number }
): Promise<PageBrief> {
  const text = input.text ?? input.title
  const res = await jsonRequest(
    env,
    "POST",
    "/api/pages",
    {
      title: input.title,
      parentId: null,
      spaceId: input.spaceId === undefined ? null : String(input.spaceId),
      contentJson: JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }]
      }),
      contentHtml: `<p>${text}</p>`,
      contentText: text
    },
    cookie
  )
  expect(res.status).toBe(201)
  return (await res.json()) as PageBrief
}

async function meId(env: Env, cookie: string): Promise<number> {
  const me = (await (
    await jsonRequest(env, "GET", "/api/me", undefined, cookie)
  ).json()) as { id: number }
  return me.id
}

async function addMember(
  env: Env,
  admin: string,
  spaceId: number,
  userId: number,
  role: "admin" | "editor" | "viewer"
): Promise<void> {
  const res = await jsonRequest(
    env,
    "POST",
    `/api/spaces/${spaceId}/members`,
    { userId: String(userId), role },
    admin
  )
  expect(res.status).toBe(201)
}

describe("只读接口：GET /api/read/spaces", () => {
  it("每项只有 id/name/slug 三键；默认空间在前，其余按名称大小写不敏感再按创建时间", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const token = await issueToken(env, admin, READ_TOKEN_PATH)
    // 故意先建 beta 再建 Alpha：名称序（NOCASE）优先于创建时间。
    await createSpace(env, admin, "beta")
    await createSpace(env, admin, "Alpha")

    const list = await spaces(env, token)

    // 三键的精确键集合（冻结契约，接入方按此对接）。
    for (const item of list) {
      expect(Object.keys(item).sort()).toEqual(["id", "name", "slug"])
    }

    // 排序：默认空间（is_default=1）在前，其余名称大小写不敏感、再创建时间；
    // 集合与顺序都等于站内空间列表同一条 SQL。
    expect(list.map((item) => item.name)).toEqual(["默认空间", "Alpha", "beta"])
    const rows = db.db
      .prepare(
        `SELECT id, name, slug FROM ciki_spaces
          ORDER BY is_default DESC, name COLLATE NOCASE, created_at`
      )
      .all() as Array<{ id: number; name: string; slug: string }>
    expect(list).toEqual(rows)
  })

  it("范围收窄生效；范围清空后同一枚令牌立即恢复全量（不需要重发令牌）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const alpha = await createSpace(env, admin, "Alpha")
    const beta = await createSpace(env, admin, "Beta")
    const token = await issueToken(env, admin, READ_TOKEN_PATH, {
      spaceIds: [beta.id]
    })

    expect((await spaces(env, token)).map((item) => item.id)).toEqual([beta.id])

    // 只改范围、不换令牌：下一次调用就按新范围算（每次校验回表）。
    const cleared = await jsonRequest(
      env,
      "PUT",
      `${READ_TOKEN_PATH}/spaces`,
      { spaceIds: null },
      admin
    )
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toEqual({ spaceIds: null })

    const restored = (await spaces(env, token)).map((item) => item.id)
    expect(restored).toContain(alpha.id)
    expect(restored).toContain(beta.id)
  })
})

describe("只读接口：范围叠在成员过滤之外（§2.5）", () => {
  it("tree / search / pages:id 三处一致：范围外一律按不存在处理，对站点管理员同样生效", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const alpha = await createSpace(env, admin, "范围 A")
    const beta = await createSpace(env, admin, "范围 B")
    const alphaPage = await createPage(env, admin, {
      title: "A 的页面",
      text: "范围关键词 甲",
      spaceId: alpha.id
    })
    const betaPage = await createPage(env, admin, {
      title: "机密 B 页面",
      text: "范围关键词 乙",
      spaceId: beta.id
    })

    // 未设范围的令牌：管理员的读权限 = 全部空间（对照组）。
    const unscoped = await issueToken(env, admin, READ_TOKEN_PATH)
    expect(await treeIds(env, unscoped)).toEqual(
      expect.arrayContaining([alphaPage.id, betaPage.id])
    )
    expect(await searchIds(env, unscoped, "范围关键词")).toEqual(
      expect.arrayContaining([alphaPage.id, betaPage.id])
    )

    // 设了范围 [A] 的令牌：范围对站点管理员也生效。
    const scoped = await issueToken(env, admin, READ_TOKEN_PATH, {
      spaceIds: [alpha.id]
    })
    const tree = await treeIds(env, scoped)
    expect(tree).toContain(alphaPage.id)
    expect(tree).not.toContain(betaPage.id)

    expect(await searchIds(env, scoped, "范围关键词")).toContain(alphaPage.id)
    expect(await searchIds(env, scoped, "范围关键词")).not.toContain(
      betaPage.id
    )

    expect(
      (await readGet(env, scoped, `/api/read/pages/${alphaPage.id}`)).status
    ).toBe(200)
    const denied = await readGet(env, scoped, `/api/read/pages/${betaPage.id}`)
    expect(denied.status).toBe(404)
    const deniedBody = await denied.text()
    expect(JSON.parse(deniedBody)).toEqual({ error: "Page not found" })
    // 不泄露存在性：响应体里连标题字样都没有。
    expect(deniedBody).not.toContain("机密")
    expect((await spaces(env, scoped)).map((item) => item.id)).toEqual([
      alpha.id
    ])
  })

  it("非管理员两层过滤各用自己的绑定值（成员过滤 + 范围过滤、顺序不打乱）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)
    const userId = await meId(env, user)

    const alpha = await createSpace(env, admin, "成员空间")
    const beta = await createSpace(env, admin, "非成员空间")
    await addMember(env, admin, alpha.id, userId, "viewer")
    const alphaPage = await createPage(env, admin, {
      title: "成员空间的页",
      text: "两层关键词",
      spaceId: alpha.id
    })
    const betaPage = await createPage(env, admin, {
      title: "非成员空间的页",
      text: "两层关键词",
      spaceId: beta.id
    })

    // 两层过滤各用自己的绑定值：成员过滤按 userId、范围过滤按空间 id，值不能串位。
    // （范围只能收窄：非成员即使把空间写进范围也在写入时被 400 拒掉，这里不重复那一层。）
    const token = await issueToken(env, user, READ_TOKEN_PATH, {
      spaceIds: [alpha.id]
    })
    expect(await treeIds(env, token)).toEqual([alphaPage.id])
    expect(await searchIds(env, token, "两层关键词")).toEqual([alphaPage.id])
    expect((await spaces(env, token)).map((item) => item.id)).toEqual([
      alpha.id
    ])
    expect(
      (await readGet(env, token, `/api/read/pages/${betaPage.id}`)).status
    ).toBe(404)
  })
})

describe("只读接口：读写令牌可调读接口（§3.1）", () => {
  it("四个接口都能调，范围取读写令牌自己那份，与只读令牌互不影响", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const alpha = await createSpace(env, admin, "只读范围")
    const beta = await createSpace(env, admin, "读写范围")
    const alphaPage = await createPage(env, admin, {
      title: "只读范围的页",
      text: "互通关键词",
      spaceId: alpha.id
    })
    const betaPage = await createPage(env, admin, {
      title: "读写范围的页",
      text: "互通关键词",
      spaceId: beta.id
    })

    const read = await issueToken(env, admin, READ_TOKEN_PATH, {
      spaceIds: [alpha.id]
    })
    const write = await issueToken(env, admin, WRITE_TOKEN_PATH, {
      spaceIds: [beta.id]
    })

    // 读写令牌：四个读接口都放行，范围是它自己的 [B]。
    expect((await spaces(env, write)).map((item) => item.id)).toEqual([beta.id])
    const writeTree = await treeIds(env, write)
    expect(writeTree).toContain(betaPage.id)
    expect(writeTree).not.toContain(alphaPage.id)
    expect(await searchIds(env, write, "互通关键词")).toEqual([betaPage.id])
    expect(
      (await readGet(env, write, `/api/read/pages/${betaPage.id}`)).status
    ).toBe(200)
    expect(
      (await readGet(env, write, `/api/read/pages/${alphaPage.id}`)).status
    ).toBe(404)

    // 只读令牌仍按自己那份范围走，没被读写令牌影响。
    expect((await spaces(env, read)).map((item) => item.id)).toEqual([alpha.id])
    expect(await treeIds(env, read)).toEqual([alphaPage.id])
  })

  it("计入现行 read 桶（不新开 write 桶），且只刷新读写令牌自己的 last_used_at", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const userId = await meId(env, admin)
    const alpha = await createSpace(env, admin, "桶范围")
    const page = await createPage(env, admin, {
      title: "桶页",
      text: "桶关键词",
      spaceId: alpha.id
    })

    // 只读令牌先生成但一次都不用：它的 last_used_at 必须保持 null。
    await issueToken(env, admin, READ_TOKEN_PATH)
    const write = await issueToken(env, admin, WRITE_TOKEN_PATH)

    expect((await readGet(env, write, "/api/read/spaces")).status).toBe(200)
    expect(await treeIds(env, write)).toContain(page.id)
    expect(await searchIds(env, write, "桶关键词")).toEqual([page.id])
    expect(
      (await readGet(env, write, `/api/read/pages/${page.id}`)).status
    ).toBe(200)

    // 计数：四次调用全记在 `read` 桶（按用户），没有 `write` 桶的行。
    const counters = db.db
      .prepare(
        `SELECT action, account, count FROM ciki_auth_counters
          WHERE action IN ('read', 'write')`
      )
      .all() as Array<{ action: string; account: string; count: number }>
    expect(counters).toHaveLength(1)
    expect(counters[0].action).toBe("read")
    expect(counters[0].account).toBe(String(userId))
    expect(counters[0].count).toBe(4)

    // last_used_at 只更新命中的那枚令牌行。
    const readRow = db.db
      .prepare(
        "SELECT last_used_at FROM ciki_api_tokens WHERE user_id = ? AND kind = 'read'"
      )
      .get(userId) as { last_used_at: string | null }
    const writeRow = db.db
      .prepare(
        "SELECT last_used_at FROM ciki_api_tokens WHERE user_id = ? AND kind = 'write'"
      )
      .get(userId) as { last_used_at: string | null }
    expect(readRow.last_used_at).toBeNull()
    expect(writeRow.last_used_at).not.toBeNull()
  })
})
