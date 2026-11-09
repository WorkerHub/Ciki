/**
 * 导入接口（规格 §12.1）：给 Confluence 插件用的端点，鉴权只认个人导入令牌
 * （`Authorization: Bearer`，见 middleware/import-token.ts）。
 *
 * 空间（规格「Ciki Space」）：令牌只能操作其所属用户具备 `editor` 及以上角色的
 * 空间；`space_id` 缺省落默认空间。对无权空间明确回 403（插件需要提示用户），
 * 而不是按不存在隐藏——这是导入入口与页面直链 404 口径的唯一差别。
 *
 * - 只收插件上传的字节，**不做任何服务端外抓**（不收 URL 让服务端去下载），
 *   SSRF 面为零。
 * - 渲染/消毒/写入全部复用既有管线：TipTap JSON → `lib/tiptap-html.ts` 原生渲染
 *   → `lib/sanitize.ts` 服务端二次消毒 → `core/page-write.ts` 的页面+revision+FTS
 *   同批写。导入的 `contentJson` 与编辑器保存的完全同一条路径。
 */
import { Hono } from "hono"
import type { Context } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import {
  findSiblingByTitle,
  getPageRow,
  listPageRows
} from "../db/queries/pages"
import {
  findDefaultSpace,
  findSpaceById,
  listAllSpaces,
  listEditableSpaces
} from "../db/queries/spaces"
import { normalizeImportedContent } from "../lib/page-input"
import { handleImageUpload } from "../lib/upload"
import { createPage, savePageContent } from "../core/page-write"
import { canEditPages, resolveSpaceRole } from "../core/space-access"
import { importTokenMiddleware } from "../middleware/import-token"
import { readJsonBody, readParentId, readSpaceId } from "../lib/http"
import { MAX_TITLE_LENGTH, toPlainText } from "../lib/sanitize"
import type { HonoEnv } from "../types"

export const importRoutes = new Hono<HonoEnv>()

// 整段只认 Bearer 令牌：会话 Cookie 在这里无效（职责分离，见中间件注释）。
importRoutes.use("*", importTokenMiddleware)

type ImportSpace =
  | { ok: true; spaceId: string }
  | { ok: false; response: Response }

/** 解析 space_id（缺省 = 默认空间），并校验令牌用户对该空间有编辑权。 */
async function resolveImportSpace(
  c: Context<HonoEnv>,
  raw: unknown
): Promise<ImportSpace> {
  const parsed = readSpaceId(raw)
  if (!parsed.ok) {
    return {
      ok: false,
      response: c.json({ error: "space_id must be a string" }, 400)
    }
  }

  const prefix = getTablePrefix(c.env)
  let spaceId = parsed.value
  if (!spaceId) {
    const fallback = await findDefaultSpace(c.env.DB, prefix)
    if (!fallback) {
      return {
        ok: false,
        response: c.json(
          { error: "Default space missing", code: "DEFAULT_SPACE_MISSING" },
          409
        )
      }
    }
    spaceId = fallback.id
  }

  const space = await findSpaceById(c.env.DB, prefix, spaceId)
  if (!space) {
    return {
      ok: false,
      response: c.json(
        { error: "Space not found", code: "SPACE_NOT_FOUND" },
        404
      )
    }
  }

  const role = await resolveSpaceRole(
    c.env.DB,
    prefix,
    spaceId,
    c.get("userId"),
    c.get("role") === "admin"
  )
  if (!canEditPages(role)) {
    return {
      ok: false,
      response: c.json(
        { error: "Space forbidden", code: "SPACE_FORBIDDEN" },
        403
      )
    }
  }
  return { ok: true, spaceId }
}

/** GET /api/import/spaces：令牌用户可编辑（admin/editor）的空间，默认空间在前。 */
importRoutes.get("/spaces", async (c) => {
  const prefix = getTablePrefix(c.env)
  const spaces =
    c.get("role") === "admin"
      ? await listAllSpaces(c.env.DB, prefix)
      : await listEditableSpaces(c.env.DB, prefix, c.get("userId"))
  return c.json(spaces.map((space) => ({ id: space.id, name: space.name })))
})

/** GET /api/import/parents：未删页面的扁平摘要，插件据此选父页。 */
importRoutes.get("/parents", async (c) => {
  const space = await resolveImportSpace(c, c.req.query("space_id"))
  if (!space.ok) return space.response

  const prefix = getTablePrefix(c.env)
  const rows = await listPageRows(c.env.DB, prefix, space.spaceId)
  return c.json(
    rows.map((row) => ({
      id: row.id,
      title: row.title,
      parentId: row.parent_id
    }))
  )
})

