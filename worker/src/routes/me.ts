/**
 * 我的：资料、改密、会话列表/吊销、个人导入令牌（规格 §12.1）、只读接口令牌（一期）。
 */
import { Hono } from "hono"
import type { Context } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import {
  findUserById,
  updateUser,
  usernameTaken,
  type UserRow
} from "../db/queries/users"
import { twofaSummary } from "./auth-2fa"
import { isUsernameConflict, normalizeUsername } from "../core/identity"
import { UPLOAD_KEY_RE, storeImageUpload } from "../lib/upload"
import {
  deleteSessionById,
  deleteUserSessions,
  listUserSessions
} from "../core/session"
import { hashPassword, verifyPassword } from "../core/auth"
import { consumeCounter } from "../core/counters"
import {
  getImportTokenRow,
  issueImportToken,
  revokeImportToken,
  toImportTokenStatus
} from "../core/import-token"
import {
  getReadTokenRow,
  issueReadToken,
  revokeReadToken,
  toReadTokenStatus
} from "../core/read-token"
import { clearPasswordResetCredentials } from "../core/password-reset"
import { clientIp, readJsonBody } from "../lib/http"
import type { HonoEnv } from "../types"

export const meRoutes = new Hono<HonoEnv>()

/** `/api/me` 与 `PUT /api/me/profile` 共用同一份 DTO（头像只给 URL，不暴露 R2 key）。 */
function meDto(user: UserRow, twofa: Awaited<ReturnType<typeof twofaSummary>>) {
  return {
    id: user.id,
    username: user.username ?? "",
    email: user.email,
    role: user.role,
    avatarUrl: user.avatar_key ? `/api/files/${user.avatar_key}` : null,
    approvalStatus: user.approval_status,
    createdAt: user.created_at,
    twofa
  }
}

meRoutes.get("/", async (c) => {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const user = await findUserById(c.env.DB, prefix, userId)
  if (!user) return c.json({ error: "User not found" }, 404)

  return c.json(meDto(user, await twofaSummary(c.env.DB, prefix, userId)))
})

/**
 * 个人资料：只改显示名与头像。id / email 一律只读，不接受写入；
 * 头像必须是本人上传过、且 R2 里仍在的 key（null 表示清除）。前端已改走
 * `POST /api/me/avatar`，这里的 avatarKey 只作兼容保留。
 */
meRoutes.put("/profile", async (c) => {
  const body = await readJsonBody<{ username?: unknown; avatarKey?: unknown }>(
    c
  )
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400)
  }

  const hasUsername = body.username !== undefined
  const hasAvatar = body.avatarKey !== undefined
  if (!hasUsername && !hasAvatar) {
    return c.json({ error: "Nothing to update" }, 400)
  }

  let username: string | undefined
  if (hasUsername) {
    const normalized = normalizeUsername(body.username)
    if (!normalized) {
      return c.json(
        { error: "Invalid username", code: "INVALID_USERNAME" },
        400
      )
    }
    username = normalized
  }

  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const user = await findUserById(c.env.DB, prefix, userId)
  if (!user) return c.json({ error: "User not found" }, 404)

  // 改名撞名：username 是唯一对外身份（大小写不敏感），撞了回 409 让用户自己换，
  // 不自动加后缀。并发下两条请求同时改成同一个名字，由库内唯一索引兜底（见下）。
  if (
    username !== undefined &&
    (await usernameTaken(c.env.DB, prefix, username, userId))
  ) {
    return c.json(
      { error: "Username already taken", code: "USERNAME_TAKEN" },
      409
    )
  }

  let avatarKey: string | null | undefined
  if (hasAvatar) {
    if (body.avatarKey === null) {
      avatarKey = null
    } else {
      const candidate = typeof body.avatarKey === "string" ? body.avatarKey : ""
      const object = UPLOAD_KEY_RE.test(candidate)
        ? await c.env.R2.head(candidate)
        : null
      if (!object || object.customMetadata?.uploaderId !== String(userId)) {
        return c.json({ error: "Invalid avatar", code: "INVALID_AVATAR" }, 400)
      }
      avatarKey = candidate
    }
  }

  const updates: Record<string, unknown> = {}
  if (username !== undefined) updates.username = username
  if (avatarKey !== undefined) updates.avatar_key = avatarKey ?? ""
  try {
    await updateUser(c.env.DB, prefix, userId, updates)
  } catch (err) {
    // 查重与写入之间的竞态：库里唯一索引说了算，同样回 409 而不是 500。
    // 名字与头像在同一条 UPDATE 里，冲突时两列都不变。
    if (isUsernameConflict(err)) {
      return c.json(
        { error: "Username already taken", code: "USERNAME_TAKEN" },
        409
      )
    }
    throw err
  }

  const previous = user.avatar_key
  if (avatarKey !== undefined) {
    await deleteReplacedAvatar(c, previous, avatarKey ?? null)
  }

  const updated = (await findUserById(c.env.DB, prefix, userId)) ?? user
  return c.json(meDto(updated, await twofaSummary(c.env.DB, prefix, userId)))
})

