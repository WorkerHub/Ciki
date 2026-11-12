/**
 * 写接口（二期规格 §3.2）：外部连接器用的四个写端点。
 *
 * 鉴权只认读写令牌（`Authorization: Bearer`，见 middleware/write-token.ts）；会话
 * Cookie、只读令牌与导入令牌在这里一律 401（表隔离）。
 *
 * 权限与站内同一口径，再叠一层令牌空间范围：目标空间内令牌主人须有 `editor` 及以上
 * 角色（站点管理员恒算空间 admin）且该空间在令牌范围内；任何不满足一律 404，不泄露
 * 存在性（规格 §2.5）。写入全部复用站内唯一写路径：`normalizeImportedContent` →
 * `createPage` / `savePageContent` / `renamePage`，移动与软删复用 `applyPageMove` /
 * `softDeleteSubtree`——没有第二套写法。
 *
 * 正文只收 TipTap JSON（`content_json`，字符串或对象均可），**本期不收 Markdown**
 * （规格 §3.3）：服务端没有 md→JSON 转换链，调用方自行转换。
 *
 * 请求体与响应字段一律 snake_case：这是本仓 camelCase 通则的唯一例外，按冻结契约
 * 逐字使用（见 docs/api-contract.md「读写接口」），别在实现里顺手改成 camelCase。
 */
import { Hono } from "hono"
import type { Context } from "hono"
import {
  getPageRow,
  softDeleteSubtree,
  type PageRow
} from "../db/queries/pages"
import { findDefaultSpace } from "../db/queries/spaces"
import { canEditPages, resolveSpaceRole } from "../core/space-access"
import {
  getTokenScope,
  tokenScopeAllows,
  type TokenScope
} from "../core/token-scope"
import { createPage, renamePage, savePageContent } from "../core/page-write"
import { applyPageMove } from "../core/page-move"
import {
  normalizeImportedContent,
  normalizePageTitle,
  type PageContentResult
} from "../lib/page-input"
import { toPlainText } from "../lib/sanitize"
import { parseId, readJsonBody, readParentId, readSpaceId } from "../lib/http"
import { getTablePrefix } from "../lib/table-prefix"
import { writeTokenMiddleware } from "../middleware/write-token"
import type { HonoEnv } from "../types"

export const writeRoutes = new Hono<HonoEnv>()

// 整段只认读写令牌：会话 Cookie 与另外两种令牌都进不来（职责分离 + 表隔离）。
writeRoutes.use("*", writeTokenMiddleware)

function pageNotFound(c: Context<HonoEnv>) {
  return c.json({ error: "Page not found" }, 404)
}

function spaceNotFound(c: Context<HonoEnv>) {
  return c.json({ error: "Space not found", code: "SPACE_NOT_FOUND" }, 404)
}

function invalidBody(c: Context<HonoEnv>) {
  return c.json({ error: "Invalid request body" }, 400)
}

/** 建页/改页的元信息（精确六键，冻结契约）。 */
function pageMeta(row: PageRow) {
  return {
    id: row.id,
    space_id: row.space_id,
    parent_id: row.parent_id,
    sort_order: row.sort_order,
    title: toPlainText(row.title),
    updated_at: row.updated_at
  }
}

/** 校验失败 → 契约状态码（体积超限 413，其余 400），与站内同一映射。 */
function contentError(
  c: Context<HonoEnv>,
  parsed: Extract<PageContentResult, { ok: false }>
) {
  const status = parsed.code === "PAYLOAD_TOO_LARGE" ? 413 : 400
  return c.json(
    { error: parsed.error, ...(parsed.code ? { code: parsed.code } : {}) },
    status
  )
}

/** 当前请求的令牌范围（`null` = 不限制）。 */
async function tokenScope(c: Context<HonoEnv>): Promise<TokenScope> {
  return getTokenScope(
    c.env.DB,
    getTablePrefix(c.env),
    "write",
    c.get("userId")
  )
}

