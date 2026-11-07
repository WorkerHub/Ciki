/**
 * 导入接口（规格 §12.1）：给 Confluence 插件用的四个端点，鉴权只认个人导入令牌
 * （`Authorization: Bearer`，见 middleware/import-token.ts）。
 *
 * - 只收插件上传的字节，**不做任何服务端外抓**（不收 URL 让服务端去下载），
 *   SSRF 面为零。
 * - 渲染/消毒/写入全部复用既有管线：TipTap JSON → `lib/tiptap-html.ts` 原生渲染
 *   → `lib/sanitize.ts` 服务端二次消毒 → `core/page-write.ts` 的页面+revision+FTS
 *   同批写。导入的 `contentJson` 与编辑器保存的完全同一条路径。
 */
import { Hono } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import {
  findSiblingByTitle,
  getPageRow,
  listPageRows
} from "../db/queries/pages"
import { normalizeImportedContent } from "../lib/page-input"
import { handleImageUpload } from "../lib/upload"
import { createPage, savePageContent } from "../core/page-write"
import { importTokenMiddleware } from "../middleware/import-token"
import { readJsonBody } from "../lib/http"
import { toPlainText } from "../lib/sanitize"
import type { HonoEnv } from "../types"

export const importRoutes = new Hono<HonoEnv>()

// 整段只认 Bearer 令牌：会话 Cookie 在这里无效（职责分离，见中间件注释）。
importRoutes.use("*", importTokenMiddleware)

/** GET /api/import/parents：未删页面的扁平摘要，插件据此选父页。 */
importRoutes.get("/parents", async (c) => {
  const prefix = getTablePrefix(c.env)
  const rows = await listPageRows(c.env.DB, prefix)
  return c.json(
    rows.map((row) => ({
      id: row.id,
      title: row.title,
      parentId: row.parent_id
    }))
  )
})

/** POST /api/import/check：同父级下是否已有同名页（用于决定 update / create_copy）。 */
importRoutes.post("/check", async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c)
  if (typeof body?.title !== "string") {
    return c.json({ error: "Title required" }, 400)
  }
  const title = toPlainText(body.title)
  if (!title) {
    return c.json({ error: "Title must be 1-255 characters" }, 400)
  }
  const parentId = body.parentId ?? null
  if (parentId !== null && typeof parentId !== "string") {
    return c.json({ error: "parentId must be a string or null" }, 400)
  }

  const prefix = getTablePrefix(c.env)
  const existing = await findSiblingByTitle(c.env.DB, prefix, parentId, title)
  return c.json(
    existing ? { exists: true, pageId: existing.id } : { exists: false }
  )
})

/**
 * POST /api/import/files：multipart 单文件。
 * 校验与 R2 落盘复用 /api/files 的同一份实现（lib/upload.ts），响应也同一形状。
 */
importRoutes.post("/files", (c) => handleImageUpload(c, c.get("userId")))

/**
 * POST /api/import/pages：新建或更新页面。
 *
 * - `conflict:"update"`：同父级同名未删页 → 覆盖内容并追加 revision（与正常保存
 *   同一路径）；不存在则新建。`create_copy`：总是新建，不改写标题。
 * - 服务端从 contentJson 渲染 HTML 后再消毒，消毒结果为准。
 */
importRoutes.post("/pages", async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c)

  // 先做便宜的参数校验，再付渲染成本。
  const conflict = body?.conflict
  if (conflict !== "update" && conflict !== "create_copy") {
    return c.json({ error: 'conflict must be "update" or "create_copy"' }, 400)
  }
  const parentId = body?.parentId ?? null
  if (parentId !== null && typeof parentId !== "string") {
    return c.json({ error: "parentId must be a string or null" }, 400)
  }

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

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
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

  if (conflict === "update") {
    const existing = await findSiblingByTitle(
      db,
      prefix,
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
    parentId,
    content: parsed.value,
    userId,
    now
  })
  return c.json({ pageId: row.id, url: `/p/${row.id}` }, 201)
})
