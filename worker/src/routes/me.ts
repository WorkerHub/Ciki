/**
 * 我的：资料、改密、会话列表/吊销、接口令牌（多行、按 id 管理）、
 * 浏览器插件凭证（多行导入令牌，规格 §12.1）。
 *
 * 令牌一律按行操作：列表只回未吊销行，创建是追加，改名/改范围/吊销只作用于指定
 * id；非本人 / 不存在 / 已吊销统一 404。令牌本身只用于 `/api/read/*`、
 * `/api/write/*`（接口令牌）与 `/api/import/*`（导入凭证），管理端点只认会话 Cookie。
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
  issueImportToken,
  listActiveImportTokens,
  parseImportTokenName,
  revokeImportTokenById
} from "../core/import-token"
import {
  getTokenRowById,
  issueApiToken,
  listActiveTokens,
  parseTokenName,
  parseTokenNameUpdate,
  renameToken,
  revokeTokenById,
  setApiTokenScope,
  type ApiTokenRow
} from "../core/api-token"
import {
  isScopeWithinSpaces,
  listUserTokenScopes,
  ownerVisibleSpaceIds,
  parseTokenScopeInput,
  type TokenScope
} from "../core/token-scope"
import { clearPasswordResetCredentials } from "../core/password-reset"
import { clientIp, parseId, readJsonBody } from "../lib/http"
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

// ── 接口令牌与导入凭证（多行；`schema_v3` 起读写合表、导入按行） ────────────
//
// 一个令牌一行、按 id 操作：列表只回未吊销行，创建是追加（不再「重置即覆盖」），
// 改名 / 改范围 / 吊销都只作用于指定 id，非本人 / 不存在 / 已吊销一律 404。
// 明文只在创建响应里出现一次，库里只有 SHA-256（core/api-token.ts）。

/** 令牌类接口的 404：非本人、不存在、已吊销三种情况同一口径（不泄露存在性）。 */
const TOKEN_NOT_FOUND = { error: "Token not found" } as const
const IMPORT_TOKEN_NOT_FOUND = { error: "Import token not found" } as const

/** 范围相关的 400：形状非法、含不可见空间、设置类接口缺 `spaceIds`。 */
const INVALID_SPACE_SCOPE = {
  error: "Invalid space scope",
  code: "INVALID_SPACE_SCOPE"
} as const

/** 名称非法的 400：创建与改名共用一个错误体，改名的文案写明长度口径。 */
const INVALID_TOKEN_NAME = { error: "Invalid token name" } as const
const INVALID_TOKEN_NAME_EDIT = {
  error: "Token name must be 1-40 characters"
} as const

type JsonObjectResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response }

/**
 * 读一次请求体并归一成 JSON 对象：空体按 `{}` 处理（创建类接口容忍空体），
 * JSON 非法或不是对象（数组 / 标量）回 400「Invalid request body」。
 *
 * kind / name / spaceIds 都从这同一份对象里取，所以请求体只读一次——不能一个
 * 校验函数 reread `c.req.text()`、另一个再也读一遍。
 */
async function readJsonObject(c: Context<HonoEnv>): Promise<JsonObjectResult> {
  const raw = await c.req.text()
  if (raw.trim() === "") return { ok: true, body: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return {
      ok: false,
      response: c.json({ error: "Invalid request body" }, 400)
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      response: c.json({ error: "Invalid request body" }, 400)
    }
  }
  return { ok: true, body: parsed as Record<string, unknown> }
}

type ScopeParseResult =
  | { ok: true; action: "keep" }
  | { ok: true; action: "set"; scope: TokenScope }
  | { ok: false; status: 400; payload: { error: string; code?: string } }

/**
 * 校验请求体里的 `spaceIds`：
 *
 * - 缺键：创建类接口（`required: false`）表示「不限范围」；设置类接口必填；
 * - `null` = 清除范围（不限制）；非空整数数组 = 设成该范围（去重后升序存储）；
 * - 空数组、非数组、非整数元素一律 400，不部分写入；
 * - 每个 id 必须是令牌主人**当前可见**的空间（有任一空间角色，或主人是站点管理员），
 *   任一不满足则整单 400、零写入。
 */
async function parseScopeRequest(
  c: Context<HonoEnv>,
  body: Record<string, unknown>,
  options: { required: boolean }
): Promise<ScopeParseResult> {
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

/** 列表行与创建回执共用的令牌 DTO（时间字段原样取库里的 ISO 文本）。 */
function tokenSummary(row: ApiTokenRow, spaceIds: TokenScope) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    spaceIds,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at
  }
}

/** 本人的全部有效令牌，按创建时间升序（吊销行不出现）；范围一次查齐。 */
meRoutes.get("/tokens", async (c) => {
  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const rows = await listActiveTokens(c.env.DB, prefix, userId)
  const scopes = await listUserTokenScopes(c.env.DB, prefix, userId)
  return c.json({
    tokens: rows.map((row) => tokenSummary(row, scopes.get(row.id) ?? null))
  })
})

/**
 * 新建一枚接口令牌：`kind` 必填（建行后不可变更），`spaceIds` 缺省 / `null` = 不限
 * 范围；空数组与含不可见空间的 id 整单 400、一行不写。明文只在这条响应里出现一次。
 */
