/**
 * 管理面：用户管理（含审批）、系统设置、数据库维护迁移。
 * 整个路由由 index.ts 的会话守卫 + 本文件的 adminMiddleware 保护。
 */
import { Hono } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import {
  createApprovedUser,
  deleteUser,
  findUserByEmail,
  findUserById,
  listUsers,
  updateUser,
  type UserRow
} from "../db/queries/users"
import { deleteTotp } from "../db/queries/totp"
import { deleteUserPasskeys } from "../db/queries/passkeys"
import { deleteUserSessions } from "../core/session"
import {
  deleteSpaceMembershipsForUser,
  joinDefaultSpace,
  listSpaceOverviews
} from "../db/queries/spaces"
import { generateId, hashPassword } from "../core/auth"
import {
  getAllSettings,
  getBooleanSetting,
  getSetting,
  setSetting
} from "../db/queries/settings"
import {
  DEFAULT_SITE_NAME,
  defaultUsernameFromEmail,
  insertWithFreshPublicId,
  isEmailConflict,
  normalizeSiteName
} from "../core/identity"
import { runSetup } from "../lib/setup"
import { cleanupRunDto, runR2Cleanup } from "../core/r2-cleanup"
import { lastCleanupRun } from "../db/queries/r2-cleanup"
import { adminMiddleware } from "../middleware/admin"
import { readJsonBody } from "../lib/http"
import type { HonoEnv } from "../types"

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

function userDto(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    isActive: Boolean(user.is_active),
    approvalStatus: user.approval_status,
    createdAt: user.created_at
  }
}

export const adminRoutes = new Hono<HonoEnv>()

adminRoutes.use("*", adminMiddleware)

/** 空间总览：站点管理员对全部空间的页面/成员计量（系统管理页用）。 */
adminRoutes.get("/spaces", async (c) => {
  const prefix = getTablePrefix(c.env)
  const spaces = await listSpaceOverviews(c.env.DB, prefix)
  return c.json(
    spaces.map((space) => ({
      id: space.id,
      name: space.name,
      description: space.description,
      isDefault: Boolean(space.is_default),
      createdBy: space.created_by,
      createdAt: space.created_at,
      updatedAt: space.updated_at,
      memberCount: space.member_count,
      pageCount: space.page_count,
      trashedPageCount: space.trashed_page_count
    }))
  )
})

adminRoutes.get("/users", async (c) => {
  const prefix = getTablePrefix(c.env)
  const status = c.req.query("status") ?? "all"
  const users = await listUsers(c.env.DB, prefix)
  const filtered =
    status === "pending"
      ? users.filter((user) => user.approval_status === "pending")
      : users
  return c.json(filtered.map(userDto))
})

adminRoutes.post("/users", async (c) => {
  const body = await readJsonBody<{
    email?: unknown
    password?: unknown
    role?: unknown
  }>(c)
  const email =
    typeof body?.email === "string" ? body.email.trim().toLowerCase() : ""
  const password = typeof body?.password === "string" ? body.password : ""
  if (!email || !password) {
    return c.json({ error: "Email and password required" }, 400)
  }
  if (!EMAIL_RE.test(email)) {
    return c.json({ error: "Invalid email format" }, 400)
  }
  if (password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400)
  }

  const prefix = getTablePrefix(c.env)
  if (await findUserByEmail(c.env.DB, prefix, email)) {
    return c.json(
      { error: "Email already registered", code: "EMAIL_TAKEN" },
      409
    )
  }

  const id = generateId()
  const passwordHash = await hashPassword(password)
  try {
    await insertWithFreshPublicId((publicId) =>
      createApprovedUser(c.env.DB, prefix, {
        id,
        email,
        username: defaultUsernameFromEmail(email),
        public_id: publicId,
        password_hash: passwordHash,
        role: body?.role === "admin" ? "admin" : "user"
      })
    )
  } catch (err) {
    if (isEmailConflict(err)) {
      return c.json(
        { error: "Email already registered", code: "EMAIL_TAKEN" },
        409
      )
    }
    throw err
  }
  const user = await findUserById(c.env.DB, prefix, id)
  await joinDefaultSpace(
    c.env.DB,
    prefix,
    id,
    body?.role === "admin" ? "admin" : "user"
  )
  return c.json(user ? userDto(user) : { success: true }, 201)
})

