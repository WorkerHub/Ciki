/**
 * 页面：树、详情、新建、保存、移动、软删/恢复/彻底删、版本与回滚。
 *
 * - wiki 语义：登录用户可新建/编辑任何页面；删除/恢复/彻底删/回滚限页面作者
 *   （created_by）或管理员。
 * - 每次新建/保存/回滚都追加一条 revision，并在同一个 db.batch() 里同步 FTS，
 *   保证“保存后可搜到、改名/改文后更新、软删不出现”。
 */
import { Hono } from "hono"
import type { Context } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import {
  getPageRow,
  insertPage,
  listChildren,
  listPageRows,
  listSubtreeDeletedRows,
  listSubtreeIds,
  listTrashRoots,
  maxSortOrder,
  permanentDeleteSubtree,
  restoreSubtree,
  softDeleteSubtree,
  updatePageContent,
  updatePagePlacement,
  updatePageSortOrder,
  type PageRow
} from "../db/queries/pages"
import {
  getRevision,
  insertRevision,
  listRevisions
} from "../db/queries/revisions"
import { indexPageStatements } from "../lib/fts"
import {
  sanitizePageHtml,
  MAX_HTML_BYTES,
  MAX_JSON_BYTES,
  MAX_TEXT_BYTES,
  MAX_TITLE_LENGTH
} from "../lib/sanitize"
import { readJsonBody } from "../lib/http"
import type { HonoEnv } from "../types"

export const pageRoutes = new Hono<HonoEnv>()

function toSummary(row: PageRow) {
  return {
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    sortOrder: row.sort_order,
    updatedAt: row.updated_at
  }
}

function toDetail(row: PageRow) {
  return {
    ...toSummary(row),
    contentJson: row.content_json,
    contentHtml: row.content_html,
    contentText: row.content_text,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at
  }
}

function canDestruct(c: Context<HonoEnv>, row: PageRow): boolean {
  return c.get("role") === "admin" || row.created_by === c.get("userId")
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

interface PageInput {
  title: string
  contentJson: string
  contentHtml: string
  contentText: string
}

/** 校验标题与三件套内容的类型/体积；返回错误信息或清洗后的输入。 */
function readPageInput(
  body: Record<string, unknown> | null
): { ok: true; value: PageInput } | { ok: false; error: string } {
  if (!body) return { ok: false, error: "Invalid request body" }
  const { title, contentJson, contentHtml, contentText } = body
  if (typeof title !== "string") return { ok: false, error: "Title required" }
  const trimmed = title.trim()
  if (!trimmed || trimmed.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: "Title must be 1-255 characters" }
  }
  for (const [field, value, limit] of [
    ["contentJson", contentJson, MAX_JSON_BYTES],
    ["contentHtml", contentHtml, MAX_HTML_BYTES],
    ["contentText", contentText, MAX_TEXT_BYTES]
  ] as const) {
    if (typeof value !== "string") {
      return { ok: false, error: `${field} required` }
    }
    if (utf8Length(value) > limit) {
      return { ok: false, error: "Payload too large" }
    }
  }
  try {
    JSON.parse(contentJson as string)
  } catch {
    return { ok: false, error: "contentJson must be valid JSON" }
  }
  return {
    ok: true,
    value: {
      title: trimmed,
      contentJson: contentJson as string,
      contentHtml: sanitizePageHtml(contentHtml as string),
      contentText: contentText as string
    }
  }
}

function newRevision(
  pageId: string,
  input: PageInput,
  editorId: string,
  createdAt: string
) {
  return {
    id: crypto.randomUUID(),
    page_id: pageId,
    title: input.title,
    content_json: input.contentJson,
    content_html: input.contentHtml,
    content_text: input.contentText,
    editor_id: editorId,
    created_at: createdAt
  }
}

// ── 列表 ────────────────────────────────────────────────────────────────────

pageRoutes.get("/", async (c) => {
  const prefix = getTablePrefix(c.env)
  const rows = await listPageRows(c.env.DB, prefix)
  const nodes = new Map<
    string,
    ReturnType<typeof toSummary> & { children: unknown[] }
  >()
  for (const row of rows) {
    nodes.set(row.id, { ...toSummary(row), children: [] })
  }
  const roots: unknown[] = []
  for (const row of rows) {
    const node = nodes.get(row.id)
    if (!node) continue
    const parent = row.parent_id ? nodes.get(row.parent_id) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return c.json(roots)
})

// 必须注册在 /:id 之前，否则会被当成 id=trash。
pageRoutes.get("/trash", async (c) => {
  const prefix = getTablePrefix(c.env)
  const rows = await listTrashRoots(c.env.DB, prefix)
  return c.json(
    rows.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      title: row.title,
      deletedAt: row.deleted_at,
      updatedAt: row.updated_at
    }))
  )
})

pageRoutes.get("/:id", async (c) => {
  const prefix = getTablePrefix(c.env)
  const row = await getPageRow(c.env.DB, prefix, c.req.param("id"))
  if (!row || row.deleted_at) {
    return c.json({ error: "Page not found" }, 404)
  }
  return c.json(toDetail(row))
})

