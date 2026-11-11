/**
 * 鉴权：注册 / 登录 / 登出 / 刷新 / 公开站点配置。
 *
 * - 注册默认开启、默认需管理员批准；首个注册者直接成为管理员并批准。
 * - 登录限流与失败锁定以 D1 计数表为唯一权威（规格补遗）。
 * - 会话是单枚不透明 Cookie（core/session.ts），库里只存 SHA-256。
 */
import { Hono } from "hono"
import type { Context } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import { getBooleanSetting, getSetting } from "../db/queries/settings"
import {
  createUserFirstIsAdmin,
  findUserByEmail,
  findUserById,
  markEmailVerified,
  type UserRow
} from "../db/queries/users"
import { joinDefaultSpace } from "../db/queries/spaces"
import { countPasskeys } from "../db/queries/passkeys"
import { getTotp } from "../db/queries/totp"
import { hashPassword, randomToken, verifyPassword } from "../core/auth"
import {
  clearSessionCookie,
  deleteSessionByToken,
  findSession,
  readSessionToken,
  rotateSession,
  setSessionCookie
} from "../core/session"
import { challengeKeyForToken, putChallenge } from "../core/challenges"
import {
  clearAccountCounters,
  consumeCounter,
  lockedUntil,
  setLock
} from "../core/counters"
import {
  clientIp,
  issueSession,
  readJsonBody,
  runInBackground
} from "../lib/http"
import {
  DEFAULT_SITE_NAME,
  defaultUsernameFromEmail,
  isEmailConflict
} from "../core/identity"
import { insertWithUniqueUsername } from "../core/username"
import { isEmailConfigured, sendEmailCodeMessage } from "../services/email"
import {
  armEmailCodeCooldown,
  consumeEmailCodeSendLimits,
  consumeEmailCodeVerifyLimits,
  consumePasswordResetSubmitLimit,
  EMAIL_CODE_COOLDOWN_SECONDS,
  hashEmailCode,
  issueEmailCode,
  resetEmailCodeVerifyCounter,
  verifyEmailCode
} from "../core/email-code"
import {
  applyPasswordReset,
  issuePasswordResetToken,
  PASSWORD_RESET_TOKEN_TTL_SECONDS,
  readPasswordResetToken
} from "../core/password-reset"
import type { HonoEnv } from "../types"

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

/** 用户不存在时也跑一遍同等成本的校验，避免用响应时间探测邮箱是否存在。 */
const DUMMY_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000"

/**
 * 找回密码验码的等成本假用户：账号不存在时也在它上面跑一遍同一条
 * `SHA-256("password_reset:<id>:<code>")`，用时与真实校验一致。
 */
const PASSWORD_RESET_DUMMY_USER_ID = 0

/** 注册邮箱验证的等成本假用户：账号不存在/不可验证时也跑一遍同一条 SHA-256。 */
const EMAIL_VERIFY_DUMMY_USER_ID = 0

const LOGIN_WINDOW = 300
const LOGIN_LIMIT = 10
const FAIL_WINDOW = 900
const FAIL_LIMIT = 5

export function publicUser(user: UserRow) {
  return { id: user.id, email: user.email, role: user.role }
}

/**
 * 找回密码只对「能登录的账号」生效：仍激活且已批准。
 * 未知、已停用、未批准/已拒绝一律按同一路径静默处理，不暴露账号状态。
 */
function canResetPassword(user: UserRow): boolean {
  return user.is_active === 1 && user.approval_status === "approved"
}

export const authRoutes = new Hono<HonoEnv>()

/** 公开站点配置：登录页据 registrationEnabled 决定是否展示注册入口。 */
authRoutes.get("/config", async (c) => {
  const prefix = getTablePrefix(c.env)
  const emailConfigured = await isEmailConfigured(c.env)
  try {
    return c.json({
      siteName:
        (await getSetting(c.env.DB, prefix, "site_name")) ?? DEFAULT_SITE_NAME,
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
      emailConfigured
    })
  } catch {
    return c.json({
      siteName: DEFAULT_SITE_NAME,
      registrationEnabled: true,
      registrationApprovalRequired: true,
      emailConfigured
    })
  }
})

