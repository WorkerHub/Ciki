/**
 * 页面：树、详情、新建、保存、移动、软删/恢复/彻底删、版本与回滚。
 *
 * 权限以空间角色为准（规格「Ciki Space」）：`editor` 及以上可新建/编辑/移动/
 * 删除/恢复/回滚，`viewer` 只读；非成员访问页面一律按不存在处理（404），
 * 不泄露该空间的存在性。站点管理员不受成员表限制。
 *
 * id 一律是整数（`/p/<id>` 的同一套数字）；旧的 UUID 地址不再识别，按不存在回 404。
 *
 * 正文分工（规格「读写路径」）：读页 HTML / MD 下载只读 D1 的派生件，热路径不碰 R2；
 * 编辑器要的 JSON 走 `GET /api/pages/:id?format=json`，按 `content_hash` 从内容桶取。
 *
 * - 页面父子关系只能在同一空间内；跨空间移动通过 move 的可选 `spaceId` 完成，
 *   未指定父页时挂到目标空间根。
 * - 新建/保存/有实际改动时追加一条版本，并在同一个 db.batch() 里同步 FTS；
 *   内容与现存行全等的保存是空操作（不写行、不上传对象、不追加版本）。
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
  updateSubtreeSpace,
  type PageRow,
  type PageSummaryRow
} from "../db/queries/pages"
import { findDefaultSpace } from "../db/queries/spaces"
import {
  deleteRevision,
  getRevision,
  latestVersionNo,
  listRevisions,
  trimPageRevisionStatement
} from "../db/queries/revisions"
import {
  canEditPages,
  resolveSpaceAccess,
  resolveSpaceRole,
  type SpaceRole
} from "../core/space-access"
import { readContent } from "../core/content-store"
import { indexPageStatements } from "../lib/fts"
import { parseId, readJsonBody, readParentId, readSpaceId } from "../lib/http"
import {
  cleanPageFilename,
  contentDisposition,
  imageEntryNames,
  imageLink,
  markdownDocument,
  rewriteSiteImageLinks,
  siteImageKeys
} from "../lib/markdown-download"
import { normalizePageInput, type PageContentResult } from "../lib/page-input"
import { zipStream } from "../lib/zip-stream"
import { createPage, savePageContent } from "../core/page-write"
import {
  revisionContent,
  type RevisionContentResult
} from "../lib/revision-content"
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

/**
 * 页面详情。
 *
 * **不含正文 JSON**：阅读页只吃 HTML / 纯文本 / MD（派生物，D1 里就有），
 * 打开编辑器或要原文时加 `?format=json` 走 R2。
 */
