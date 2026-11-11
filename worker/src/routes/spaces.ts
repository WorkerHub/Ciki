/**
 * 空间与成员管理（规格「Ciki Space」）。
 *
 * 读：站点管理员看全部空间，普通用户只看自己是成员的空间。
 * 写：空间信息与成员管理仅空间 `admin` / 站点管理员；任何登录用户都能建空间，
 * 创建者自动成为该空间 `admin`。
 *
 * id 是整数自增主键；URL 里的空间段用 `slug`（`/s/<slug>/…`，前端从 `GET /api/spaces`
 * 的 `slug` 解析）。slug 在创建时由空间名生成、之后不随改名变化。
 */
import { Hono } from "hono"
import type { Context } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import { parseId, readIdInput, readJsonBody } from "../lib/http"
import { uniqueSpaceSlug } from "../lib/slug"
import { findUserById } from "../db/queries/users"
import {
  countSpaceAdmins,
  countSpacePages,
  deleteSpaceMember,
  deleteSpaceStatements,
  findSpaceMember,
  insertSpace,
  insertSpaceMember,
  listSpaceSlugs,
  listAllSpaces,
  listMemberCandidates,
  listSpaceMembers,
  listSpacesForUser,
  updateSpace,
  updateSpaceMemberRole,
  updateSpaceSlug,
  type MemberCandidateRow,
  type SpaceMemberViewRow,
  type SpaceRow,
  type SpaceWithRoleRow
} from "../db/queries/spaces"
import {
  isSpaceManager,
  isSpaceRole,
  normalizeSpaceDescription,
  normalizeSpaceName,
  resolveSpaceAccess,
  type SpaceAccess,
  type SpaceRole
} from "../core/space-access"
import type { HonoEnv } from "../types"

export const spaceRoutes = new Hono<HonoEnv>()

function isSiteAdmin(c: Context<HonoEnv>): boolean {
  return c.get("role") === "admin"
}

function toSpaceDto(space: SpaceRow, role: SpaceRole) {
  return {
    id: space.id,
    slug: space.slug,
    name: space.name,
    description: space.description,
    myRole: role,
    isDefault: Boolean(space.is_default),
    createdAt: space.created_at,
    updatedAt: space.updated_at
  }
}

function toMemberDto(row: SpaceMemberViewRow) {
  return {
    userId: row.user_id,
    username: row.username,
    email: row.email,
    role: row.role,
    createdAt: row.created_at
  }
}

function toCandidateDto(row: MemberCandidateRow) {
  return {
    userId: row.user_id,
    username: row.username,
    email: row.email
  }
}

function spaceNotFound(c: Context<HonoEnv>) {
  return c.json({ error: "Space not found", code: "SPACE_NOT_FOUND" }, 404)
}

function forbidden(c: Context<HonoEnv>) {
  return c.json({ error: "Forbidden" }, 403)
}

async function accessFor(
  c: Context<HonoEnv>,
  spaceId: number
): Promise<SpaceAccess | null> {
  return resolveSpaceAccess(
    c.env.DB,
    getTablePrefix(c.env),
    spaceId,
    c.get("userId"),
    isSiteAdmin(c)
  )
}

spaceRoutes.get("/", async (c) => {
  const prefix = getTablePrefix(c.env)
  if (isSiteAdmin(c)) {
    const spaces = await listAllSpaces(c.env.DB, prefix)
    return c.json(spaces.map((space) => toSpaceDto(space, "admin")))
  }
  const spaces = await listSpacesForUser(c.env.DB, prefix, c.get("userId"))
  return c.json(
    spaces.map((space: SpaceWithRoleRow) => toSpaceDto(space, space.role))
  )
})

