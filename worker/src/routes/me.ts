/**
 * 我的：资料、改密、会话列表/吊销、个人导入令牌（规格 §12.1）、接口令牌（只读/读写）。
 *
 * 接口令牌的旧单令牌端点在这里保留为过渡兼容（`schema_v3` 起同一张 `api_tokens`
 * 按 kind 区分）；B 单会用 `/api/me/tokens` 整体替换它们。
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
import { isLanguage, normalizeLanguage, type Language } from "../core/language"
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
  getLatestTokenRow,
  hasTokenOfKind,
  issueApiToken,
  revokeActiveTokensOfKind,
  setApiTokenScope
} from "../core/api-token"
import {
  getTokenScope,
  isScopeWithinSpaces,
  ownerVisibleSpaceIds,
  parseTokenScopeInput,
  type TokenKind,
  type TokenScope
} from "../core/token-scope"
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
    // 读出口再归一一次：库里若有支持集外的历史值，前端也不会拿到未知语言码。
    language: normalizeLanguage(user.language),
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
 * 个人资料：只改显示名、头像与界面语言。id / email 一律只读，不接受写入；
 * 头像必须是本人上传过、且 R2 里仍在的 key（null 表示清除）。前端已改走
 * `POST /api/me/avatar`，这里的 avatarKey 只作兼容保留。
 *
 * 语言（i18n 规格 §2.7）：支持集内值才收，非法 400 `INVALID_LANGUAGE`；三个字段
 * 互不影响、可单独提交，校验全部前置、落库仍是一次 UPDATE。
 */
meRoutes.put("/profile", async (c) => {
  const body = await readJsonBody<{
    username?: unknown
    avatarKey?: unknown
    language?: unknown
  }>(c)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400)
  }

  const hasUsername = body.username !== undefined
  const hasAvatar = body.avatarKey !== undefined
  const hasLanguage = body.language !== undefined
  if (!hasUsername && !hasAvatar && !hasLanguage) {
    return c.json({ error: "Nothing to update" }, 400)
  }

  let language: Language | undefined
  if (hasLanguage) {
    if (!isLanguage(body.language)) {
      return c.json(
        { error: "language must be zh or en", code: "INVALID_LANGUAGE" },
        400
      )
    }
    language = body.language
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
  if (language !== undefined) updates.language = language
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
  const { token, createdAt } = await issueImportToken(
    c.env.DB,
    prefix,
    userId,
    {
      replaceExisting: true
    }
  )
  return c.json({ token, createdAt })
})

/** 吊销：从未生成过 404；已吊销再删仍成功（幂等）。 */
meRoutes.delete("/import-token", async (c) => {
  const prefix = getTablePrefix(c.env)
  const revoked = await revokeImportToken(c.env.DB, prefix, c.get("userId"))
  if (!revoked) return c.json({ error: "Import token not found" }, 404)
  return c.json({ success: true })
})

// ── 令牌空间范围（规格 §2.3 / §2.4；读写两种令牌共用） ──────────────────

/** 范围相关的 400：形状非法、含不可见空间、设置类接口缺 `spaceIds`。 */
const INVALID_SPACE_SCOPE = {
  error: "Invalid space scope",
  code: "INVALID_SPACE_SCOPE"
} as const

type ScopeParseResult =
  | { ok: true; action: "keep" }
  | { ok: true; action: "set"; scope: TokenScope }
  | { ok: false; status: 400; payload: { error: string; code?: string } }

/**
 * 读并校验请求体里的 `spaceIds`：
 *
 * - 缺键：生成/重置类接口（`required: false`）保留现有范围，设置类接口必填；
 * - `null` = 清除范围（不限制）；非空整数数组 = 设成该范围（去重后升序存储）；
 * - 空数组、非数组、非整数元素一律 400，不部分写入；
 * - 每个 id 必须是令牌主人**当前可见**的空间（有任一空间角色，或主人是站点管理员），
 *   任一不满足则整单 400。
 */
async function parseScopeRequest(
  c: Context<HonoEnv>,
  options: { required: boolean }
): Promise<ScopeParseResult> {
  const raw = await c.req.text()
  let body: unknown = null
  if (raw.trim() !== "") {
    try {
      body = JSON.parse(raw) as unknown
    } catch {
      return {
        ok: false,
        status: 400,
        payload: { error: "Invalid request body" }
      }
    }
    // 有请求体但不是一个 JSON 对象（数组 / 标量）：同样是坏请求体，不静默当「未带」。
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return {
        ok: false,
        status: 400,
        payload: { error: "Invalid request body" }
      }
    }
  }
  const parsed = parseTokenScopeInput(body, options)
  if (!parsed.ok) {
    return { ok: false, status: 400, payload: INVALID_SPACE_SCOPE }
  }
  if (parsed.action === "keep") return parsed
  const prefix = getTablePrefix(c.env)
  const visible = await ownerVisibleSpaceIds(
    c.env.DB,
    prefix,
    c.get("userId"),
    c.get("role") === "admin"
  )
  if (!isScopeWithinSpaces(parsed.scope, visible)) {
    return { ok: false, status: 400, payload: INVALID_SPACE_SCOPE }
  }
  return parsed
}

