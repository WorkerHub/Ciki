/**
 * 管理面：用户管理（含审批）、系统设置、数据库维护迁移。
 * 整个路由由 index.ts 的会话守卫 + 本文件的 adminMiddleware 保护。
 */
import { Hono } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import { readDatabaseSize } from "../core/d1-size"
import {
  pagesTable,
  revisionsTable,
  spacesTable,
  usersTable
} from "../lib/tables"
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
import { deleteUserEmailCodes } from "../db/queries/email-codes"
import { clearPasswordResetCredentials } from "../core/password-reset"
import { deleteUserSessions } from "../core/session"
import {
  deleteSpaceMembershipsForUser,
  joinDefaultSpace,
  listSpaceOverviews
} from "../db/queries/spaces"
import { hashPassword } from "../core/auth"
import {
  getAllSettings,
  getBooleanSetting,
  getSetting,
  setSetting
} from "../db/queries/settings"
import {
  DEFAULT_SITE_NAME,
  defaultUsernameFromEmail,
  isEmailConflict,
  normalizeSiteName
} from "../core/identity"
import { runSetup } from "../lib/setup"
import {
  cleanupLockRemainingSeconds,
  cleanupRunDto,
  R2CleanupBusyError,
  runR2Cleanup,
  runAllBucketCleanups
} from "../core/r2-cleanup"
import { runContentCleanup } from "../core/content-cleanup"
import {
  lastCleanupRun,
  readCleanupLock,
  type CleanupKind
} from "../db/queries/r2-cleanup"
import {
  normalizeRetentionInput,
  pruneAllPages,
  readRetentionLimit,
  revisionRetentionPreview,
  writeRetentionLimit
} from "../core/revision-retention"
import { adminMiddleware } from "../middleware/admin"
import { clientIp, parseId, readJsonBody } from "../lib/http"
import { consumeCounter } from "../core/counters"
import {
  isEmailConfigured,
  isSmtpConfigUsable,
  publicSmtpConfig,
  readStoredSmtpConfig,
  saveSmtpConfig,
  sendTransactionalEmail,
  validateSmtpConfigInput
} from "../services/email"
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
      slug: space.slug,
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

  const passwordHash = await hashPassword(password)
  let id: number
  try {
    id = await createApprovedUser(c.env.DB, prefix, {
      email,
      username: defaultUsernameFromEmail(email),
      password_hash: passwordHash,
      role: body?.role === "admin" ? "admin" : "user"
    })
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
  const uid = parseId(c.req.param("id"))
  if (uid === null) return c.json({ error: "User not found" }, 404)
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
  // 改邮箱：旧邮箱收到的验证码立即作废（#48 契约第 2 条）。
  if (updates.email !== undefined) {
    await deleteUserEmailCodes(c.env.DB, prefix, uid)
  }
  if (roleChanged || deactivated || updates.password_hash) {
    // 管理员改密：会话仍全部失效，并清掉该用户未使用的找回密码凭据（#48 契约）。
    if (updates.password_hash) {
      await clearPasswordResetCredentials(c.env.DB, prefix, uid)
    }
    await deleteUserSessions(c.env.DB, prefix, uid)
  }
  return c.json({ success: true })
})

adminRoutes.delete("/users/:id", async (c) => {
  const prefix = getTablePrefix(c.env)
  const uid = parseId(c.req.param("id"))
  if (uid === null) return c.json({ error: "User not found" }, 404)
  if (uid === c.get("userId")) {
    return c.json({ error: "Cannot delete yourself" }, 400)
  }
  const user = await findUserById(c.env.DB, prefix, uid)
  if (!user) return c.json({ error: "User not found" }, 404)

  await deleteUserSessions(c.env.DB, prefix, uid)
  await deleteUserPasskeys(c.env.DB, prefix, uid)
  await deleteTotp(c.env.DB, prefix, uid)
  await deleteUserEmailCodes(c.env.DB, prefix, uid)
  await deleteSpaceMembershipsForUser(c.env.DB, prefix, uid)
  await deleteUser(c.env.DB, prefix, uid)
  return c.json({ success: true })
})

adminRoutes.post("/users/:id/approve", async (c) => {
  const prefix = getTablePrefix(c.env)
  const uid = parseId(c.req.param("id"))
  if (uid === null) return c.json({ error: "User not found" }, 404)
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
  const uid = parseId(c.req.param("id"))
  if (uid === null) return c.json({ error: "User not found" }, 404)
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
    require2fa: await getBooleanSetting(c.env.DB, prefix, "require_2fa", false),
    // null = 不限（缺行与空串同义，见 core/revision-retention.ts）
    revisionRetentionLimit: await readRetentionLimit(c.env.DB, prefix),
    emailConfigured: await isEmailConfigured(c.env)
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
  if (body.revisionRetentionLimit !== undefined) {
    const parsed = normalizeRetentionInput(body.revisionRetentionLimit)
    if (!parsed.ok) {
      return c.json(
        {
          error: "revisionRetentionLimit must be a positive integer or null"
        },
        400
      )
    }
    await writeRetentionLimit(c.env.DB, prefix, parsed.limit)
  }
  return c.json({ success: true })
})

