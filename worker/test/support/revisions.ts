/**
 * 版本治理三件套（保留数 / 手动删除 / gzip 存储）的测试夹具。
 *
 * 统一用「一段正文 = 一份 JSON + 它的渲染结果」的自洽夹具：版本的唯一真源是 JSON，
 * HTML/纯文本由服务端按需生成，夹具不自洽会让「内容是否一致」的断言失去意义。
 */
import { expect } from "vitest"
import { adminSession, jsonRequest, userSession, type TestContext } from "./app"

export interface PageDetail {
  id: string
  spaceId: string
  title: string
  contentJson: string
  contentHtml: string
  contentText: string
  updatedAt: string
}

export interface RevisionSummary {
  id: string
  title: string
  editorId: string
  createdAt: string
}

export interface RevisionDetail extends RevisionSummary {
  pageId: string
  contentJson: string
  contentHtml: string
  contentText: string
}

type Env = TestContext["env"]

/** 纯文本 → 能过编辑器 schema 的一段正文 JSON。 */
export function paragraphDoc(text: string, extra: unknown[] = []): string {
  return JSON.stringify({
    type: "doc",
    content: [
      ...(text
        ? [{ type: "paragraph", content: [{ type: "text", text }] }]
        : []),
      ...extra
    ]
  })
}

export interface PageInput {
  title: string
  /** 正文纯文本（默认取标题）。 */
  text?: string
  /** 额外的 TipTap 节点（图片、表格等）。 */
  extra?: unknown[]
  /** 直接指定 JSON（用于构造渲染不了的内容）。 */
  contentJson?: string
  spaceId?: string
  parentId?: string | null
}

export async function createPage(
  env: Env,
  cookie: string,
  input: PageInput
): Promise<PageDetail> {
  const text = input.text ?? input.title
  const res = await jsonRequest(
    env,
    "POST",
    "/api/pages",
    {
      title: input.title,
      parentId: input.parentId ?? null,
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      contentJson: input.contentJson ?? paragraphDoc(text, input.extra),
      contentHtml: `<p>${text}</p>`,
      contentText: text
    },
    cookie
  )
  expect(res.status).toBe(201)
  return (await res.json()) as PageDetail
}

/** 保存（有实际改动才追加版本）。 */
export async function savePage(
  env: Env,
  cookie: string,
  pageId: string,
  input: { title: string; text: string }
): Promise<PageDetail> {
  const res = await jsonRequest(
    env,
    "PUT",
    `/api/pages/${pageId}`,
    {
      title: input.title,
      contentJson: paragraphDoc(input.text),
      contentHtml: `<p>${input.text}</p>`,
      contentText: input.text
    },
    cookie
  )
  expect(res.status).toBe(200)
  return (await res.json()) as PageDetail
}

export async function listRevisions(
  env: Env,
  cookie: string,
  pageId: string
): Promise<RevisionSummary[]> {
  const res = await jsonRequest(
    env,
    "GET",
    `/api/pages/${pageId}/revisions`,
    undefined,
    cookie
  )
  expect(res.status).toBe(200)
  return (await res.json()) as RevisionSummary[]
}

export function getRevision(
  env: Env,
  cookie: string,
  pageId: string,
  revisionId: string
): Promise<Response> {
  return jsonRequest(
    env,
    "GET",
    `/api/pages/${pageId}/revisions/${revisionId}`,
    undefined,
    cookie
  )
}

export function restoreRevision(
  env: Env,
  cookie: string,
  pageId: string,
  revisionId: string
): Promise<Response> {
  return jsonRequest(
    env,
    "POST",
    `/api/pages/${pageId}/revisions/${revisionId}/restore`,
    undefined,
    cookie
  )
}

export function deleteRevision(
  env: Env,
  cookie: string,
  pageId: string,
  revisionId: string
): Promise<Response> {
  return jsonRequest(
    env,
    "DELETE",
    `/api/pages/${pageId}/revisions/${revisionId}`,
    undefined,
    cookie
  )
}

export function prunePageRevisions(
  env: Env,
  cookie: string,
  pageId: string
): Promise<Response> {
  return jsonRequest(
    env,
    "POST",
    `/api/pages/${pageId}/revisions/prune`,
    undefined,
    cookie
  )
}