spaceRoutes.post("/", async (c) => {
  const body = await readJsonBody<{ name?: unknown; description?: unknown }>(c)
  const name = normalizeSpaceName(body?.name)
  if (!name) {
    return c.json(
      {
        error: "Space name must be 1-64 characters without control characters",
        code: "INVALID_SPACE_NAME"
      },
      400
    )
  }
  let description = ""
  if (body?.description !== undefined) {
    const normalized = normalizeSpaceDescription(body.description)
    if (normalized === null) {
      return c.json(
        {
          error: "Description must be at most 500 characters",
          code: "INVALID_SPACE_DESCRIPTION"
        },
        400
      )
    }
    description = normalized
  }

  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const now = new Date().toISOString()

  // 先落行拿自增 id：slug 的兜底形态 `space-<id>` 要等 id 出来才知道。
  const inserted = await c.env.DB.batch([
    insertSpace(c.env.DB, prefix, {
      name,
      description,
      is_default: 0,
      created_by: userId,
      created_at: now,
      updated_at: now
    })
  ])
  const id = inserted[0].meta.last_row_id
  const usedSlugs = new Set(await listSpaceSlugs(c.env.DB, prefix))
  const slug = uniqueSpaceSlug(name, id, (candidate) =>
    usedSlugs.has(candidate)
  )

  await c.env.DB.batch([
    updateSpaceSlug(c.env.DB, prefix, id, slug),
    insertSpaceMember(c.env.DB, prefix, {
      space_id: id,
      user_id: userId,
      role: "admin",
      created_at: now
    })
  ])

  const space: SpaceRow = {
    id,
    slug,
    name,
    description,
    is_default: 0,
    created_by: userId,
    created_at: now,
    updated_at: now
  }
  return c.json(toSpaceDto(space, "admin"), 201)
})

spaceRoutes.get("/:id", async (c) => {
  const id = parseId(c.req.param("id"))
  if (id === null) return spaceNotFound(c)
  const access = await accessFor(c, id)
  if (!access) return spaceNotFound(c)
  return c.json(toSpaceDto(access.space, access.role))
})

spaceRoutes.put("/:id", async (c) => {
  const id = parseId(c.req.param("id"))
  if (id === null) return spaceNotFound(c)
  const access = await accessFor(c, id)
  if (!access) return spaceNotFound(c)
  if (!isSpaceManager(access.role)) return forbidden(c)

  const body = await readJsonBody<{ name?: unknown; description?: unknown }>(c)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400)
  }
  const hasName = body.name !== undefined
  const hasDescription = body.description !== undefined
  if (!hasName && !hasDescription) {
    return c.json({ error: "Nothing to update" }, 400)
  }

  let name: string | undefined
  if (hasName) {
    const normalized = normalizeSpaceName(body.name)
    if (!normalized) {
      return c.json(
        {
          error:
            "Space name must be 1-64 characters without control characters",
          code: "INVALID_SPACE_NAME"
        },
        400
      )
    }
    name = normalized
  }
  let description: string | undefined
  if (hasDescription) {
    const normalized = normalizeSpaceDescription(body.description)
    if (normalized === null) {
      return c.json(
        {
          error: "Description must be at most 500 characters",
          code: "INVALID_SPACE_DESCRIPTION"
        },
        400
      )
    }
    description = normalized
  }

  const prefix = getTablePrefix(c.env)
  const now = new Date().toISOString()
  await updateSpace(c.env.DB, prefix, access.space.id, {
    name,
    description,
    updatedAt: now
  })

  return c.json(
    toSpaceDto(
      {
        ...access.space,
        name: name ?? access.space.name,
        description: description ?? access.space.description,
        updated_at: now
      },
      access.role
    )
  )
})

spaceRoutes.delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"))
  if (id === null) return spaceNotFound(c)
  const access = await accessFor(c, id)
  if (!access) return spaceNotFound(c)
  if (!isSpaceManager(access.role)) return forbidden(c)
  if (access.space.is_default) {
    return c.json(
      {
        error: "The default space cannot be deleted",
        code: "SPACE_DEFAULT_PROTECTED"
      },
      409
    )
  }

  const prefix = getTablePrefix(c.env)
  const counts = await countSpacePages(c.env.DB, prefix, access.space.id)
  if (counts.active + counts.trashed > 0) {
    return c.json(
      {
        error: "Move or permanently delete all pages before deleting the space",
        code: "SPACE_NOT_EMPTY"
      },
      409
    )
  }

  await c.env.DB.batch(deleteSpaceStatements(c.env.DB, prefix, access.space.id))
  return c.json({ success: true })
})

// ── 成员 ────────────────────────────────────────────────────────────────────

spaceRoutes.get("/:id/members", async (c) => {
  const id = parseId(c.req.param("id"))
  if (id === null) return spaceNotFound(c)
  const access = await accessFor(c, id)
  if (!access) return spaceNotFound(c)
  if (!isSpaceManager(access.role)) return forbidden(c)

  const prefix = getTablePrefix(c.env)
  const members = await listSpaceMembers(c.env.DB, prefix, access.space.id)
  return c.json(members.map(toMemberDto))
})