// ── 写入 ────────────────────────────────────────────────────────────────────

pageRoutes.post("/", async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c)
  const parsed = readPageInput(body)
  if (!parsed.ok) {
    const status = parsed.error === "Payload too large" ? 413 : 400
    return c.json({ error: parsed.error }, status)
  }

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const parentId = body?.parentId ?? null
  if (parentId !== null && typeof parentId !== "string") {
    return c.json({ error: "parentId must be a string or null" }, 400)
  }
  if (parentId) {
    const parent = await getPageRow(db, prefix, parentId)
    if (!parent || parent.deleted_at) {
      return c.json(
        { error: "Parent page is deleted", code: "PARENT_DELETED" },
        409
      )
    }
  }

  const now = new Date().toISOString()
  const userId = c.get("userId")
  const row: PageRow = {
    id: crypto.randomUUID(),
    parent_id: parentId,
    title: parsed.value.title,
    sort_order: await maxSortOrder(db, prefix, parentId),
    content_json: parsed.value.contentJson,
    content_html: parsed.value.contentHtml,
    content_text: parsed.value.contentText,
    created_by: userId,
    updated_by: userId,
    created_at: now,
    updated_at: now,
    deleted_at: null
  }

  await db.batch([
    insertPage(db, prefix, row),
    insertRevision(db, prefix, newRevision(row.id, parsed.value, userId, now)),
    ...indexPageStatements(db, prefix, {
      id: row.id,
      title: row.title,
      contentText: row.content_text
    })
  ])

  return c.json(toDetail(row), 201)
})

pageRoutes.put("/:id", async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c)
  const parsed = readPageInput(body)
  if (!parsed.ok) {
    const status = parsed.error === "Payload too large" ? 413 : 400
    return c.json({ error: parsed.error }, status)
  }

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const existing = await getPageRow(db, prefix, c.req.param("id"))
  if (!existing || existing.deleted_at) {
    return c.json({ error: "Page not found" }, 404)
  }

  const now = new Date().toISOString()
  const userId = c.get("userId")
  await db.batch([
    updatePageContent(db, prefix, {
      id: existing.id,
      title: parsed.value.title,
      content_json: parsed.value.contentJson,
      content_html: parsed.value.contentHtml,
      content_text: parsed.value.contentText,
      updated_by: userId,
      updated_at: now
    }),
    insertRevision(
      db,
      prefix,
      newRevision(existing.id, parsed.value, userId, now)
    ),
    ...indexPageStatements(db, prefix, {
      id: existing.id,
      title: parsed.value.title,
      contentText: parsed.value.contentText
    })
  ])

  return c.json(
    toDetail({
      ...existing,
      title: parsed.value.title,
      content_json: parsed.value.contentJson,
      content_html: parsed.value.contentHtml,
      content_text: parsed.value.contentText,
      updated_by: userId,
      updated_at: now
    })
  )
})

pageRoutes.post("/:id/move", async (c) => {
  const body = await readJsonBody<{
    parentId?: string | null
    sortOrder?: number
  }>(c)
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const page = await getPageRow(db, prefix, c.req.param("id"))
  if (!page || page.deleted_at) {
    return c.json({ error: "Page not found" }, 404)
  }

  const parentId = body?.parentId === undefined ? page.parent_id : body.parentId
  if (parentId !== null) {
    if (typeof parentId !== "string") {
      return c.json({ error: "parentId must be a string or null" }, 400)
    }
    const parent = await getPageRow(db, prefix, parentId)
    if (!parent || parent.deleted_at) {
      return c.json(
        { error: "Parent page is deleted", code: "PARENT_DELETED" },
        409
      )
    }
    const subtree = await listSubtreeIds(db, prefix, page.id)
    if (subtree.includes(parentId)) {
      return c.json(
        {
          error: "Cannot move a page into its own subtree",
          code: "PAGE_MOVE_CYCLE"
        },
        409
      )
    }
  }

  const siblings = (await listChildren(db, prefix, parentId)).filter(
    (row) => row.id !== page.id
  )
  const requested =
    typeof body?.sortOrder === "number" && Number.isFinite(body.sortOrder)
      ? Math.trunc(body.sortOrder)
      : siblings.length
  const index = Math.min(Math.max(requested, 0), siblings.length)
  siblings.splice(index, 0, page)

  const now = new Date().toISOString()
  const statements = [
    updatePagePlacement(db, prefix, page.id, parentId, index, now)
  ]
  siblings.forEach((row, order) => {
    if (row.sort_order !== order) {
      statements.push(updatePageSortOrder(db, prefix, row.id, order))
    }
  })
  if (page.parent_id !== parentId) {
    const oldSiblings = await listChildren(db, prefix, page.parent_id)
    oldSiblings
      .filter((row) => row.id !== page.id)
      .forEach((row, order) => {
        if (row.sort_order !== order) {
          statements.push(updatePageSortOrder(db, prefix, row.id, order))
        }
      })
  }
  await db.batch(statements)

  return c.json({ success: true })
})

