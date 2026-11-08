/**
 * 页面：树、详情、新建、保存、移动、软删/恢复/彻底删、版本与回滚。
 *
 * 权限以空间角色为准（规格「Ciki Space」）：`editor` 及以上可新建/编辑/移动/
 * 删除/恢复/回滚，`viewer` 只读；非成员访问页面一律按不存在处理（404），
 * 不泄露该空间的存在性。站点管理员不受成员表限制。
 *
 * - 页面父子关系只能在同一空间内；跨空间移动通过 move 的可选 `spaceId` 完成，
 *   未指定父页时挂到目标空间根。
 * - 每次新建/保存/回滚都追加一条 revision，并在同一个 db.batch() 里同步 FTS。
 */
import { Hono } from "hono"
import type { Context } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import {
  getPageRow,
  listChildren,
  listPageRows,
  listSubtreeDeletedRows,
  listSubtreeIds,
  listTrashRoots,
  permanentDeleteSubtree,
  restoreSubtree,
  softDeleteSubtree,
  updatePagePlacement,
  updatePageSortOrder,
  type PageRow,
  type PageSummaryRow
} from "../db/queries/pages"
import { findDefaultSpace } from "../db/queries/spaces"
import { getRevision, listRevisions } from "../db/queries/revisions"
import {
  canEditPages,
  resolveSpaceAccess,
  resolveSpaceRole,
  type SpaceRole
} from "../core/space-access"
import { indexPageStatements } from "../lib/fts"
import { sanitizePageHtml, toPlainText } from "../lib/sanitize"
import {
  normalizePageInput,
  type PageContent,
  type PageContentResult
} from "../lib/page-input"
import { createPage, savePageContent } from "../core/page-write"
import { readJsonBody, readParentId, readSpaceId } from "../lib/http"
import type { HonoEnv } from "../types"

export const pageRoutes = new Hono<HonoEnv>()

function toSummary(row: PageSummaryRow) {
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
    spaceId: row.space_id,
    contentJson: row.content_json,
    contentHtml: row.content_html,
    contentText: row.content_text,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at
  }
}

function isSiteAdmin(c: Context<HonoEnv>): boolean {
  return c.get("role") === "admin"
}

function pageNotFound(c: Context<HonoEnv>) {
  return c.json({ error: "Page not found" }, 404)
}

function spaceNotFound(c: Context<HonoEnv>) {
  return c.json({ error: "Space not found", code: "SPACE_NOT_FOUND" }, 404)
}

function forbidden(c: Context<HonoEnv>) {
  return c.json({ error: "Forbidden" }, 403)
}

function defaultSpaceMissing(c: Context<HonoEnv>) {
  return c.json(
    { error: "Default space missing", code: "DEFAULT_SPACE_MISSING" },
    409
  )
}

/** 校验失败 → 契约里的状态码（体积超限 413，其余 400）。 */
function badInput(parsed: Extract<PageContentResult, { ok: false }>) {
  const status = parsed.code === "PAYLOAD_TOO_LARGE" ? 413 : 400
  return {
    status,
    body: {
      error: parsed.error,
      ...(parsed.code ? { code: parsed.code } : {})
    }
  } as const
}

type SpaceTarget =
  | { ok: true; spaceId: string; role: SpaceRole }
  | { ok: false; response: Response }

/** 解析请求里的空间（缺省 = 默认空间），并给出当前用户在该空间的有效角色。 */
async function spaceTarget(
  c: Context<HonoEnv>,
  raw: unknown
): Promise<SpaceTarget> {
  const parsed = readSpaceId(raw)
  if (!parsed.ok) {
    return {
      ok: false,
      response: c.json({ error: "spaceId must be a string or null" }, 400)
    }
  }

  const prefix = getTablePrefix(c.env)
  let spaceId = parsed.value
  if (!spaceId) {
    const fallback = await findDefaultSpace(c.env.DB, prefix)
    if (!fallback) return { ok: false, response: defaultSpaceMissing(c) }
    spaceId = fallback.id
  }

  const access = await resolveSpaceAccess(
    c.env.DB,
    prefix,
    spaceId,
    c.get("userId"),
    isSiteAdmin(c)
  )
  if (!access) return { ok: false, response: spaceNotFound(c) }
  return { ok: true, spaceId, role: access.role }
}