/** 空间可写 = 在令牌范围内 + 令牌主人有 `editor` 及以上角色；两者缺一按不存在处理。 */
async function canWriteSpace(
  c: Context<HonoEnv>,
  scope: TokenScope,
  spaceId: number
): Promise<boolean> {
  if (!tokenScopeAllows(scope, spaceId)) return false
  const role = await resolveSpaceRole(
    c.env.DB,
    getTablePrefix(c.env),
    spaceId,
    c.get("userId"),
    c.get("role") === "admin"
  )
  return canEditPages(role)
}

interface WritablePage {
  row: PageRow
  scope: TokenScope
}

/** 取当前令牌可写的页面：不存在/已软删/范围外/无写权一律 null（调用方回 404）。 */
async function loadWritablePage(
  c: Context<HonoEnv>,
  rawId: string | undefined
): Promise<WritablePage | null> {
  const id = parseId(rawId)
  if (id === null) return null
  const row = await getPageRow(c.env.DB, getTablePrefix(c.env), id)
  if (!row || row.deleted_at) return null
  const scope = await tokenScope(c)
  if (!(await canWriteSpace(c, scope, row.space_id))) return null
  return { row, scope }
}

/**
 * POST /api/write/pages：建页。
 *
 * `space_id` 缺省落默认空间（与导入接口同口径），`parent_id` 缺省为根级；新页永远
 * 排同级末尾（`createPage` 里的 `maxSortOrder` + 1）。父页必须与目标空间一致。
 */
writeRoutes.post("/pages", async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c)
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return invalidBody(c)
  }

  // 便宜的入参归一先做：类型错直接 400，不付查询与渲染成本。
  const parent = readParentId(body.parent_id)
  if (!parent.ok) {
    return c.json({ error: "parent_id must be an integer or null" }, 400)
  }
  const requestedSpace = readSpaceId(body.space_id)
  if (!requestedSpace.ok) {
    return c.json({ error: "space_id must be an integer" }, 400)
  }

  const prefix = getTablePrefix(c.env)
  const scope = await tokenScope(c)

  let spaceId = requestedSpace.value
  if (spaceId === null) {
    const fallback = await findDefaultSpace(c.env.DB, prefix)
    if (!fallback) {
      return c.json(
        { error: "Default space missing", code: "DEFAULT_SPACE_MISSING" },
        409
      )
    }
    spaceId = fallback.id
  }
  if (!(await canWriteSpace(c, scope, spaceId))) return spaceNotFound(c)

  const parentId = parent.value
  if (parentId !== null) {
    const parentRow = await getPageRow(c.env.DB, prefix, parentId)
    // 不存在 / 范围外 / 看不见的父页一律按不存在处理，不泄露它属于哪个空间。
    if (!parentRow) return pageNotFound(c)
    if (!(await canWriteSpace(c, scope, parentRow.space_id))) {
      return pageNotFound(c)
    }
    if (parentRow.deleted_at) {
      return c.json(
        { error: "Parent page is deleted", code: "PARENT_DELETED" },
        409
      )
    }
    if (parentRow.space_id !== spaceId) {
      return c.json(
        { error: "Parent page is in another space", code: "SPACE_MISMATCH" },
        409
      )
    }
  }

  const parsed = normalizeImportedContent({
    title: body.title,
    contentJson: body.content_json
  })
  if (!parsed.ok) return contentError(c, parsed)

  const row = await createPage(c.env, prefix, {
    spaceId,
    parentId,
    content: parsed.value,
    userId: c.get("userId"),
    now: new Date().toISOString()
  })
  return c.json(pageMeta(row), 201)
})

/**
 * PUT /api/write/pages/:id：改标题和/或改正文。
 *
 * 只给 `title` 走站内同一条改名路径（`renamePage`：不读 R2、不产版本、不重渲染）；
 * 只给 `content_json` 沿用现存标题；正文全等时 `savePageContent` 不 PUT 对象、
 * 不追加版本。
 */