meRoutes.post("/tokens", async (c) => {
  const body = await readJsonObject(c)
  if (!body.ok) return body.response

  const kind = body.body.kind
  if (kind !== "read" && kind !== "write") {
    return c.json({ error: "kind must be read or write" }, 400)
  }
  const name = parseTokenName(body.body.name, kind)
  if (!name.ok) return c.json(INVALID_TOKEN_NAME, 400)

  const scope = await parseScopeRequest(c, body.body, { required: false })
  if (!scope.ok) return c.json(scope.payload, scope.status)
  // 创建是「新行」：缺省 / null 一律落成「不限制」，没有可继承的旧范围。
  const nextScope: TokenScope = scope.action === "set" ? scope.scope : null

  const prefix = getTablePrefix(c.env)
  const userId = c.get("userId")
  const limit = await consumeCounter(c.env.DB, prefix, {
    action: kind === "read" ? "read_token" : "write_token",
    account: String(userId),
    windowSeconds: 300
  })
  if (limit.count > 10) {
    return c.json({ error: "Too many requests", code: "RATE_LIMITED" }, 429)
  }

  const issued = await issueApiToken(c.env.DB, prefix, userId, {
    kind,
    name: name.name,
    scope: nextScope
  })
  return c.json(
    {
      id: issued.id,
      name: name.name,
      kind,
      spaceIds: nextScope,
      token: issued.token
    },
    201
  )
})

/** 改名：空白与超限都 400（改名不是「恢复默认名」）；只有本人的未吊销行可改。 */
meRoutes.put("/tokens/:id/name", async (c) => {
  const body = await readJsonObject(c)
  if (!body.ok) return body.response
  const name = parseTokenNameUpdate(body.body.name)
  if (!name.ok) return c.json(INVALID_TOKEN_NAME_EDIT, 400)

  const tokenId = parseId(c.req.param("id"))
  if (tokenId === null) return c.json(TOKEN_NOT_FOUND, 404)
  const renamed = await renameToken(
    c.env.DB,
    getTablePrefix(c.env),
    c.get("userId"),
    tokenId,
    name.name
  )
  if (!renamed) return c.json(TOKEN_NOT_FOUND, 404)
  return c.json({ success: true })
})

/**
 * 只改空间范围、不换令牌：`spaceIds` 必填（`null` 清除 = 不限制）。
 * 已吊销的行不再可管理，与非本人 / 不存在同为 404。
 */
meRoutes.put("/tokens/:id/spaces", async (c) => {
  const body = await readJsonObject(c)
  if (!body.ok) return body.response
  const scope = await parseScopeRequest(c, body.body, { required: true })
  if (!scope.ok) return c.json(scope.payload, scope.status)
  if (scope.action !== "set") return c.json(INVALID_SPACE_SCOPE, 400)

  const tokenId = parseId(c.req.param("id"))
  if (tokenId === null) return c.json(TOKEN_NOT_FOUND, 404)
  const prefix = getTablePrefix(c.env)
  const row = await getTokenRowById(c.env.DB, prefix, c.get("userId"), tokenId)
  if (!row || row.revoked_at) return c.json(TOKEN_NOT_FOUND, 404)

  await setApiTokenScope(c.env.DB, prefix, tokenId, scope.scope)
  return c.json({ spaceIds: scope.scope })
})

/** 吊销：成功后该令牌立即 401；已吊销（或非本人）再来 404，范围行不删。 */
meRoutes.delete("/tokens/:id", async (c) => {
  const tokenId = parseId(c.req.param("id"))
  if (tokenId === null) return c.json(TOKEN_NOT_FOUND, 404)
  const revoked = await revokeTokenById(
    c.env.DB,
    getTablePrefix(c.env),
    c.get("userId"),
    tokenId
  )
  if (!revoked) return c.json(TOKEN_NOT_FOUND, 404)
  return c.json({ success: true })
})

// ── 浏览器插件凭证（多行、互不影响；没有空间范围） ──────────────────────

/** 本人的全部有效导入凭证，按创建时间升序；永不返回哈希或明文。 */
meRoutes.get("/import-tokens", async (c) => {
  const rows = await listActiveImportTokens(
    c.env.DB,
    getTablePrefix(c.env),
    c.get("userId")
  )
  return c.json({
    tokens: rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at
    }))
  })
})

/** 新建一枚导入凭证：`name` 缺省 / 空白用默认名「浏览器插件」，明文只此一次。 */
meRoutes.post("/import-tokens", async (c) => {
  const body = await readJsonObject(c)
  if (!body.ok) return body.response
  const name = parseImportTokenName(body.body.name)
  if (!name.ok) return c.json(INVALID_TOKEN_NAME, 400)

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

  const issued = await issueImportToken(c.env.DB, prefix, userId, {
    name: name.name
  })
  return c.json({ id: issued.id, name: name.name, token: issued.token }, 201)
})

/** 吊销单枚导入凭证：只断这一枚，其它凭证继续可用；非本人 / 已吊销 404。 */
meRoutes.delete("/import-tokens/:id", async (c) => {
  const tokenId = parseId(c.req.param("id"))
  if (tokenId === null) return c.json(IMPORT_TOKEN_NOT_FOUND, 404)
  const revoked = await revokeImportTokenById(
    c.env.DB,
    getTablePrefix(c.env),
    c.get("userId"),
    tokenId
  )
  if (!revoked) return c.json(IMPORT_TOKEN_NOT_FOUND, 404)
  return c.json({ success: true })
})