/** 限流拒绝的统一形状（带 retryAfter，秒）。 */
function rateLimitedJson(windowSeconds: number, windowStart: number) {
  return {
    error: "Too many requests",
    code: "RATE_LIMITED",
    retryAfter: Math.max(
      1,
      windowStart + windowSeconds - Math.floor(Date.now() / 1000)
    )
  }
}

// ── SMTP 配置（#48 契约：管理员，password 只落密文、GET 永不回密码） ─────────

adminRoutes.get("/system/smtp", async (c) => {
  const config = await readStoredSmtpConfig(c.env)
  return c.json({
    emailConfigured: isSmtpConfigUsable(config),
    config: publicSmtpConfig(config)
  })
})

adminRoutes.put("/system/smtp", async (c) => {
  const prefix = getTablePrefix(c.env)
  const limit = await consumeCounter(c.env.DB, prefix, {
    action: "smtp_config",
    account: String(c.get("userId")),
    ip: clientIp(c),
    windowSeconds: 300
  })
  if (limit.count > 10) {
    return c.json(rateLimitedJson(300, limit.windowStart), 429)
  }

  const body = await readJsonBody<Record<string, unknown>>(c)
  const existing = await readStoredSmtpConfig(c.env)
  const validation = validateSmtpConfigInput(body, existing)
  if (!validation.ok) {
    return c.json(
      {
        error: `Invalid SMTP config: ${validation.reason}`,
        code: "INVALID_SMTP_CONFIG"
      },
      400
    )
  }

  await saveSmtpConfig(c.env, validation.value, existing)
  return c.json({
    success: true,
    emailConfigured: await isEmailConfigured(c.env)
  })
})

/**
 * 测试邮件：请求体忽略，**只发给当前管理员自己的邮箱**——不接受任意 `to`，
 * 避免这个口变成开放发信代理（#48 契约与 eNotify 的分歧点 8）。
 */
adminRoutes.post("/system/smtp/test", async (c) => {
  const config = await readStoredSmtpConfig(c.env)
  if (!isSmtpConfigUsable(config)) {
    return c.json(
      {
        error: "Email delivery is not configured",
        code: "EMAIL_NOT_CONFIGURED"
      },
      503
    )
  }

  const prefix = getTablePrefix(c.env)
  const limit = await consumeCounter(c.env.DB, prefix, {
    action: "smtp_test",
    account: String(c.get("userId")),
    ip: clientIp(c),
    windowSeconds: 300
  })
  if (limit.count > 5) {
    return c.json(rateLimitedJson(300, limit.windowStart), 429)
  }

  const admin = await findUserById(c.env.DB, prefix, c.get("userId"))
  if (!admin) return c.json({ error: "User not found" }, 404)

  const sent = await sendTransactionalEmail(c.env, {
    to: admin.email,
    subject: "Ciki SMTP 测试邮件",
    html:
      "<p>这是一封来自 Ciki 的测试邮件：收到它说明 SMTP 配置可用。</p>" +
      `<p>发送时间：${new Date().toISOString()}</p>`
  })
  if (!sent.success) {
    return c.json({ error: sent.error, code: "SMTP_SEND_FAILED" }, 502)
  }
  return c.json({ success: true })
})

/**
 * 全站修剪的预告（只读）：当前设置 + 版本总数 + 将被删条数。
 * 修剪按钮的二次确认文案就靠 `prunableRevisions`，它与真正执行时删掉的条数同口径。
 */
adminRoutes.get("/revisions/retention", async (c) => {
  const prefix = getTablePrefix(c.env)
  return c.json(await revisionRetentionPreview(c.env.DB, prefix))
})

/**
 * 按当前设置修剪全部页面：设置处那个「修剪」按钮。
 *
 * 不点则存量完全不动，只靠后续保存懒修剪（规格「存量立即修剪入口」）。删的只有版本行：
 * `pages` 当前内容、FTS、R2 对象都不动。不限时不删任何东西，直接 409 让前端显形。
 */