/**
 * 换头像后的旧图清理：写库之后 best-effort 删除，删不掉不影响资料更新，
 * 最多在桶里留一个孤儿对象。PUT /profile 与 POST /avatar 共用这一份口径。
 */
async function deleteReplacedAvatar(
  c: Context<HonoEnv>,
  previous: string,
  next: string | null
): Promise<void> {
  if (!previous || previous === next) return
  try {
    await c.env.R2.delete(previous)
  } catch {
    // 旧图删不掉不影响资料更新，最多在桶里留一个孤儿对象。
  }
}

/**
 * 头像专用上传口（规格 §1）：multipart 单图，校验口径与 /api/files 完全一致，
 * 落 avatars/；同一请求里更新本人 avatar_key 并删除旧头像对象。响应与
 * `GET /api/me` 相同，前端一次拿到新的 avatarUrl 与完整资料。
 */
meRoutes.post("/avatar", async (c) => {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const user = await findUserById(c.env.DB, prefix, userId)
  if (!user) return c.json({ error: "User not found" }, 404)

  const stored = await storeImageUpload(c, userId, "avatars")
  if (!stored.ok) return stored.response

  await updateUser(c.env.DB, prefix, userId, { avatar_key: stored.image.key })
  await deleteReplacedAvatar(c, user.avatar_key, stored.image.key)

  const updated = (await findUserById(c.env.DB, prefix, userId)) ?? user
  return c.json(meDto(updated, await twofaSummary(c.env.DB, prefix, userId)))
})

meRoutes.put("/password", async (c) => {
  const body = await readJsonBody<{
    currentPassword?: unknown
    newPassword?: unknown
  }>(c)
  const currentPassword =
    typeof body?.currentPassword === "string" ? body.currentPassword : ""
  const newPassword =
    typeof body?.newPassword === "string" ? body.newPassword : ""
  if (!currentPassword || !newPassword) {
    return c.json({ error: "Current and new password required" }, 400)
  }
  if (newPassword.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400)
  }

  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const limit = await consumeCounter(c.env.DB, prefix, {
    action: "password_change",
    account: String(userId),
    ip: clientIp(c),
    windowSeconds: 300
  })
  if (limit.count > 5) {
    return c.json({ error: "Too many requests", code: "RATE_LIMITED" }, 429)
  }

  const user = await findUserById(c.env.DB, prefix, userId)
  if (!user) return c.json({ error: "User not found" }, 404)
  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    return c.json({ error: "Current password is incorrect" }, 403)
  }

  await updateUser(c.env.DB, prefix, userId, {
    password_hash: await hashPassword(newPassword)
  })
  await deleteUserSessions(c.env.DB, prefix, userId, c.get("sessionId"))
  // 主动改密维持原口径（保留当前会话），但旧密码发起的找回流程必须作废。
  await clearPasswordResetCredentials(c.env.DB, prefix, userId)
  return c.json({ success: true })
})