function toDetail(row: PageRow) {
  return {
    ...toSummary(row),
    spaceId: row.space_id,
    contentHtml: row.content_html,
    contentText: row.content_text,
    contentMd: row.content_md,
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

/** 正文取不到（对象被误删/内容桶不可用/字节坏）：明确 5xx，不把空正文当成正常结果。 */
function contentUnavailable(c: Context<HonoEnv>) {
  return c.json(
    { error: "Page content unavailable", code: "CONTENT_MISSING" },
    500
  )
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

/**
 * 版本正文取不出来的两种口径（查看与回滚共用）：
 * 正文取不到（对象缺失/内容桶不可用/字节坏）→ 500 `CONTENT_MISSING`，与阅读接口同一口径；
 * 正文取到了但渲染不了 → 422 `REVISION_UNRENDERABLE`。
 */
function revisionContentFailed(
  c: Context<HonoEnv>,
  result: Extract<RevisionContentResult, { ok: false }>
) {
  if (result.kind === "unavailable") return contentUnavailable(c)
  return unrenderableRevision(c, result.error)
}

/** 版本的 JSON 能取到、但无法按当前编辑器 schema 渲染 → 422（查看与回滚同一口径）。 */
function unrenderableRevision(c: Context<HonoEnv>, reason: string) {
  return c.json(
    {
      error: `Revision content cannot be rendered: ${reason}`,
      code: "REVISION_UNRENDERABLE"
    },
    422
  )
}

type SpaceTarget =
  | { ok: true; spaceId: number; role: SpaceRole }
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
      response: c.json({ error: "spaceId must be an integer or null" }, 400)
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
    number,
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

/**
 * 下载 .md（规格 v1.0）：按页面 MD 里有没有**站内图**自动分流。
 *
 * - 无站内图 → 与一期前端产物逐字节一致的 `.md`；
 * - 有站内图 → zip 包：根目录 `<标题>.md` + `images/<basename>`。图从 R2 按 key
 *   直读、逐块流式入包（不读整图），MD 里的站内图链接改写成 `images/<basename>`。
 *
 * 存储版 `content_md` 一字不动（相对化只发生在组装 zip 时）；站外图不抓取、不改写；
 * R2 里已不存在的图不入包、其链接保留原绝对地址，不因个别缺图让整包失败。
 *
 * 权限与 `GET /:id` 同一口径：非成员、页面不存在、已软删一律 404（不泄露空间存在性）。
 */
pageRoutes.get("/:id/download", async (c) => {
  const prefix = getTablePrefix(c.env)
  const id = parseId(c.req.param("id"))
  if (id === null) return pageNotFound(c)
  const row = await getPageRow(c.env.DB, prefix, id)
  if (!row || row.deleted_at) return pageNotFound(c)

  const role = await pageSpaceRole(c, row)
  if (!role) return pageNotFound(c)

  const document = markdownDocument({
    title: row.title,
    contentMd: row.content_md
  })
  const name = cleanPageFilename(row.title)
  const keys = siteImageKeys(document)

  if (keys.length === 0) {
    return new Response(document, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": contentDisposition(name, ".md")
      }
    })
  }

  const entries = imageEntryNames(keys)
  // 真的进了包的图：R2 里已经没有的（孤儿清理过）不入包，链接也保持绝对地址。
  const included = new Set<string>()
  const body = zipStream(async (zip) => {
    // 图在前、MD 在后：包内 MD 要按「哪些图真的取到了」决定改写哪些链接，
    // 取不到的图必须原样保留绝对地址，所以它的字节只能最后写。
    for (const key of keys) {
      const object = await c.env.R2.get(key)
      if (!object) continue
      included.add(key)
      await zip.addBinary(imageLink(entries.get(key)!), object.body)
    }
    const markdown = rewriteSiteImageLinks(document, (key) => {
      const entry = entries.get(key)
      return entry && included.has(key) ? entry : null
    })
    await zip.addText(`${name}.md`, markdown)
  })

  return new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(name, ".zip")
    }
  })
})