adminRoutes.post("/revisions/prune", async (c) => {
  const prefix = getTablePrefix(c.env)
  const limit = await readRetentionLimit(c.env.DB, prefix)
  if (limit === null) {
    return c.json(
      {
        error: "Revision retention is unlimited",
        code: "RETENTION_UNLIMITED"
      },
      409
    )
  }
  const deleted = await pruneAllPages(c.env, limit)
  return c.json({ limit, deleted })
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

/** `kind` 入参：只认 `images` / `content`，缺省 `images`（图片清理的老调用不改）。 */
function readCleanupKind(value: unknown): CleanupKind {
  return value === "content" ? "content" : "images"
}

/**
 * R2 孤儿清理的手动入口（规格 §3 + 「内容 GC」）：管理员手动触发，页面上的两步 UI 调它。
 *
 * `{"dryRun": true}` 只算不删，响应里多带 `prunable` / `prunableBytes`（全量可清理数
 * 与总字节，不受单轮 200 上限截断）；不传 / 传 false 则真实删除。
 * `kind` 选桶：`images`（缺省）扫 `ciki-assets`，`content` 扫 `ciki-content`。
 *
 * 手动实跑**不受 20 天幂等闸约束**（闸只约束自动入口），30 天龄规则照旧。
 * 并发互斥仍在：同类清理已有一轮在跑就回 409 `CLEANUP_IN_PROGRESS`，什么也不做、
 * 不写日志行。
 */
adminRoutes.post("/r2-cleanup", async (c) => {
  const body = await readJsonBody<{ dryRun?: unknown; kind?: unknown }>(c)
  const dryRun = body?.dryRun === true
  const kind = readCleanupKind(body?.kind)
  try {
    const options = {
      trigger: "manual" as const,
      dryRun,
      rerunGuard: "bypass" as const
    }
    const summary =
      kind === "content"
        ? await runContentCleanup(c.env, options)
        : await runR2Cleanup(c.env, options)
    return c.json(summary)
  } catch (err) {
    if (err instanceof R2CleanupBusyError) {
      return c.json(
        {
          error: "Cleanup already running",
          code: "CLEANUP_IN_PROGRESS",
          retryAfter: err.retryAfterSeconds
        },
        409
      )
    }
    console.error(
      "Admin r2 cleanup failed:",
      err instanceof Error ? err.message : err
    )
    return c.json({ error: "Cleanup failed" }, 500)
  }
})

/** 手动把两类清理一起跑一轮（管理面「全部清理」按钮）。 */
adminRoutes.post("/r2-cleanup/all", async (c) => {
  const body = await readJsonBody<{ dryRun?: unknown }>(c)
  try {
    const outcomes = await runAllBucketCleanups(c.env, {
      trigger: "manual",
      dryRun: body?.dryRun === true,
      rerunGuard: "bypass"
    })
    return c.json({ runs: outcomes })
  } catch (err) {
    console.error(
      "Admin r2 cleanup (all) failed:",
      err instanceof Error ? err.message : err
    )
    return c.json({ error: "Cleanup failed" }, 500)
  }
})

/**
 * 「数据库维护」页的数据源：最近一轮真实运行（dry_run / skipped 不算）+ 运行态。
 * `running` 读 `system_settings` 的清理锁行、按同一 TTL 判占用是否仍有效（过期锁
 * 不算在跑），前端据此禁用触发按钮并显示「清理进行中」。形状对前端冻结。
 */
adminRoutes.get("/r2-cleanup", async (c) => {
  const prefix = getTablePrefix(c.env)
  const kind = readCleanupKind(c.req.query("kind"))
  const last = await lastCleanupRun(c.env.DB, prefix, kind)
  const record = (await readCleanupLock(c.env.DB, prefix, kind))?.record ?? null
  const retryAfter = cleanupLockRemainingSeconds(record, Date.now())
  return c.json({
    kind,
    lastRun: last === null ? null : cleanupRunDto(last),
    running:
      record !== null && retryAfter !== null
        ? {
            startedAt: record.startedAt,
            trigger: record.trigger,
            dryRun: record.dryRun,
            retryAfter
          }
        : null
  })
})

/**
 * 「系统管理 → 数据库维护」的体积与页数数据源（展示归前端单 B）。
 *
 * 页数、回收站页数、版本数、空间数、用户数都从 D1 现算；体积改走 Cloudflare
 * D1 REST API 的 `file_size`（见 src/core/d1-size.ts）——D1 运行时拒绝
 * `PRAGMA page_count`，页计数在线上拿不到。取不到时 `databaseSizeBytes` 为
 * `null`、`measure` 为 `unavailable`，前端显示「不可得」，绝不估算。
 */
adminRoutes.get("/storage", async (c) => {
  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM ${pagesTable(prefix)}
           WHERE deleted_at IS NULL) AS page_count,
         (SELECT COUNT(*) FROM ${pagesTable(prefix)}
           WHERE deleted_at IS NOT NULL) AS trashed_page_count,
         (SELECT COUNT(*) FROM ${revisionsTable(prefix)}) AS revision_count,
         (SELECT COUNT(*) FROM ${spacesTable(prefix)}) AS space_count,
         (SELECT COUNT(*) FROM ${usersTable(prefix)}) AS user_count`
    )
    .first<{
      page_count: number
      trashed_page_count: number
      revision_count: number
      space_count: number
      user_count: number
    }>()
  const size = await readDatabaseSize(c.env)
  return c.json({
    pageCount: row?.page_count ?? 0,
    trashedPageCount: row?.trashed_page_count ?? 0,
    revisionCount: row?.revision_count ?? 0,
    spaceCount: row?.space_count ?? 0,
    userCount: row?.user_count ?? 0,
    databaseSizeBytes: size.bytes,
    sizeScope: "own-database",
    measure: size.measure
  })
})