spaceRoutes.post("/:id/members", async (c) => {
  const id = parseId(c.req.param("id"))
  if (id === null) return spaceNotFound(c)
  const access = await accessFor(c, id)
  if (!access) return spaceNotFound(c)
  if (!isSpaceManager(access.role)) return forbidden(c)

  const body = await readJsonBody<{ userId?: unknown; role?: unknown }>(c)
  const userId = readIdInput(body?.userId)
  if (!userId) return c.json({ error: "userId must be an integer" }, 400)
  if (!isSpaceRole(body?.role)) {
    return c.json(
      { error: "role must be admin, editor or viewer", code: "INVALID_ROLE" },
      400
    )
  }

  const prefix = getTablePrefix(c.env)
  const user = await findUserById(c.env.DB, prefix, userId)
  if (!user) {
    return c.json({ error: "User not found", code: "USER_NOT_FOUND" }, 404)
  }
  if (!user.is_active || user.approval_status !== "approved") {
    return c.json(
      { error: "User cannot join a space", code: "USER_NOT_ELIGIBLE" },
      409
    )
  }
  if (await findSpaceMember(c.env.DB, prefix, access.space.id, userId)) {
    return c.json(
      { error: "User is already a member", code: "ALREADY_MEMBER" },
      409
    )
  }

  const now = new Date().toISOString()
  await insertSpaceMember(c.env.DB, prefix, {
    space_id: access.space.id,
    user_id: userId,
    role: body.role,
    created_at: now
  }).run()

  return c.json(
    {
      userId: user.id,
      username: user.username,
      email: user.email,
      role: body.role,
      createdAt: now
    },
    201
  )
})

spaceRoutes.put("/:id/members/:userId", async (c) => {
  const id = parseId(c.req.param("id"))
  const userId = parseId(c.req.param("userId"))
  if (id === null || userId === null) return spaceNotFound(c)
  const access = await accessFor(c, id)
  if (!access) return spaceNotFound(c)
  if (!isSpaceManager(access.role)) return forbidden(c)

  const body = await readJsonBody<{ role?: unknown }>(c)
  if (!isSpaceRole(body?.role)) {
    return c.json(
      { error: "role must be admin, editor or viewer", code: "INVALID_ROLE" },
      400
    )
  }

  const prefix = getTablePrefix(c.env)
  const member = await findSpaceMember(
    c.env.DB,
    prefix,
    access.space.id,
    userId
  )
  if (!member) {
    return c.json({ error: "Member not found", code: "MEMBER_NOT_FOUND" }, 404)
  }

  if (member.role === "admin" && body.role !== "admin") {
    const admins = await countSpaceAdmins(c.env.DB, prefix, access.space.id)
    if (admins <= 1) {
      return c.json(
        {
          error: "A space must keep at least one admin",
          code: "LAST_SPACE_ADMIN"
        },
        409
      )
    }
  }

  await updateSpaceMemberRole(
    c.env.DB,
    prefix,
    access.space.id,
    userId,
    body.role
  )
  const user = await findUserById(c.env.DB, prefix, userId)
  return c.json({
    userId,
    username: user?.username ?? "",
    email: user?.email ?? "",
    role: body.role,
    createdAt: member.created_at
  })
})

spaceRoutes.delete("/:id/members/:userId", async (c) => {
  const id = parseId(c.req.param("id"))
  const userId = parseId(c.req.param("userId"))
  if (id === null || userId === null) return spaceNotFound(c)
  const access = await accessFor(c, id)
  if (!access) return spaceNotFound(c)
  if (!isSpaceManager(access.role)) return forbidden(c)

  const prefix = getTablePrefix(c.env)
  const member = await findSpaceMember(
    c.env.DB,
    prefix,
    access.space.id,
    userId
  )
  if (!member) {
    return c.json({ error: "Member not found", code: "MEMBER_NOT_FOUND" }, 404)
  }

  if (member.role === "admin") {
    const admins = await countSpaceAdmins(c.env.DB, prefix, access.space.id)
    if (admins <= 1) {
      return c.json(
        {
          error: "A space must keep at least one admin",
          code: "LAST_SPACE_ADMIN"
        },
        409
      )
    }
  }

  await deleteSpaceMember(c.env.DB, prefix, access.space.id, userId)
  return c.json({ success: true })
})

spaceRoutes.get("/:id/member-candidates", async (c) => {
  const id = parseId(c.req.param("id"))
  if (id === null) return spaceNotFound(c)
  const access = await accessFor(c, id)
  if (!access) return spaceNotFound(c)
  if (!isSpaceManager(access.role)) return forbidden(c)

  const prefix = getTablePrefix(c.env)
  const rows = await listMemberCandidates(
    c.env.DB,
    prefix,
    access.space.id,
    c.req.query("q") ?? ""
  )
  return c.json(rows.map(toCandidateDto))
})