/** POST /api/import/check：同空间同父级下是否已有同名页。 */
importRoutes.post("/check", async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c)
  if (typeof body?.title !== "string") {
    return c.json({ error: "Title required" }, 400)
  }
  // 与保存口径一致：标题按纯文本规范化后必须 1–255 字符。
  const title = toPlainText(body.title)
  if (!title || title.length > MAX_TITLE_LENGTH) {
    return c.json({ error: "Title must be 1-255 characters" }, 400)
  }
  const parent = readParentId(body.parentId)
  if (!parent.ok) {
    return c.json({ error: "parentId must be a string or null" }, 400)
  }

  const space = await resolveImportSpace(c, body.space_id)
  if (!space.ok) return space.response

  const prefix = getTablePrefix(c.env)
  const existing = await findSiblingByTitle(
    c.env.DB,
    prefix,
    space.spaceId,
    parent.value,
    title
  )
  return c.json(
    existing ? { exists: true, pageId: existing.id } : { exists: false }
  )
})

/**
 * POST /api/import/files：multipart 单文件。
 * 校验与 R2 落盘复用 /api/files 的同一份实现（lib/upload.ts），响应也同一形状。
 */
importRoutes.post("/files", (c) =>
  handleImageUpload(c, c.get("userId"), "imports")
)

/**
 * POST /api/import/pages：新建或更新页面。
 *
 * - `conflict:"update"`：同空间同父级同名未删页 → 覆盖内容并追加 revision（与
 *   正常保存同一路径）；内容与现存行全等时同一条路径上的空操作——不写行、不新增
 *   revision，响应仍为 200 `{pageId,url}`。不存在则新建。`create_copy`：总是新建，
 *   不改写标题。
 * - `space_id` 可选：缺省落默认空间；父页必须属于目标空间。
 * - 服务端从 contentJson 渲染 HTML 后再消毒，消毒结果为准。
 */
importRoutes.post("/pages", async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c)

  // 先做便宜的参数校验，再付渲染成本。
  const conflict = body?.conflict
  if (conflict !== "update" && conflict !== "create_copy") {
    return c.json({ error: 'conflict must be "update" or "create_copy"' }, 400)
  }
  const parent = readParentId(body?.parentId)
  if (!parent.ok) {
    return c.json({ error: "parentId must be a string or null" }, 400)
  }
  const parentId = parent.value

  const parsed = normalizeImportedContent({
    title: body?.title,
    contentJson: body?.contentJson
  })
  if (!parsed.ok) {
    const status = parsed.code === "PAYLOAD_TOO_LARGE" ? 413 : 400
    return c.json(
      { error: parsed.error, ...(parsed.code ? { code: parsed.code } : {}) },
      status
    )
  }

  const space = await resolveImportSpace(c, body?.space_id)
  if (!space.ok) return space.response

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const userId = c.get("userId")
  if (parentId) {
    const parentRow = await getPageRow(db, prefix, parentId)
    if (!parentRow) {
      return c.json(
        { error: "Parent page is deleted", code: "PARENT_DELETED" },
        409
      )
    }
    // 令牌用户看不见的父页按不存在处理，不泄露它属于哪个空间。
    const parentRole = await resolveSpaceRole(
      db,
      prefix,
      parentRow.space_id,
      userId,
      c.get("role") === "admin"
    )
    if (!parentRole) return c.json({ error: "Page not found" }, 404)
    if (parentRow.deleted_at) {
      return c.json(
        { error: "Parent page is deleted", code: "PARENT_DELETED" },
        409
      )
    }
    if (parentRow.space_id !== space.spaceId) {
      return c.json(
        { error: "Parent page is in another space", code: "SPACE_MISMATCH" },
        409
      )
    }
  }

  const now = new Date().toISOString()

  if (conflict === "update") {
    const existing = await findSiblingByTitle(
      db,
      prefix,
      space.spaceId,
      parentId,
      parsed.value.title
    )
    if (existing) {
      await savePageContent(db, prefix, existing, {
        content: parsed.value,
        userId,
        now
      })
      return c.json({ pageId: existing.id, url: `/p/${existing.id}` })
    }
  }

  const row = await createPage(db, prefix, {
    spaceId: space.spaceId,
    parentId,
    content: parsed.value,
    userId,
    now
  })
  return c.json({ pageId: row.id, url: `/p/${row.id}` }, 201)
})