// ── 接口令牌（`schema_v3` 起读写合表；这里保留旧单令牌端点做过渡兼容） ────
//
// 旧端点（GET/POST/DELETE /api/me/read-token、/api/me/write-token 及其 /spaces）
// 的唯一消费者是自家前端，B 单会用 /api/me/tokens 整体替换它们；在那之前这里用
// 新存储保持旧语义：每用户每类只有一枚有效令牌，重置/删除作用于该类全部有效行，
// 范围跟着令牌行走（GET 取最新一行，重置未带 spaceIds 时复制它的那一份范围）。

/** 旧端点的状态 DTO（形状与二期完全一致，永不返回哈希或明文）。 */
function legacyTokenStatus(
  row: {
    created_at: string
    last_used_at: string | null
    revoked_at: string | null
  } | null,
  spaceIds: TokenScope
) {
  return {
    active: Boolean(row && !row.revoked_at),
    createdAt: row?.created_at ?? null,
    lastUsedAt: row?.last_used_at ?? null,
    revokedAt: row?.revoked_at ?? null,
    spaceIds
  }
}

async function legacyTokenStatusResponse(
  c: Context<HonoEnv>,
  kind: TokenKind
): Promise<Response> {
  const prefix = getTablePrefix(c.env)
  const row = await getLatestTokenRow(c.env.DB, prefix, c.get("userId"), kind)
  const spaceIds = row ? await getTokenScope(c.env.DB, prefix, row.id) : null
  return c.json(legacyTokenStatus(row, spaceIds))
}

/** 生成或重置：先吊销该类全部有效行，再建新行；明文只在这一个响应里出现一次。 */
async function legacyIssueToken(
  c: Context<HonoEnv>,
  kind: TokenKind
): Promise<Response> {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const scope = await parseScopeRequest(c, { required: false })
  if (!scope.ok) return c.json(scope.payload, scope.status)
  const limit = await consumeCounter(c.env.DB, prefix, {
    action: kind === "read" ? "read_token" : "write_token",
    account: String(userId),
    windowSeconds: 300
  })
  if (limit.count > 10) {
    return c.json({ error: "Too many requests", code: "RATE_LIMITED" }, 429)
  }

  const previous = await getLatestTokenRow(c.env.DB, prefix, userId, kind)
  // 不带 spaceIds = 保留现有范围（重置不悄悄放大）；没有旧令牌则保持不限制。
  const nextScope: TokenScope | undefined =
    scope.action === "set"
      ? scope.scope
      : previous
        ? await getTokenScope(c.env.DB, prefix, previous.id)
        : undefined

  const { token, createdAt } = await issueApiToken(c.env.DB, prefix, userId, {
    kind,
    scope: nextScope,
    replaceExistingKind: true
  })
  return c.json({ token, createdAt })
}

/** 吊销：从未生成过 404；已吊销再删仍成功（幂等）。 */
async function legacyRevokeToken(
  c: Context<HonoEnv>,
  kind: TokenKind,
  notFoundMessage: string
): Promise<Response> {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const revoked = await revokeActiveTokensOfKind(c.env.DB, prefix, userId, kind)
  if (
    revoked === 0 &&
    !(await hasTokenOfKind(c.env.DB, prefix, userId, kind))
  ) {
    return c.json({ error: notFoundMessage }, 404)
  }
  return c.json({ success: true })
}

/** 只改范围、不换令牌：写该 kind 的最新一行；没有任何行时 404。 */
async function legacySetTokenScope(
  c: Context<HonoEnv>,
  kind: TokenKind
): Promise<Response> {
  const prefix = getTablePrefix(c.env)
  const scope = await parseScopeRequest(c, { required: true })
  if (!scope.ok) return c.json(scope.payload, scope.status)
  if (scope.action !== "set") return c.json(INVALID_SPACE_SCOPE, 400)
  const row = await getLatestTokenRow(c.env.DB, prefix, c.get("userId"), kind)
  if (!row) return c.json({ error: "Token not found" }, 404)
  await setApiTokenScope(c.env.DB, prefix, row.id, scope.scope)
  return c.json({ spaceIds: scope.scope })
}

meRoutes.get("/read-token", (c) => legacyTokenStatusResponse(c, "read"))

/**
 * 生成或重置只读令牌：明文只出现一次；`spaceIds` 缺省 = 沿用旧令牌的范围。
 */
meRoutes.post("/read-token", (c) => legacyIssueToken(c, "read"))

/** 吊销：从未生成过 404；已吊销再删仍成功（幂等）。范围行不动。 */
meRoutes.delete("/read-token", (c) =>
  legacyRevokeToken(c, "read", "Read token not found")
)

meRoutes.put("/read-token/spaces", (c) => legacySetTokenScope(c, "read"))

// ── 读写接口令牌（旧端点过渡兼容；令牌用于 /api/write/*，读接口也认） ────

meRoutes.get("/write-token", (c) => legacyTokenStatusResponse(c, "write"))

/** 生成或重置：明文只出现一次；`spaceIds` 缺省 = 沿用旧令牌的范围。 */
meRoutes.post("/write-token", (c) => legacyIssueToken(c, "write"))

/** 吊销：从未生成过 404；已吊销再删仍成功（幂等）。范围行不动。 */
meRoutes.delete("/write-token", (c) =>
  legacyRevokeToken(c, "write", "Write token not found")
)

meRoutes.put("/write-token/spaces", (c) => legacySetTokenScope(c, "write"))