/** 管理面设置读写（整对象 GET，按需断言里头的字段）。 */
export async function getSettings(
  env: Env,
  cookie: string
): Promise<Record<string, unknown>> {
  const res = await jsonRequest(
    env,
    "GET",
    "/api/admin/settings",
    undefined,
    cookie
  )
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

export function putSettings(
  env: Env,
  cookie: string,
  body: Record<string, unknown>
): Promise<Response> {
  return jsonRequest(env, "PUT", "/api/admin/settings", body, cookie)
}

export interface RetentionPreview {
  limit: number | null
  totalRevisions: number
  prunableRevisions: number
}

export async function retentionPreview(
  env: Env,
  cookie: string
): Promise<RetentionPreview> {
  const res = await jsonRequest(
    env,
    "GET",
    "/api/admin/revisions/retention",
    undefined,
    cookie
  )
  expect(res.status).toBe(200)
  return (await res.json()) as RetentionPreview
}

export function pruneAllRevisions(env: Env, cookie: string): Promise<Response> {
  return jsonRequest(
    env,
    "POST",
    "/api/admin/revisions/prune",
    undefined,
    cookie
  )
}

export interface RevisionStorageRow {
  id: string
  page_id: string
  title: string
  content_json: string
  content_html: string
  content_text: string
  editor_id: string
  created_at: string
  content_gzip: Uint8Array | null
  gzip_type: string | null
  gzip_length: number | null
}

/** 直接读库的版本行（含 BLOB 的类型与字节长度，用来断言落库形态）。 */
export function revisionRows(
  db: TestContext["db"],
  pageId?: string
): RevisionStorageRow[] {
  const sql = `SELECT id, page_id, title, content_json, content_html, content_text,
                      editor_id, created_at, content_gzip,
                      typeof(content_gzip) AS gzip_type,
                      length(content_gzip) AS gzip_length
                 FROM ciki_page_revisions
                ${pageId ? "WHERE page_id = ?" : ""}
                ORDER BY created_at, rowid`
  return (
    pageId ? db.db.prepare(sql).all(pageId) : db.db.prepare(sql).all()
  ) as RevisionStorageRow[]
}

export function countRevisionsInDb(
  db: TestContext["db"],
  pageId?: string
): number {
  const row = (
    pageId
      ? db.db
          .prepare(
            "SELECT COUNT(*) AS count FROM ciki_page_revisions WHERE page_id = ?"
          )
          .get(pageId)
      : db.db.prepare("SELECT COUNT(*) AS count FROM ciki_page_revisions").get()
  ) as { count: number }
  return row.count
}

/** 页面行与 FTS 行的快照：用来断言「删版本/修剪不动当前内容与搜索索引」。 */
export function pageSnapshot(
  db: TestContext["db"],
  pageId: string
): { page: Record<string, unknown>; fts: unknown[] } {
  const page = db.db
    .prepare(
      `SELECT title, content_json, content_html, content_text, updated_at, updated_by
         FROM ciki_pages WHERE id = ?`
    )
    .get(pageId)
  const fts = db.db
    .prepare(
      "SELECT page_id, title, content_text FROM ciki_pages_fts WHERE page_id = ?"
    )
    .all(pageId)
  return { page, fts }
}

/** 一个「管理员 + 默认空间里的一页」的最小上下文。 */
export async function adminWithPage(
  context: TestContext,
  title = "版本页"
): Promise<{ env: Env; admin: string; page: PageDetail }> {
  const admin = await adminSession(context.env)
  const page = await createPage(context.env, admin, { title })
  return { env: context.env, admin, page }
}

/** 默认空间之外的普通用户：注册后被并入默认空间，再把他移出去当「非成员」。 */
export async function outsiderSession(
  env: Env,
  admin: string,
  email = "outsider@example.com"
): Promise<string> {
  const outsider = await userSession(env, admin, email)
  const me = (await (
    await jsonRequest(env, "GET", "/api/me", undefined, outsider)
  ).json()) as { id: string }
  const spaces = (await (
    await jsonRequest(env, "GET", "/api/spaces", undefined, admin)
  ).json()) as Array<{ id: string; isDefault: boolean }>
  const defaultSpace = spaces.find((space) => space.isDefault)
  if (!defaultSpace) throw new Error("default space missing")
  const res = await jsonRequest(
    env,
    "DELETE",
    `/api/spaces/${defaultSpace.id}/members/${me.id}`,
    undefined,
    admin
  )
  expect([200, 204]).toContain(res.status)
  return outsider
}

/** 默认空间里的一个只读成员（viewer），用来验证删除入口的服务端校验。 */
export async function viewerSession(
  env: Env,
  admin: string,
  email = "viewer@example.com"
): Promise<string> {
  const viewer = await userSession(env, admin, email)
  const me = (await (
    await jsonRequest(env, "GET", "/api/me", undefined, viewer)
  ).json()) as { id: string }
  const spaces = (await (
    await jsonRequest(env, "GET", "/api/spaces", undefined, admin)
  ).json()) as Array<{ id: string; isDefault: boolean }>
  const defaultSpace = spaces.find((space) => space.isDefault)
  if (!defaultSpace) throw new Error("default space missing")
  // 注册即被并入默认空间（editor），这里把角色降成 viewer。
  const res = await jsonRequest(
    env,
    "PUT",
    `/api/spaces/${defaultSpace.id}/members/${me.id}`,
    { role: "viewer" },
    admin
  )
  expect(res.status).toBe(200)
  return viewer
}