meRoutes.get("/sessions", async (c) => {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const currentId = c.get("sessionId")
  const sessions = await listUserSessions(c.env.DB, prefix, userId)
  return c.json(
    sessions.map((session) => ({
      id: session.id,
      createdAt: new Date(session.createdAt * 1000).toISOString(),
      lastSeenAt: new Date(session.lastSeenAt * 1000).toISOString(),
      ip: session.ip,
      userAgent: session.userAgent,
      current: session.id === currentId
    }))
  )
})

meRoutes.delete("/sessions/:id", async (c) => {
  const sessionId = c.req.param("id")
  if (sessionId === c.get("sessionId")) {
    return c.json({ error: "Use logout to end current session" }, 400)
  }
  const prefix = getTablePrefix(c.env)
  const removed = await deleteSessionById(
    c.env.DB,
    prefix,
    sessionId,
    c.get("userId")
  )
  if (!removed) return c.json({ error: "Session not found" }, 404)
  return c.json({ success: true })
})

// ── 个人导入令牌（会话 Cookie 鉴权；令牌本身只用于 /api/import/*） ──────────

/** 是否有可用令牌 + 时间线；永不返回哈希或明文。 */
meRoutes.get("/import-token", async (c) => {
  const prefix = getTablePrefix(c.env)
  const row = await getImportTokenRow(c.env.DB, prefix, c.get("userId"))
  return c.json(toImportTokenStatus(row))
})

/** 生成或重置：明文只在这一个响应里出现一次，库里只留 SHA-256。 */
meRoutes.post("/import-token", async (c) => {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const limit = await consumeCounter(c.env.DB, prefix, {
    action: "import_token",
    account: String(userId),
    windowSeconds: 300
  })
  if (limit.count > 10) {
    return c.json({ error: "Too many requests", code: "RATE_LIMITED" }, 429)
  }
  const { token, createdAt } = await issueImportToken(c.env.DB, prefix, userId)
  return c.json({ token, createdAt })
})

/** 吊销：从未生成过 404；已吊销再删仍成功（幂等）。 */
meRoutes.delete("/import-token", async (c) => {
  const prefix = getTablePrefix(c.env)
  const revoked = await revokeImportToken(c.env.DB, prefix, c.get("userId"))
  if (!revoked) return c.json({ error: "Import token not found" }, 404)
  return c.json({ success: true })
})

// ── 只读接口令牌（会话 Cookie 鉴权；令牌本身只用于 /api/read/*） ────────────
//
// 与导入令牌并列、互不通用：形状对齐 ImportTokenStatus / Issued，但存另一张表。
// 一期只有这三个管理端点（生成/重置/吊销），读接口本身没有任何写操作。

/** 是否有可用令牌 + 时间线；永不返回哈希或明文。 */
meRoutes.get("/read-token", async (c) => {
  const prefix = getTablePrefix(c.env)
  const row = await getReadTokenRow(c.env.DB, prefix, c.get("userId"))
  return c.json(toReadTokenStatus(row))
})

/** 生成或重置：明文只在这一个响应里出现一次，库里只留 SHA-256。 */
meRoutes.post("/read-token", async (c) => {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const limit = await consumeCounter(c.env.DB, prefix, {
    action: "read_token",
    account: String(userId),
    windowSeconds: 300
  })
  if (limit.count > 10) {
    return c.json({ error: "Too many requests", code: "RATE_LIMITED" }, 429)
  }
  const { token, createdAt } = await issueReadToken(c.env.DB, prefix, userId)
  return c.json({ token, createdAt })
})

/** 吊销：从未生成过 404；已吊销再删仍成功（幂等）。 */
meRoutes.delete("/read-token", async (c) => {
  const prefix = getTablePrefix(c.env)
  const revoked = await revokeReadToken(c.env.DB, prefix, c.get("userId"))
  if (!revoked) return c.json({ error: "Read token not found" }, 404)
  return c.json({ success: true })
})