async function pageSpaceRole(
  c: Context<HonoEnv>,
  page: PageRow
): Promise<SpaceRole | null> {
  return resolveSpaceRole(
    c.env.DB,
    getTablePrefix(c.env),
    page.space_id,
    c.get("userId"),
    isSiteAdmin(c)
  )
}

// ── 列表 ────────────────────────────────────────────────────────────────────

pageRoutes.get("/", async (c) => {
  const target = await spaceTarget(c, c.req.query("spaceId"))
  if (!target.ok) return target.response

  const prefix = getTablePrefix(c.env)
  const rows = await listPageRows(c.env.DB, prefix, target.spaceId)
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
  const target = await spaceTarget(c, c.req.query("spaceId"))
  if (!target.ok) return target.response

  const prefix = getTablePrefix(c.env)
  const rows = await listTrashRoots(c.env.DB, prefix, target.spaceId)
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
  const db = c.env.DB
  const row = await getPageRow(db, prefix, c.req.param("id"))
  if (!row || row.deleted_at) return pageNotFound(c)

  const role = await pageSpaceRole(c, row)
  if (!role) return pageNotFound(c)
  return c.json(toDetail(row))
})

// ── 写入 ────────────────────────────────────────────────────────────────────

pageRoutes.post("/", async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c)
  const parsed = normalizePageInput(body)
  if (!parsed.ok) {
    const { status, body: errorBody } = badInput(parsed)
    return c.json(errorBody, status)
  }

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  // 根页 = null；空串/纯空白同样按根页处理，绝不把 "" 写进 parent_id。
  const parent = readParentId(body?.parentId)
  if (!parent.ok) {
    return c.json({ error: "parentId must be a string or null" }, 400)
  }
  const requestedSpace = readSpaceId(body?.spaceId)
  if (!requestedSpace.ok) {
    return c.json({ error: "spaceId must be a string or null" }, 400)
  }

  let spaceId: string
  const parentId = parent.value
  if (parentId) {
    const parentRow = await getPageRow(db, prefix, parentId)
    if (!parentRow || parentRow.deleted_at) {
      return c.json(
        { error: "Parent page is deleted", code: "PARENT_DELETED" },
        409
      )
    }
    if (
      requestedSpace.value !== null &&
      requestedSpace.value !== parentRow.space_id
    ) {
      return c.json(
        {
          error: "Parent page is in another space",
          code: "SPACE_MISMATCH"
        },
        409
      )
    }
    const role = await pageSpaceRole(c, parentRow)
    if (!role) return pageNotFound(c)
    if (!canEditPages(role)) return forbidden(c)
    spaceId = parentRow.space_id
  } else {
    const target = await spaceTarget(c, body?.spaceId)
    if (!target.ok) return target.response
    if (!canEditPages(target.role)) return forbidden(c)
    spaceId = target.spaceId
  }

  const row = await createPage(db, prefix, {
    spaceId,
    parentId,
    content: parsed.value,
    userId: c.get("userId"),
    now: new Date().toISOString()
  })

  return c.json(toDetail(row), 201)
})

pageRoutes.put("/:id", async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c)
  const parsed = normalizePageInput(body)
  if (!parsed.ok) {
    const { status, body: errorBody } = badInput(parsed)
    return c.json(errorBody, status)
  }

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const existing = await getPageRow(db, prefix, c.req.param("id"))
  if (!existing || existing.deleted_at) return pageNotFound(c)

  const role = await pageSpaceRole(c, existing)
  if (!role) return pageNotFound(c)
  if (!canEditPages(role)) return forbidden(c)

  const saved = await savePageContent(db, prefix, existing, {
    content: parsed.value,
    userId: c.get("userId"),
    now: new Date().toISOString()
  })
  return c.json(toDetail(saved))
})