// ── 删除 / 恢复 ─────────────────────────────────────────────────────────────

pageRoutes.delete("/:id", async (c) => {
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const page = await getPageRow(db, prefix, c.req.param("id"))
  if (!page || page.deleted_at) {
    return c.json({ error: "Page not found" }, 404)
  }
  if (!canDestruct(c, page)) {
    return c.json({ error: "Forbidden" }, 403)
  }

  const now = new Date().toISOString()
  await db.batch(softDeleteSubtree(db, prefix, page.id, now))
  return c.json({ success: true })
})

pageRoutes.post("/:id/restore", async (c) => {
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const page = await getPageRow(db, prefix, c.req.param("id"))
  if (!page?.deleted_at) {
    return c.json({ error: "Page not found" }, 404)
  }
  if (!canDestruct(c, page)) {
    return c.json({ error: "Forbidden" }, 403)
  }
  if (page.parent_id) {
    const parent = await getPageRow(db, prefix, page.parent_id)
    if (parent?.deleted_at) {
      return c.json(
        { error: "Restore the parent page first", code: "PARENT_DELETED" },
        409
      )
    }
  }

  const rows = await listSubtreeDeletedRows(
    db,
    prefix,
    page.id,
    page.deleted_at
  )
  const now = new Date().toISOString()
  await db.batch([
    ...restoreSubtree(db, prefix, page.id, page.deleted_at, now),
    ...rows.flatMap((row) =>
      indexPageStatements(db, prefix, {
        id: row.id,
        title: row.title,
        contentText: row.content_text
      })
    )
  ])
  return c.json({ success: true })
})

pageRoutes.delete("/:id/permanent", async (c) => {
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const page = await getPageRow(db, prefix, c.req.param("id"))
  if (!page) return c.json({ error: "Page not found" }, 404)
  if (!canDestruct(c, page)) {
    return c.json({ error: "Forbidden" }, 403)
  }
  if (!page.deleted_at) {
    return c.json(
      { error: "Page is not in trash", code: "PAGE_NOT_DELETED" },
      409
    )
  }
  await db.batch(permanentDeleteSubtree(db, prefix, page.id))
  return c.json({ success: true })
})

// ── 版本 ────────────────────────────────────────────────────────────────────

pageRoutes.get("/:id/revisions", async (c) => {
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const page = await getPageRow(db, prefix, c.req.param("id"))
  if (!page) return c.json({ error: "Page not found" }, 404)
  const rows = await listRevisions(db, prefix, page.id)
  return c.json(
    rows.map((row) => ({
      id: row.id,
      title: row.title,
      editorId: row.editor_id,
      createdAt: row.created_at
    }))
  )
})

pageRoutes.get("/:id/revisions/:revisionId", async (c) => {
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const page = await getPageRow(db, prefix, c.req.param("id"))
  if (!page) return c.json({ error: "Page not found" }, 404)
  const revision = await getRevision(
    db,
    prefix,
    page.id,
    c.req.param("revisionId")
  )
  if (!revision) return c.json({ error: "Revision not found" }, 404)
  return c.json({
    id: revision.id,
    pageId: revision.page_id,
    title: revision.title,
    contentJson: revision.content_json,
    contentHtml: revision.content_html,
    contentText: revision.content_text,
    editorId: revision.editor_id,
    createdAt: revision.created_at
  })
})

pageRoutes.post("/:id/revisions/:revisionId/restore", async (c) => {
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const page = await getPageRow(db, prefix, c.req.param("id"))
  if (!page || page.deleted_at) {
    return c.json({ error: "Page not found" }, 404)
  }
  if (!canDestruct(c, page)) {
    return c.json({ error: "Forbidden" }, 403)
  }
  const revision = await getRevision(
    db,
    prefix,
    page.id,
    c.req.param("revisionId")
  )
  if (!revision) return c.json({ error: "Revision not found" }, 404)

  const now = new Date().toISOString()
  const userId = c.get("userId")
  const input: PageInput = {
    title: revision.title,
    contentJson: revision.content_json,
    contentHtml: sanitizePageHtml(revision.content_html),
    contentText: revision.content_text
  }
  await db.batch([
    updatePageContent(db, prefix, {
      id: page.id,
      title: input.title,
      content_json: input.contentJson,
      content_html: input.contentHtml,
      content_text: input.contentText,
      updated_by: userId,
      updated_at: now
    }),
    insertRevision(db, prefix, newRevision(page.id, input, userId, now)),
    ...indexPageStatements(db, prefix, {
      id: page.id,
      title: input.title,
      contentText: input.contentText
    })
  ])

  return c.json(
    toDetail({
      ...page,
      title: input.title,
      content_json: input.contentJson,
      content_html: input.contentHtml,
      content_text: input.contentText,
      updated_by: userId,
      updated_at: now
    })
  )
})