adminRoutes.put("/users/:id", async (c) => {
  const prefix = getTablePrefix(c.env)
  const uid = c.req.param("id")
  const body = await readJsonBody<{
    role?: unknown
    isActive?: unknown
    email?: unknown
    password?: unknown
  }>(c)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400)
  }

  const user = await findUserById(c.env.DB, prefix, uid)
  if (!user) return c.json({ error: "User not found" }, 404)

  if (uid === c.get("userId")) {
    if (body.role !== undefined && body.role !== "admin") {
      return c.json({ error: "Cannot change your own role" }, 400)
    }
    if (body.isActive === false) {
      return c.json({ error: "Cannot disable yourself" }, 400)
    }
  }

  const updates: Record<string, unknown> = {}
  if (body.role !== undefined) {
    if (
      typeof body.role !== "string" ||
      !["admin", "user"].includes(body.role)
    ) {
      return c.json({ error: "Invalid role" }, 400)
    }
    updates.role = body.role
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      return c.json({ error: "isActive must be a boolean" }, 400)
    }
    updates.is_active = body.isActive ? 1 : 0
  }
  if (body.email !== undefined) {
    if (typeof body.email !== "string") {
      return c.json({ error: "Invalid email format" }, 400)
    }
    const email = body.email.trim().toLowerCase()
    if (!EMAIL_RE.test(email)) {
      return c.json({ error: "Invalid email format" }, 400)
    }
    const existing = await findUserByEmail(c.env.DB, prefix, email)
    if (existing && existing.id !== uid) {
      return c.json({ error: "Email already in use", code: "EMAIL_TAKEN" }, 409)
    }
    updates.email = email
  }
  if (body.password !== undefined) {
    if (typeof body.password !== "string" || body.password.length < 8) {
      return c.json({ error: "Password must be at least 8 characters" }, 400)
    }
    updates.password_hash = await hashPassword(body.password)
  }

  try {
    await updateUser(c.env.DB, prefix, uid, updates)
  } catch (err) {
    if (updates.email !== undefined && isEmailConflict(err)) {
      return c.json({ error: "Email already in use", code: "EMAIL_TAKEN" }, 409)
    }
    throw err
  }

  const roleChanged = updates.role !== undefined && updates.role !== user.role
  const deactivated = updates.is_active === 0 && user.is_active === 1
  if (roleChanged || deactivated || updates.password_hash) {
    await deleteUserSessions(c.env.DB, prefix, uid)
  }
  return c.json({ success: true })
})

adminRoutes.delete("/users/:id", async (c) => {
  const prefix = getTablePrefix(c.env)
  const uid = c.req.param("id")
  if (uid === c.get("userId")) {
    return c.json({ error: "Cannot delete yourself" }, 400)
  }
  const user = await findUserById(c.env.DB, prefix, uid)
  if (!user) return c.json({ error: "User not found" }, 404)

  await deleteUserSessions(c.env.DB, prefix, uid)
  await deleteUserPasskeys(c.env.DB, prefix, uid)
  await deleteTotp(c.env.DB, prefix, uid)
  await deleteSpaceMembershipsForUser(c.env.DB, prefix, uid)
  await deleteUser(c.env.DB, prefix, uid)
  return c.json({ success: true })
})

adminRoutes.post("/users/:id/approve", async (c) => {
  const prefix = getTablePrefix(c.env)
  const uid = c.req.param("id")
  const user = await findUserById(c.env.DB, prefix, uid)
  if (!user) return c.json({ error: "User not found" }, 404)
  await updateUser(c.env.DB, prefix, uid, {
    approval_status: "approved",
    is_active: 1
  })
  return c.json({ success: true })
})