writeRoutes.put("/pages/:id", async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c)
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return invalidBody(c)
  }

  const loaded = await loadWritablePage(c, c.req.param("id"))
  if (!loaded) return pageNotFound(c)
  const { row } = loaded

  const hasTitle = body.title !== undefined
  const hasContent = body.content_json !== undefined
  if (!hasTitle && !hasContent) {
    return c.json({ error: "title or content_json required" }, 400)
  }

  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const now = new Date().toISOString()

  if (!hasContent) {
    if (typeof body.title !== "string") {
      return c.json({ error: "Title required" }, 400)
    }
    const title = normalizePageTitle(body.title)
    if (!title) {
      return c.json({ error: "Title must be 1-255 characters" }, 400)
    }
    return c.json(
      pageMeta(await renamePage(c.env, prefix, row, { title, userId, now }))
    )
  }

  const parsed = normalizeImportedContent({
    title: hasTitle ? body.title : row.title,
    contentJson: body.content_json
  })
  if (!parsed.ok) return contentError(c, parsed)

  const saved = await savePageContent(c.env, prefix, row, {
    content: parsed.value,
    userId,
    now
  })
  return c.json(pageMeta(saved))
})

/**
 * POST /api/write/pages/:id/move：移动。
 *
 * 语义与站内 move 完全一致（`applyPageMove` 同一份代码）。`space_id` 缺省为当前页
 * 所在空间；跨空间移动要求源、目标空间都通过写权判定，整棵后代子树一起改空间。
 */
writeRoutes.post("/pages/:id/move", async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c)
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return invalidBody(c)
  }

  const loaded = await loadWritablePage(c, c.req.param("id"))
  if (!loaded) return pageNotFound(c)
  const { row, scope } = loaded

  if (body.parent_id === undefined) {
    return c.json({ error: "parent_id is required" }, 400)
  }
  const parent = readParentId(body.parent_id)
  if (!parent.ok) {
    return c.json({ error: "parent_id must be an integer or null" }, 400)
  }
  const index = body.index
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    return c.json({ error: "index must be a non-negative integer" }, 400)
  }
  const requestedSpace = readSpaceId(body.space_id)
  if (!requestedSpace.ok) {
    return c.json({ error: "space_id must be an integer" }, 400)
  }

  const targetSpaceId = requestedSpace.value ?? row.space_id
  if (!(await canWriteSpace(c, scope, targetSpaceId))) {
    return spaceNotFound(c)
  }

  // 父页在范围外时按不存在处理（不泄露它属于哪个空间）；其余结构校验交给 core。
  if (parent.value !== null) {
    const parentRow = await getPageRow(
      c.env.DB,
      getTablePrefix(c.env),
      parent.value
    )
    if (parentRow && !tokenScopeAllows(scope, parentRow.space_id)) {
      return pageNotFound(c)
    }
  }

  const outcome = await applyPageMove(c.env, getTablePrefix(c.env), row, {
    targetSpaceId,
    parentId: parent.value,
    index,
    now: new Date().toISOString(),
    actor: { userId: c.get("userId"), siteAdmin: c.get("role") === "admin" }
  })
  if (!outcome.ok) {
    switch (outcome.error) {
      case "parent_not_visible":
        return pageNotFound(c)
      case "parent_not_found":
      case "parent_deleted":
        return c.json(
          { error: "Parent page is deleted", code: "PARENT_DELETED" },
          409
        )
      case "parent_in_other_space":
        return c.json(
          {
            error: "Parent page is in another space",
            code: "SPACE_MISMATCH"
          },
          409
        )
      case "page_move_cycle":
        return c.json(
          {
            error: "Cannot move a page into its own subtree",
            code: "PAGE_MOVE_CYCLE"
          },
          409
        )
    }
  }

  return c.json({ success: true })
})

/** DELETE /api/write/pages/:id：软删（进回收站、可恢复），与站内删除同一例程。 */
writeRoutes.delete("/pages/:id", async (c) => {
  const loaded = await loadWritablePage(c, c.req.param("id"))
  if (!loaded) return pageNotFound(c)
  const { row } = loaded
  const now = new Date().toISOString()
  await c.env.DB.batch(
    softDeleteSubtree(c.env.DB, getTablePrefix(c.env), row.id, now)
  )
  return c.json({ success: true })
})