pageRoutes.post("/:id/move", async (c) => {
  const body = await readJsonBody<{
    parentId?: string | null
    sortOrder?: number
    spaceId?: string | null
  }>(c)
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const page = await getPageRow(db, prefix, c.req.param("id"))
  if (!page || page.deleted_at) return pageNotFound(c)

  const sourceRole = await pageSpaceRole(c, page)
  if (!sourceRole) return pageNotFound(c)
  if (!canEditPages(sourceRole)) return forbidden(c)

  // move 的 spaceId 缺省是「当前页面所在空间」，不是默认空间。
  const requestedSpace = readSpaceId(body?.spaceId)
  if (!requestedSpace.ok) {
    return c.json({ error: "spaceId must be a string or null" }, 400)
  }
  const targetSpaceId = requestedSpace.value ?? page.space_id
  const targetAccess = await resolveSpaceAccess(
    c.env.DB,
    prefix,
    targetSpaceId,
    c.get("userId"),
    isSiteAdmin(c)
  )
  if (!targetAccess) return spaceNotFound(c)
  if (!canEditPages(targetAccess.role)) return forbidden(c)

  // 跨空间且未指定父页 → 挂到目标空间根；同空间缺省 → 保持当前父页。
  const rawParent =
    body?.parentId === undefined
      ? targetSpaceId === page.space_id
        ? page.parent_id
        : null
      : body.parentId
  const parent = readParentId(rawParent)
  if (!parent.ok) {
    return c.json({ error: "parentId must be a string or null" }, 400)
  }
  const parentId = parent.value
  if (parentId !== null) {
    const parentRow = await getPageRow(db, prefix, parentId)
    if (!parentRow || parentRow.deleted_at) {
      return c.json(
        { error: "Parent page is deleted", code: "PARENT_DELETED" },
        409
      )
    }
    if (parentRow.space_id !== targetSpaceId) {
      return c.json(
        { error: "Parent page is in another space", code: "SPACE_MISMATCH" },
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

  const siblings = (
    await listChildren(db, prefix, targetSpaceId, parentId)
  ).filter((row) => row.id !== page.id)
  const requested =
    typeof body?.sortOrder === "number" && Number.isFinite(body.sortOrder)
      ? Math.trunc(body.sortOrder)
      : siblings.length
  const index = Math.min(Math.max(requested, 0), siblings.length)
  const ordered = siblings.map((row) => ({ id: row.id, order: row.sort_order }))
  ordered.splice(index, 0, { id: page.id, order: index })

  const now = new Date().toISOString()
  const statements = [
    updatePagePlacement(
      db,
      prefix,
      page.id,
      targetSpaceId,
      parentId,
      index,
      now
    )
  ]
  ordered.forEach((row, order) => {
    if (row.order !== order) {
      statements.push(updatePageSortOrder(db, prefix, row.id, order))
    }
  })
  if (page.parent_id !== parentId || page.space_id !== targetSpaceId) {
    const oldSiblings = await listChildren(
      db,
      prefix,
      page.space_id,
      page.parent_id
    )
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
  if (!page || page.deleted_at) return pageNotFound(c)

  const role = await pageSpaceRole(c, page)
  if (!role) return pageNotFound(c)
  if (!canEditPages(role)) return forbidden(c)

  const now = new Date().toISOString()
  await db.batch(softDeleteSubtree(db, prefix, page.id, now))
  return c.json({ success: true })
})

pageRoutes.post("/:id/restore", async (c) => {
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const page = await getPageRow(db, prefix, c.req.param("id"))
  if (!page?.deleted_at) return pageNotFound(c)

  const role = await pageSpaceRole(c, page)
  if (!role) return pageNotFound(c)
  if (!canEditPages(role)) return forbidden(c)

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
  if (!page) return pageNotFound(c)

  const role = await pageSpaceRole(c, page)
  if (!role) return pageNotFound(c)
  if (!canEditPages(role)) return forbidden(c)

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
  if (!page) return pageNotFound(c)

  const role = await pageSpaceRole(c, page)
  if (!role) return pageNotFound(c)

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
  if (!page) return pageNotFound(c)

  const role = await pageSpaceRole(c, page)
  if (!role) return pageNotFound(c)

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
  if (!page || page.deleted_at) return pageNotFound(c)

  const role = await pageSpaceRole(c, page)
  if (!role) return pageNotFound(c)
  if (!canEditPages(role)) return forbidden(c)

  const revision = await getRevision(
    db,
    prefix,
    page.id,
    c.req.param("revisionId")
  )
  if (!revision) return c.json({ error: "Revision not found" }, 404)

  const content: PageContent = {
    title: toPlainText(revision.title),
    contentJson: revision.content_json,
    contentHtml: sanitizePageHtml(revision.content_html),
    contentText: toPlainText(revision.content_text)
  }
  const saved = await savePageContent(db, prefix, page, {
    content,
    userId: c.get("userId"),
    now: new Date().toISOString()
  })
  return c.json(toDetail(saved))
})