adminRoutes.post("/users/:id/reject", async (c) => {
  const prefix = getTablePrefix(c.env)
  const uid = c.req.param("id")
  const user = await findUserById(c.env.DB, prefix, uid)
  if (!user) return c.json({ error: "User not found" }, 404)
  if (uid === c.get("userId")) {
    return c.json({ error: "Cannot reject yourself" }, 400)
  }
  await updateUser(c.env.DB, prefix, uid, {
    approval_status: "rejected",
    is_active: 0
  })
  await deleteUserSessions(c.env.DB, prefix, uid)
  return c.json({ success: true })
})

adminRoutes.get("/settings", async (c) => {
  const prefix = getTablePrefix(c.env)
  return c.json({
    siteName:
      (await getSetting(c.env.DB, prefix, "site_name")) ?? DEFAULT_SITE_NAME,
    setupPageEnabled:
      (await getAllSettings(c.env.DB, prefix)).setup_page_enabled !== "0",
    registrationEnabled: await getBooleanSetting(
      c.env.DB,
      prefix,
      "registration_enabled",
      true
    ),
    registrationApprovalRequired: await getBooleanSetting(
      c.env.DB,
      prefix,
      "registration_approval_required",
      true
    ),
    require2fa: await getBooleanSetting(c.env.DB, prefix, "require_2fa", false)
  })
})

adminRoutes.put("/settings", async (c) => {
  const body = await readJsonBody<Record<string, unknown>>(c)
  if (!body) return c.json({ error: "Invalid request body" }, 400)

  const prefix = getTablePrefix(c.env)
  if (body.siteName !== undefined) {
    const siteName = normalizeSiteName(body.siteName)
    if (!siteName) {
      return c.json({ error: "siteName must be 1-32 characters" }, 400)
    }
    await setSetting(c.env.DB, prefix, "site_name", siteName)
  }
  const mapping: Array<[string, string]> = [
    ["setupPageEnabled", "setup_page_enabled"],
    ["registrationEnabled", "registration_enabled"],
    ["registrationApprovalRequired", "registration_approval_required"],
    ["require2fa", "require_2fa"]
  ]
  for (const [field, key] of mapping) {
    if (body[field] === undefined) continue
    if (typeof body[field] !== "boolean") {
      return c.json({ error: `${field} must be a boolean` }, 400)
    }
    const value =
      key === "setup_page_enabled"
        ? body[field]
          ? "1"
          : "0"
        : body[field]
          ? "true"
          : "false"
    await setSetting(c.env.DB, prefix, key, value)
  }
  return c.json({ success: true })
})

adminRoutes.post("/setup", async (c) => {
  try {
    const result = await runSetup(c.env)
    if (!result.success) return c.json(result, 409)
    return c.json(result)
  } catch (err) {
    console.error(
      "Admin setup failed:",
      err instanceof Error ? err.message : err
    )
    return c.json({ error: "Setup failed" }, 500)
  }
})

/**
 * R2 孤儿清理的验收通道（规格 §3）：管理员手动触发，页面不加按钮。
 *
 * `{"dryRun": true}` 只算不删（不构成双跑，因此永不被 20 天幂等兜底拦住）；
 * 不传 / 传 false 则真实删除，此时与两个自动入口同口径：距上次真实成功运行
 * 不足 20 天会跳过，并记一行 status=skipped 的日志。
 */
adminRoutes.post("/r2-cleanup", async (c) => {
  const body = await readJsonBody<{ dryRun?: unknown }>(c)
  const dryRun = body?.dryRun === true
  try {
    const summary = await runR2Cleanup(c.env, { trigger: "manual", dryRun })
    return c.json(summary)
  } catch (err) {
    console.error(
      "Admin r2 cleanup failed:",
      err instanceof Error ? err.message : err
    )
    return c.json({ error: "Cleanup failed" }, 500)
  }
})

/**
 * 「数据库维护」页那一行摘要的数据源：最近一轮真实运行（dry_run / skipped 不算）。
 * 形状对前端冻结，页面渲染见前端单。
 */
adminRoutes.get("/r2-cleanup", async (c) => {
  const prefix = getTablePrefix(c.env)
  const last = await lastCleanupRun(c.env.DB, prefix)
  return c.json({ lastRun: last === null ? null : cleanupRunDto(last) })
})