authRoutes.post("/register", async (c) => {
  const body = await readJsonBody<{ email?: unknown; password?: unknown }>(c)
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
  const ip = clientIp(c)
  const limit = await consumeCounter(c.env.DB, prefix, {
    action: "register",
    ip,
    windowSeconds: 300
  })
  if (limit.count > 5) {
    return c.json({ error: "Too many requests", code: "RATE_LIMITED" }, 429)
  }

  const registrationEnabled = await getBooleanSetting(
    c.env.DB,
    prefix,
    "registration_enabled",
    true
  )
  if (!registrationEnabled) {
    return c.json(
      { error: "Registration is disabled", code: "REGISTRATION_DISABLED" },
      403
    )
  }

  if (await findUserByEmail(c.env.DB, prefix, email)) {
    return c.json(
      { error: "Email already registered", code: "EMAIL_TAKEN" },
      409
    )
  }

  // 注册必须走邮箱验证：站点发不出信时不让任何人落一个「永远验证不了」的账号。
  // 首个用户（站点管理员）免验证，所以这一条只拦非首个用户。
  //
  // 判断必须和建号在同一条语句里：插入前先 COUNT 再决定，两个并发请求会都以为
  // 自己是第一个（一个成了管理员，另一个带着未验证账号落库、却再也发不出信）。
  // 所以「没配发信」时把 `requireEmptyTable` 传给建号语句，写库那一刻表已非空就
  // 一行不写、这里回 503——与冻结契约「不建号」严格一致。
  const emailConfigured = await isEmailConfigured(c.env)

  const approvalRequired = await getBooleanSetting(
    c.env.DB,
    prefix,
    "registration_approval_required",
    true
  )
  const passwordHash = await hashPassword(password)
  let id: number | null
  try {
    // 显示名取邮箱前缀；重名自动加 -2、-3（大小写不敏感）。查重与写入之间的
    // 竞态由唯一索引兜底，insertWithUniqueUsername 会换下一个后缀重试。
    id = await insertWithUniqueUsername(
      c.env.DB,
      prefix,
      defaultUsernameFromEmail(email),
      (username) =>
        createUserFirstIsAdmin(
          c.env.DB,
          prefix,
          {
            email,
            username,
            password_hash: passwordHash,
            approvalStatus: approvalRequired ? "pending" : "approved"
          },
          { requireEmptyTable: !emailConfigured }
        )
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
  // 没配发信、且这条 INSERT 被「只接受首个用户」的守卫拦下：一个字节都没写。
  if (id === null) {
    return c.json(
      {
        error: "Email delivery is not configured",
        code: "EMAIL_NOT_CONFIGURED"
      },
      503
    )
  }

  const user = await findUserById(c.env.DB, prefix, id)
  await joinDefaultSpace(c.env.DB, prefix, id, user?.role ?? "user")

  // 未验证的发信放在 `waitUntil` 里：注册响应不等 SMTP。发不发以回读到的真实
  // `email_verified` 为准（首个管理员是 1），不靠上面那次 COUNT 的结论。
  if (user && user.email_verified === 0) {
    await runInBackground(c, async () => {
      // 与找回密码同口径：注册这一封也算「刚发过码」，arm 60 秒冷却，免得用户
      // 立刻点重发把刚收到的码作废。限流器异常不拦发信（邮件才是关键路径）。
      try {
        await armEmailCodeCooldown(c.env.DB, prefix, {
          purpose: "register_verify",
          accountKey: user.email
        })
      } catch {
        console.error("register verification cooldown failed")
      }
      const issued = await issueEmailCode(c.env.DB, prefix, {
        userId: user.id,
        purpose: "register_verify"
      })
      const sent = await sendEmailCodeMessage(c.env, {
        to: user.email,
        code: issued.code,
        purpose: "register_verify"
      })
      if (!sent.success) {
        // 失败只记脱敏原因；不回显、不记收件人。
        console.error("register verification email failed:", sent.error)
      }
    })
  }

  return c.json(
    {
      success: true,
      approvalRequired: user?.approval_status === "pending",
      emailVerificationRequired: user ? user.email_verified === 0 : false
    },
    201
  )
})

authRoutes.post("/login", async (c) => {
  const body = await readJsonBody<{ email?: unknown; password?: unknown }>(c)
  const email =
    typeof body?.email === "string" ? body.email.trim().toLowerCase() : ""
  const password = typeof body?.password === "string" ? body.password : ""
  if (!email || !password) {
    return c.json({ error: "Email and password required" }, 400)
  }

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const ip = clientIp(c)

  const limit = await consumeCounter(db, prefix, {
    action: "login",
    ip,
    windowSeconds: LOGIN_WINDOW
  })
  if (limit.count > LOGIN_LIMIT) {
    const retryAfter = Math.max(
      1,
      limit.windowStart + LOGIN_WINDOW - Math.floor(Date.now() / 1000)
    )
    return c.json(
      { error: "Too many requests", code: "RATE_LIMITED", retryAfter },
      429
    )
  }

  const locked = await lockedUntil(db, prefix, {
    action: "login_fail",
    account: email,
    ip
  })
  if (locked) {
    return c.json(
      {
        error: "Account locked",
        code: "ACCOUNT_LOCKED",
        retryAfter: Math.max(1, locked - Math.floor(Date.now() / 1000))
      },
      429
    )
  }

  const user = await findUserByEmail(db, prefix, email)
  let valid = false
  if (user) {
    valid = await verifyPassword(password, user.password_hash)
  } else {
    // 与真实校验同成本，避免用响应时间探测邮箱是否存在。
    await verifyPassword(password, DUMMY_HASH)
  }

  if (!user || !valid) {
    const failures = await consumeCounter(db, prefix, {
      action: "login_fail",
      account: email,
      ip,
      windowSeconds: FAIL_WINDOW
    })
    if (failures.count >= FAIL_LIMIT) {
      await setLock(
        db,
        prefix,
        { action: "login_fail", account: email, ip },
        Math.floor(Date.now() / 1000) + FAIL_WINDOW
      )
    }
    return c.json({ error: "Invalid credentials" }, 401)
  }

  // 顺序：已拒绝 → 未验证 → 待审批 → 停用。
  //
  // 未验证排在待审批之前：验证是用户自己能完成的动作，登录页据这个错误码给出
  // 「重新发送验证码」；验证完再提示等待审批。
  // 「停用」必须排在审批判定之后：待审批/已拒绝的账号本身就是 is_active=0，
  // 提前判停用会把这两种状态吞成笼统的 401（口径变化）。
  if (user.approval_status === "rejected") {
    return c.json(
      { error: "Account was rejected", code: "ACCOUNT_REJECTED" },
      403
    )
  }
  if (user.email_verified === 0) {
    return c.json(
      { error: "Email not verified", code: "EMAIL_NOT_VERIFIED" },
      403
    )
  }
  if (user.approval_status === "pending") {
    return c.json(
      {
        error: "Account pending approval",
        code: "ACCOUNT_PENDING_APPROVAL"
      },
      403
    )
  }
  if (!user.is_active) {
    return c.json({ error: "Invalid credentials" }, 401)
  }

  await clearAccountCounters(db, prefix, "login_fail", email)

  // availableMethods 顺序固定 totp → passkey → email_otp；email_otp 还要站点能发信。
  // 「已开启的方式全被过滤为空」绝不静默降级成只验密码：直接 403 失败关闭。
  const totp = await getTotp(db, prefix, user.id)
  const passkeys = await countPasskeys(db, prefix, user.id)
  const totpEnabled = Boolean(totp?.totp_enabled)
  const passkeyEnabled = passkeys > 0
  const emailOtpEnabled = Boolean(totp?.email_otp_enabled)
  const emailConfigured = emailOtpEnabled
    ? await isEmailConfigured(c.env)
    : false

  const methods: string[] = []
  if (totpEnabled) methods.push("totp")
  if (passkeyEnabled) methods.push("passkey")
  if (emailOtpEnabled && emailConfigured) methods.push("email_otp")

  if (
    methods.length === 0 &&
    (totpEnabled || passkeyEnabled || emailOtpEnabled)
  ) {
    return c.json(
      {
        error: "Two-factor method unavailable",
        code: "2FA_METHOD_UNAVAILABLE"
      },
      403
    )
  }

  if (methods.length > 0) {
    const tempToken = randomToken()
    const key = await challengeKeyForToken(tempToken)
    await putChallenge(db, prefix, {
      key,
      userId: user.id,
      purpose: "2fa_login",
      payload: "",
      ttlSeconds: 300
    })
    return c.json({
      requires2fa: true,
      tempToken,
      availableMethods: methods
    })
  }

  const require2fa = await getBooleanSetting(db, prefix, "require_2fa", false)
  const needs2faSetup = require2fa && methods.length === 0
  await issueSession(c, user.id, needs2faSetup)

  return c.json({
    success: true,
    user: publicUser(user),
    ...(needs2faSetup ? { needs2faSetup: true } : {})
  })
})

authRoutes.post("/logout", async (c) => {
  const token = readSessionToken(c)
  if (token) {
    const prefix = getTablePrefix(c.env)
    await deleteSessionByToken(c.env.DB, prefix, token)
  }
  clearSessionCookie(c)
  return c.json({ success: true })
})

authRoutes.post("/refresh", async (c) => {
  const token = readSessionToken(c)
  if (!token) {
    return c.json({ error: "No session" }, 401)
  }
  const prefix = getTablePrefix(c.env)
  const session = await findSession(c.env.DB, prefix, token)
  if (!session) {
    clearSessionCookie(c)
    return c.json({ error: "Session revoked" }, 401)
  }
  const next = await rotateSession(c.env.DB, prefix, session.sessionId)
  if (!next) {
    clearSessionCookie(c)
    return c.json({ error: "Session revoked" }, 401)
  }
  setSessionCookie(c, next)
  return c.json({ success: true })
})

// ── 邮箱找回密码（#48 冻结契约的 #51 落地部分） ────────────────────────────────
//
// 三步：forgot（发码）→ verify（验码换一次性 resetToken）→ reset（用令牌设密）。
// 防枚举：发码对「存在/不存在/停用/发送失败」都是同一个 200，发码与发信放在
// `waitUntil` 里、响应不等待 SMTP；验码对「账号不存在/码错/过期」都是同一个 400。
// 限频一律复用 core/email-code.ts 与 core/counters.ts（purpose = password_reset，
// account = 小写 trim 邮箱，未知邮箱也计数）。

/** 找回密码的对外唯一「发码已接受」响应（冷却期内也是它）。 */
function passwordForgotAccepted(c: Context<HonoEnv>) {
  return c.json({
    success: true as const,
    cooldownSeconds: EMAIL_CODE_COOLDOWN_SECONDS
  })
}

/** 验码失败的唯一响应：账号不存在、已停用、码错、过期一律用它。 */
function invalidResetCode(c: Context<HonoEnv>) {
  return c.json({ error: "Invalid or expired code", code: "INVALID_CODE" }, 400)
}

/** resetToken 无效的唯一响应：不存在、过期、已用、用户已不可用一律用它。 */
function invalidResetToken(c: Context<HonoEnv>) {
  return c.json(
    { error: "Invalid or expired reset token", code: "INVALID_RESET_TOKEN" },
    400
  )
}

/**
 * 第一步：向账号邮箱发一枚 `password_reset` 验证码（公开）。
 *
 * 顺序固定：邮箱格式 → 站点发信 → 限频（cd → send → send_ip）→ 查账号。
 * - 站点未配置 SMTP：503 `EMAIL_NOT_CONFIGURED`，不写任何计数（站点级公共事实）；
 * - 冷却期内重复请求：200 但不重发；小时配额用尽：429 带 `retryAfter`；
 * - 账号存在且可用才写码并发信，而且两者都在 `waitUntil` 里完成——响应不等 SMTP，
 *   响应时间不随账号存在与否变化；未知/停用/已拒绝账号不写码、不发信，仍回同一个 200。
 */
authRoutes.post("/password/forgot", async (c) => {
  const body = await readJsonBody<{ email?: unknown }>(c)
  const email =
    typeof body?.email === "string" ? body.email.trim().toLowerCase() : ""
  if (!email || !EMAIL_RE.test(email)) {
    return c.json({ error: "Invalid email format", code: "INVALID_EMAIL" }, 400)
  }

  if (!(await isEmailConfigured(c.env))) {
    return c.json(
      {
        error: "Email delivery is not configured",
        code: "EMAIL_NOT_CONFIGURED"
      },
      503
    )
  }

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const limits = await consumeEmailCodeSendLimits(db, prefix, {
    purpose: "password_reset",
    accountKey: email,
    ip: clientIp(c)
  })
  if (!limits.allowed) {
    if (limits.scope === "cooldown") return passwordForgotAccepted(c)
    return c.json(
      {
        error: "Too many requests",
        code: "RATE_LIMITED",
        retryAfter: limits.retryAfter
      },
      429
    )
  }

  const user = await findUserByEmail(db, prefix, email)
  if (!user || !canResetPassword(user)) return passwordForgotAccepted(c)

  await runInBackground(c, async () => {
    const issued = await issueEmailCode(db, prefix, {
      userId: user.id,
      purpose: "password_reset"
    })
    const sent = await sendEmailCodeMessage(c.env, {
      to: user.email,
      code: issued.code,
      purpose: "password_reset"
    })
    if (!sent.success) {
      // 失败只记脱敏原因；不回显、不记收件人（防枚举）。
      console.error("password reset email failed:", sent.error)
    }
  })

  return passwordForgotAccepted(c)
})

/**
 * 第二步：验码换一次性 resetToken（公开）。
 *
 * 账号不存在时不做任何查询短路以外的差异化处理：照样消耗一次按邮箱计的限频，
 * 照样在固定的假 userId 上跑一遍同成本的 SHA-256，然后回同一个 400。
 * 验码成功时清掉该邮箱的验码失败计数，签发 `auth_challenges` 里的 resetToken
 * （purpose = password_reset、payload = userId、TTL 600 秒，库里只存 SHA-256）。
 */
authRoutes.post("/password/verify", async (c) => {
  const body = await readJsonBody<{ email?: unknown; code?: unknown }>(c)
  const email =
    typeof body?.email === "string" ? body.email.trim().toLowerCase() : ""
  const code = typeof body?.code === "string" ? body.code.trim() : ""
  if (!email || !EMAIL_RE.test(email) || !code) return invalidResetCode(c)

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const limits = await consumeEmailCodeVerifyLimits(db, prefix, {
    purpose: "password_reset",
    accountKey: email,
    ip: clientIp(c)
  })
  if (!limits.allowed) {
    return c.json(
      {
        error: "Too many requests",
        code: "RATE_LIMITED",
        retryAfter: limits.retryAfter
      },
      429
    )
  }

  const user = await findUserByEmail(db, prefix, email)
  if (!user || !canResetPassword(user)) {
    await hashEmailCode("password_reset", PASSWORD_RESET_DUMMY_USER_ID, code)
    return invalidResetCode(c)
  }

  const verified = await verifyEmailCode(db, prefix, {
    userId: user.id,
    purpose: "password_reset",
    code
  })
  if (!verified) return invalidResetCode(c)

  await resetEmailCodeVerifyCounter(db, prefix, {
    purpose: "password_reset",
    accountKey: email
  })
  const resetToken = await issuePasswordResetToken(db, prefix, user.id)
  return c.json({
    success: true as const,
    resetToken,
    expiresIn: PASSWORD_RESET_TOKEN_TTL_SECONDS
  })
})

/**
 * 第三步：用 resetToken 设新密码（公开，只认令牌、不传邮箱）。
 *
 * 成功口径（用户已确认的冻结结论）：该用户**全部会话**失效（含发起重置前已登录的）、
 * 删除其全部 auth_challenges 与 email_codes、不自动登录也不下发 Cookie。
 * 强度校验失败（400 `WEAK_PASSWORD`）不消费令牌，用户可换个合格密码继续用同一枚令牌。
 */
authRoutes.post("/password/reset", async (c) => {
  const body = await readJsonBody<{
    resetToken?: unknown
    newPassword?: unknown
  }>(c)
  const resetToken =
    typeof body?.resetToken === "string" ? body.resetToken.trim() : ""
  const newPassword =
    typeof body?.newPassword === "string" ? body.newPassword : ""

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const userId = await readPasswordResetToken(db, prefix, resetToken)
  if (!userId) return invalidResetToken(c)

  const limit = await consumePasswordResetSubmitLimit(db, prefix, {
    userId,
    ip: clientIp(c)
  })
  if (!limit.allowed) {
    return c.json(
      {
        error: "Too many requests",
        code: "RATE_LIMITED",
        retryAfter: limit.retryAfter
      },
      429
    )
  }

  if (!newPassword || newPassword.length < 8) {
    return c.json(
      {
        error: "Password must be at least 8 characters",
        code: "WEAK_PASSWORD"
      },
      400
    )
  }

  const user = await findUserById(db, prefix, userId)
  if (!user || !canResetPassword(user)) return invalidResetToken(c)

  const applied = await applyPasswordReset(db, prefix, {
    token: resetToken,
    userId,
    passwordHash: await hashPassword(newPassword)
  })
  if (!applied) return invalidResetToken(c)

  return c.json({ success: true })
})

// ── 注册邮箱验证（本单冻结契约，供前端单 B 引用） ──────────────────────────────
//
// 未验证不能登录，所以两个端点都公开、按「邮箱 + 6 位码」工作，不要求会话：
// - `POST /api/auth/email/verify`：验码通过 → `email_verified=1`、该码作废；
// - `POST /api/auth/email/resend`：重发一枚 `register_verify` 码，口径同找回密码。
//
// 防枚举：未知/停用/已拒绝/已验证账号一律同一个 200（重发）或同一个 400（验码），
// 验码对不可验证的账号跑一遍同成本的 SHA-256。限频一律复用 core/email-code.ts 的
// auth_counters 口径，不另设体系。

/**
 * 能被验证/重发验证码的账号：还没验证、且没有被拒绝或停用。
 *
 * 注意待审批账号的 `is_active` 天生是 0（注册时只有批准才激活），所以「停用」这一条
 * 只对已批准的账号生效——否则刚注册的人永远验证不了自己。
 */
function canReceiveVerification(user: UserRow): boolean {
  if (user.email_verified !== 0) return false
  if (user.approval_status === "rejected") return false
  return user.approval_status !== "approved" || user.is_active === 1
}

/** 重发的唯一「已受理」响应（冷却期内也是它）。 */
function registerVerifyAccepted(c: Context<HonoEnv>) {
  return c.json({
    success: true as const,
    cooldownSeconds: EMAIL_CODE_COOLDOWN_SECONDS
  })
}

/** 验码失败的唯一响应：账号不存在、不可验证、码错、过期、已用一律用它。 */
function invalidVerifyCode(c: Context<HonoEnv>) {
  return c.json({ error: "Invalid or expired code", code: "INVALID_CODE" }, 400)
}

/**
 * 重发注册验证码（公开）。
 *
 * 顺序固定：邮箱格式 → 站点发信 → 限频（cd → send → send_ip）→ 查账号。
 * 未配置 SMTP 503 `EMAIL_NOT_CONFIGURED`（不写计数）；冷却期内 200 不重发；
 * 小时配额用尽 429 带 `retryAfter`；其余一律 200，且只有可验证的账号才写码发信。
 */
authRoutes.post("/email/resend", async (c) => {
  const body = await readJsonBody<{ email?: unknown }>(c)
  const email =
    typeof body?.email === "string" ? body.email.trim().toLowerCase() : ""
  if (!email || !EMAIL_RE.test(email)) {
    return c.json({ error: "Invalid email format", code: "INVALID_EMAIL" }, 400)
  }

  if (!(await isEmailConfigured(c.env))) {
    return c.json(
      {
        error: "Email delivery is not configured",
        code: "EMAIL_NOT_CONFIGURED"
      },
      503
    )
  }

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const limits = await consumeEmailCodeSendLimits(db, prefix, {
    purpose: "register_verify",
    accountKey: email,
    ip: clientIp(c)
  })
  if (!limits.allowed) {
    if (limits.scope === "cooldown") return registerVerifyAccepted(c)
    return c.json(
      {
        error: "Too many requests",
        code: "RATE_LIMITED",
        retryAfter: limits.retryAfter
      },
      429
    )
  }

  const user = await findUserByEmail(db, prefix, email)
  if (!user || !canReceiveVerification(user)) return registerVerifyAccepted(c)

  await runInBackground(c, async () => {
    const issued = await issueEmailCode(db, prefix, {
      userId: user.id,
      purpose: "register_verify"
    })
    const sent = await sendEmailCodeMessage(c.env, {
      to: user.email,
      code: issued.code,
      purpose: "register_verify"
    })
    if (!sent.success) {
      console.error("register verification email failed:", sent.error)
    }
  })

  return registerVerifyAccepted(c)
})

/**
 * 验码并置 `email_verified=1`（公开，不自动登录）。
 *
 * 失败口径：未知账号、已停用、已拒绝、已验证、码错、过期、已用过一律同一个 400；
 * 未知账号也消耗一次按邮箱计的验码限频、并跑一遍同成本哈希，不暴露账号状态。
 * 成功：原子消费该码 → 置位 → 清零该邮箱的验码失败计数。
 */
authRoutes.post("/email/verify", async (c) => {
  const body = await readJsonBody<{ email?: unknown; code?: unknown }>(c)
  const email =
    typeof body?.email === "string" ? body.email.trim().toLowerCase() : ""
  const code = typeof body?.code === "string" ? body.code.trim() : ""
  if (!email || !EMAIL_RE.test(email)) {
    return c.json({ error: "Invalid email format", code: "INVALID_EMAIL" }, 400)
  }
  if (!code) return invalidVerifyCode(c)

  const prefix = getTablePrefix(c.env)
  const db = c.env.DB
  const limits = await consumeEmailCodeVerifyLimits(db, prefix, {
    purpose: "register_verify",
    accountKey: email,
    ip: clientIp(c)
  })
  if (!limits.allowed) {
    return c.json(
      {
        error: "Too many requests",
        code: "RATE_LIMITED",
        retryAfter: limits.retryAfter
      },
      429
    )
  }

  const user = await findUserByEmail(db, prefix, email)
  if (!user || !canReceiveVerification(user)) {
    await hashEmailCode("register_verify", EMAIL_VERIFY_DUMMY_USER_ID, code)
    return invalidVerifyCode(c)
  }

  const verified = await verifyEmailCode(db, prefix, {
    userId: user.id,
    purpose: "register_verify",
    code
  })
  if (!verified) return invalidVerifyCode(c)

  await markEmailVerified(db, prefix, user.id)
  await resetEmailCodeVerifyCounter(db, prefix, {
    purpose: "register_verify",
    accountKey: email
  })
  return c.json({ success: true as const })
})