pageRoutes.get("/:id", async (c) => {
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const id = parseId(c.req.param("id"))
  if (id === null) return pageNotFound(c)
  const row = await getPageRow(db, prefix, id)
  if (!row || row.deleted_at) return pageNotFound(c)

  const role = await pageSpaceRole(c, row)
  if (!role) return pageNotFound(c)

  // `?format=json`：编辑器/外部调用要原文，按 content_hash 从内容桶取（热路径不走这里）。
  if (c.req.query("format") === "json") {
    let contentJson: string
    try {
      contentJson = await readContent(c.env, row.content_hash)
    } catch {
      return contentUnavailable(c)
    }
    return c.json({ ...toDetail(row), contentJson })
  }
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
    return c.json({ error: "parentId must be an integer or null" }, 400)
  }
  const requestedSpace = readSpaceId(body?.spaceId)
  if (!requestedSpace.ok) {
    return c.json({ error: "spaceId must be an integer or null" }, 400)
  }

  let spaceId: number
  const parentId = parent.value
  if (parentId !== null) {
    const parentRow = await getPageRow(db, prefix, parentId)
    if (!parentRow) {
      return c.json(
        { error: "Parent page is deleted", code: "PARENT_DELETED" },
        409
      )
    }
    // 先判权再判空间是否一致：非成员连“父页存在”都不能探测到。
    const role = await pageSpaceRole(c, parentRow)
    if (!role) return pageNotFound(c)
    if (!canEditPages(role)) return forbidden(c)
    if (parentRow.deleted_at) {
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
    spaceId = parentRow.space_id
  } else {
    const target = await spaceTarget(c, body?.spaceId)
    if (!target.ok) return target.response
    if (!canEditPages(target.role)) return forbidden(c)
    spaceId = target.spaceId
  }

  const row = await createPage(c.env, prefix, {
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
  const id = parseId(c.req.param("id"))
  if (id === null) return pageNotFound(c)
  const existing = await getPageRow(db, prefix, id)
  if (!existing || existing.deleted_at) return pageNotFound(c)

  const role = await pageSpaceRole(c, existing)
  if (!role) return pageNotFound(c)
  if (!canEditPages(role)) return forbidden(c)

  const saved = await savePageContent(c.env, prefix, existing, {
    content: parsed.value,
    userId: c.get("userId"),
    now: new Date().toISOString()
  })
  return c.json(toDetail(saved))
})

pageRoutes.post("/:id/move", async (c) => {
  const body = await readJsonBody<{
    parentId?: unknown
    sortOrder?: number
    spaceId?: unknown
  }>(c)
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const id = parseId(c.req.param("id"))
  if (id === null) return pageNotFound(c)
  const page = await getPageRow(db, prefix, id)
  if (!page || page.deleted_at) return pageNotFound(c)

  const sourceRole = await pageSpaceRole(c, page)
  if (!sourceRole) return pageNotFound(c)
  if (!canEditPages(sourceRole)) return forbidden(c)

  // move 的 spaceId 缺省是「当前页面所在空间」，不是默认空间。
  const requestedSpace = readSpaceId(body?.spaceId)
  if (!requestedSpace.ok) {
    return c.json({ error: "spaceId must be an integer or null" }, 400)
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
    return c.json({ error: "parentId must be an integer or null" }, 400)
  }
  const parentId = parent.value
  if (parentId !== null) {
    const parentRow = await getPageRow(db, prefix, parentId)
    if (!parentRow) {
      return c.json(
        { error: "Parent page is deleted", code: "PARENT_DELETED" },
        409
      )
    }
    // 同一条口径：看不见的父页按不存在处理，不泄露它属于哪个空间。
    const parentRole = await pageSpaceRole(c, parentRow)
    if (!parentRole) return pageNotFound(c)
    if (parentRow.deleted_at) {
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
  const statements = []
  // 跨空间移动必须连同整棵后代子树一起改 space_id，否则父子会跨空间。
  if (page.space_id !== targetSpaceId) {
    statements.push(updateSubtreeSpace(db, prefix, page.id, targetSpaceId))
  }
  statements.push(
    updatePagePlacement(
      db,
      prefix,
      page.id,
      targetSpaceId,
      parentId,
      index,
      now
    )
  )
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
  const id = parseId(c.req.param("id"))
  if (id === null) return pageNotFound(c)
  const page = await getPageRow(db, prefix, id)
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
  const id = parseId(c.req.param("id"))
  if (id === null) return pageNotFound(c)
  const page = await getPageRow(db, prefix, id)
  if (!page?.deleted_at) return pageNotFound(c)

  const role = await pageSpaceRole(c, page)
  if (!role) return pageNotFound(c)
  if (!canEditPages(role)) return forbidden(c)

  if (page.parent_id !== null) {
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
  const id = parseId(c.req.param("id"))
  if (id === null) return pageNotFound(c)
  const page = await getPageRow(db, prefix, id)
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
  const id = parseId(c.req.param("id"))
  if (id === null) return pageNotFound(c)
  const page = await getPageRow(db, prefix, id)
  if (!page) return pageNotFound(c)

  const role = await pageSpaceRole(c, page)
  if (!role) return pageNotFound(c)

  const rows = await listRevisions(db, prefix, page.id)
  return c.json(
    rows.map((row) => ({
      versionNo: row.version_no,
      title: row.title,
      editorId: row.editor_id,
      createdAt: row.created_at
    }))
  )
})

pageRoutes.get("/:id/revisions/:versionNo", async (c) => {
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const id = parseId(c.req.param("id"))
  const versionNo = parseId(c.req.param("versionNo"))
  if (id === null || versionNo === null) return pageNotFound(c)
  const page = await getPageRow(db, prefix, id)
  if (!page) return pageNotFound(c)

  const role = await pageSpaceRole(c, page)
  if (!role) return pageNotFound(c)

  const revision = await getRevision(db, prefix, page.id, versionNo)
  if (!revision) return c.json({ error: "Revision not found" }, 404)

  // 版本行只有 JSON 指针，HTML/纯文本在这里按需生成。
  const content = await revisionContent(c.env, revision)
  if (!content.ok) return revisionContentFailed(c, content)
  return c.json({
    versionNo: revision.version_no,
    pageId: revision.page_id,
    title: revision.title,
    contentJson: content.value.contentJson,
    contentHtml: content.value.contentHtml,
    contentText: content.value.contentText,
    editorId: revision.editor_id,
    createdAt: revision.created_at
  })
})

pageRoutes.post("/:id/revisions/:versionNo/restore", async (c) => {
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const id = parseId(c.req.param("id"))
  const versionNo = parseId(c.req.param("versionNo"))
  if (id === null || versionNo === null) return pageNotFound(c)
  const page = await getPageRow(db, prefix, id)
  if (!page || page.deleted_at) return pageNotFound(c)

  const role = await pageSpaceRole(c, page)
  if (!role) return pageNotFound(c)
  if (!canEditPages(role)) return forbidden(c)

  const revision = await getRevision(db, prefix, page.id, versionNo)
  if (!revision) return c.json({ error: "Revision not found" }, 404)

  const content = await revisionContent(c.env, revision)
  if (!content.ok) return revisionContentFailed(c, content)

  // 回滚写回同一份内容：哈希不变（同对象复用，不复制字节），只追加一条新版本。
  const saved = await savePageContent(c.env, prefix, page, {
    content: content.value,
    userId: c.get("userId"),
    now: new Date().toISOString()
  })
  return c.json(toDetail(saved))
})

/**
 * 删一条历史版本（按「第 N 版」寻址）。
 *
 * 权限与回滚同档（`canEditPages`）——只读成员连入口带接口一起掉；非成员按不存在处
 * 理（404，不泄露该页属于哪个空间）。每页最新一条是当前内容的快照，一律拒删。
 * 删的只是版本行：`pages` 当前内容、FTS、内容对象都不动（孤儿对象归月度 GC 判定）。
 */
pageRoutes.delete("/:id/revisions/:versionNo", async (c) => {
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const id = parseId(c.req.param("id"))
  const versionNo = parseId(c.req.param("versionNo"))
  if (id === null || versionNo === null) return pageNotFound(c)
  const page = await getPageRow(db, prefix, id)
  if (!page || page.deleted_at) return pageNotFound(c)

  const role = await pageSpaceRole(c, page)
  if (!role) return pageNotFound(c)
  if (!canEditPages(role)) return forbidden(c)

  // 「最新一条不许删」写在 DELETE 自己的 WHERE 里（见 deleteRevision）：不存在先读后写的
  // 时间窗，并发保存/回滚也删不到刚写进去的那条。删 0 行才回头查一次，只为在 409
  // 与 404 之间选一个准确答复。
  const deleted = await deleteRevision(db, prefix, page.id, versionNo)
  if (deleted > 0) return c.json({ success: true })

  const latest = await latestVersionNo(db, prefix, page.id)
  if (latest === versionNo) {
    return c.json(
      {
        error: "Cannot delete the latest revision",
        code: "REVISION_IS_LATEST"
      },
      409
    )
  }
  return c.json({ error: "Revision not found" }, 404)
})

/**
 * 按页批量删版本：只留最新一条，其余全删（与保留数同一套排序口径）。
 */
pageRoutes.post("/:id/revisions/prune", async (c) => {
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const id = parseId(c.req.param("id"))
  if (id === null) return pageNotFound(c)
  const page = await getPageRow(db, prefix, id)
  if (!page || page.deleted_at) return pageNotFound(c)

  const role = await pageSpaceRole(c, page)
  if (!role) return pageNotFound(c)
  if (!canEditPages(role)) return forbidden(c)

  const result = await trimPageRevisionStatement(db, prefix, page.id, 1).run()
  return c.json({ deleted: result.meta.changes })
})
