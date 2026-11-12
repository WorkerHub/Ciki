/**
 * ciki API 客户端 —— 全仓唯一的 HTTP 出口。
 *
 * 字段名严格照后端冻结契约（docs/api-contract.md，分支
 * tds/conv-01a1b404-…）：响应一律 camelCase，时间一律 ISO 8601 字符串。
 * 组件与 store 只调用这里的函数，不自己拼 fetch / 不自己编字段。
 */

const BASE = "/api"

export interface ApiErrorBody {
  error?: string
  code?: string
  retryAfter?: number
  detectedPrefixes?: string[]
  resolvedPrefix?: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly retryAfter?: number
  /** 原始错误体（例如 409 前缀冲突里的 detectedPrefixes）。 */
  readonly details?: ApiErrorBody
  /** 出错请求的路径（不含 /api 前缀），供 describeApiError 分辨 401 的语义。 */
  readonly path?: string

  constructor(
    status: number,
    message: string,
    code?: string,
    retryAfter?: number,
    details?: ApiErrorBody,
    path?: string
  ) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
    this.details = details
    this.path = path
  }
}

/** 401 且刷新也救不回来时触发，交给 auth store 清态并跳登录。 */
let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler
}

/** 这些路径本身就是登录流程的一部分，401 不能触发刷新与跳转。 */
const NO_REFRESH_PATHS = [
  "/auth/login",
  "/auth/register",
  "/auth/logout",
  "/auth/refresh",
  "/auth/2fa/verify",
  "/auth/2fa/passkey/authenticate",
  "/auth/2fa/email-otp/send-login",
  "/auth/password/forgot",
  "/auth/password/verify",
  "/auth/password/reset",
  "/auth/email/verify",
  "/auth/email/resend",
  "/auth/config",
  "/setup/state",
  "/setup"
]

function isAuthFlowPath(path: string) {
  return NO_REFRESH_PATHS.some((p) => path === p || path.startsWith(`${p}/`))
}

function isMultipart(body: unknown): body is FormData {
  return typeof FormData !== "undefined" && body instanceof FormData
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined
  const text = await res.text()
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

let refreshInFlight: Promise<boolean> | null = null

async function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      credentials: "include"
    })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null
      })
  }
  return refreshInFlight
}

async function rawRequest(
  path: string,
  init: RequestInit & { skipRefresh?: boolean } = {}
): Promise<Response> {
  const { skipRefresh, ...rest } = init
  const headers = new Headers(rest.headers)
  if (
    rest.body !== undefined &&
    !isMultipart(rest.body) &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json")
  }
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers,
    credentials: "include",
    cache: "no-store"
  })
  if (res.status !== 401 || skipRefresh || isAuthFlowPath(path)) return res
  const refreshed = await refreshSession()
  if (!refreshed) {
    onUnauthorized?.()
    return res
  }
  return fetch(`${BASE}${path}`, {
    ...rest,
    headers,
    credentials: "include",
    cache: "no-store"
  })
}

/** 非 2xx 一律转成 ApiError：JSON 请求与二进制下载共用这一个口径。 */
function toApiError(res: Response, body: unknown, path: string): ApiError {
  const error = (body ?? {}) as ApiErrorBody
  return new ApiError(
    res.status,
    error.error || `请求失败（${res.status}）`,
    error.code,
    error.retryAfter,
    error,
    path
  )
}

async function request<T>(
  path: string,
  init: RequestInit & { skipRefresh?: boolean } = {}
): Promise<T> {
  const res = await rawRequest(path, init)
  const body = await parseBody(res)
  if (!res.ok) throw toApiError(res, body, path)
  return body as T
}

/**
 * 二进制下载：成功回 blob 与 Content-Disposition 原文（文件名解析交给调用方），
 * 失败体仍是 JSON，按 request 同口径抛 ApiError。走 rawRequest 才能共用
 * `credentials: "include"` 与 401 刷新。
 */
async function downloadFile(path: string): Promise<FileDownload> {
  const res = await rawRequest(path, { method: "GET" })
  if (!res.ok) throw toApiError(res, await parseBody(res), path)
  return {
    blob: await res.blob(),
    contentDisposition: res.headers.get("Content-Disposition")
  }
}

function json(body: unknown, method = "POST") {
  return { method, body: JSON.stringify(body) } satisfies RequestInit
}

/** 单文件上传：字段名固定 `file`，普通图与头像两个入口共用。 */
async function uploadTo<T>(path: string, file: File): Promise<T> {
  const form = new FormData()
  form.append("file", file)
  return request<T>(path, { method: "POST", body: form })
}

export const api = {
  get: <T>(path: string, init?: RequestInit & { skipRefresh?: boolean }) =>
    request<T>(path, { ...init, method: "GET" }),
  post: <T>(
    path: string,
    body?: unknown,
    init?: RequestInit & { skipRefresh?: boolean }
  ) =>
    request<T>(path, {
      ...init,
      ...(body === undefined ? { method: "POST" } : json(body))
    }),
  put: <T>(path: string, body?: unknown) => request<T>(path, json(body, "PUT")),
  del: <T>(path: string, body?: unknown) =>
    request<T>(
      path,
      body === undefined ? { method: "DELETE" } : json(body, "DELETE")
    ),
  upload: (file: File): Promise<UploadedFile> =>
    uploadTo<UploadedFile>("/files", file)
}

/* ------------------------------------------------------------------ *
 * 契约 DTO
 * ------------------------------------------------------------------ */

export type Role = "admin" | "user"
export type ApprovalStatus = "pending" | "approved" | "rejected"

export interface User {
  id: number
  email: string
  role: Role
}

export interface Me extends User {
  /** 唯一对外身份：1–40 码点、**必须唯一**（撞名 409 `USERNAME_TAKEN`），可改。 */
  username: string
  /** 头像地址；没有头像时为 null。 */
  avatarUrl: string | null
  approvalStatus: ApprovalStatus
  createdAt: string
  twofa: {
    totpEnabled: boolean
    passkeyEnabled: boolean
    passkeyCount: number
    /** 邮箱验证码 2FA 是否已开启（与 TOTP/Passkey 并列的第三种因子）。 */
    emailOtpEnabled: boolean
  }
}

export interface AuthConfig {
  registrationEnabled: boolean
  registrationApprovalRequired: boolean
  /** 站点名（公开读，登录页也要用）；旧后端缺失时由调用方回退。 */
  siteName: string
  /**
   * SMTP 是否可用（站点级公开事实）。false 时邮箱验证码 2FA 与找回密码
   * 都不开放，入口按「不可用」渲染，不做点了才报错的按钮。
   */
  emailConfigured: boolean
}

/** 公开的站点信息读取结果。 */
export interface SiteInfo {
  siteName: string
  emailConfigured: boolean
}

export type LoginResponse =
  | { success: true; user: User }
  | { requires2fa: true; tempToken: string; availableMethods: string[] }
  | { success: true; needs2faSetup: true; user: User }

export interface SetupState {
  initialized: boolean
  enabled: boolean
}

export interface SetupMigration {
  name: string
  status: "applied" | "skipped"
}

export interface SetupResult {
  success: true
  tablePrefix: string
  migrations: SetupMigration[]
}

/** R2 月度清理的一轮日志（与 worker 的 DTO 同形）；页面只展示其中六项。 */
export interface R2CleanupSummary {
  startedAt: string
  finishedAt: string
  trigger: "cron" | "waker" | "manual"
  status: "ok" | "failed" | "skipped"
  dryRun: boolean
  scanned: number
  referenced: number
  deleted: number
  youngSkipped: number
  failed: number
  truncated: boolean
}

/** 此刻正持锁的那一轮清理（读锁行 + 按 TTL 判有效）；过期锁不算在跑。 */
export interface R2CleanupRunning {
  startedAt: string
  trigger: R2CleanupSummary["trigger"]
  dryRun: boolean
  /** 锁剩余秒数，与 POST 409 的 retryAfter 同一算法。 */
  retryAfter: number
}

/** GET /admin/r2-cleanup：最近一轮摘要 + 运行态，两者互不影响。 */
export interface R2CleanupStatus {
  lastRun: R2CleanupSummary | null
  running: R2CleanupRunning | null
}

/** 手动触发一轮清理的返回；prunable 两项只在 dry run 响应里出现。 */
export interface R2CleanupRunResult extends R2CleanupSummary {
  /** 不受单轮 200 上限截断的可清理总数（dryRun=true 才有）。 */
  prunable?: number
  /** 上述可清理对象的字节数之和（dryRun=true 才有）。 */
  prunableBytes?: number
}

export interface SessionInfo {
  id: string
  createdAt: string
  lastSeenAt: string
  ip: string
  userAgent: string
  current: boolean
}

export interface TotpSetup {
  secret: string
  uri: string
}

/** 邮箱验证码发出后的统一回执（send-verify 与 send-login 同形）。 */
export interface EmailCodeSent {
  success: true
  /** 重发冷却秒数（契约固定 60）。 */
  cooldownSeconds: number
  /** 本次验证码有效期秒数（契约固定 600）。 */
  expiresInSeconds: number
}

/**
 * 注册回执（#85 契约）：`emailVerificationRequired` 为 true 表示账号还要先验证
 * 邮箱才能登录（服务端已在响应之外异步发码）；`approvalRequired` 表示还等管理员批准。
 * 该字段是后加的，旧后端缺失时按 false 读。
 */
export interface RegisterResult {
  success: true
  approvalRequired: boolean
  emailVerificationRequired?: boolean
}

/**
 * 重发注册验证码的回执（#85 契约）：与找回密码同口径，账号存在与否都是这一个
 * 200 —— 前端只看 `cooldownSeconds`，不从响应推断账号状态。
 */
export interface VerificationEmailSent {
  success: true
  /** 重发冷却秒数（契约固定 60）。 */
  cooldownSeconds: number
}

/** 登录第二步可用的验证方式（契约顺序：totp → passkey → email_otp）。 */
export type SecondFactorMethod = "totp" | "email_otp"

/**
 * 找回密码第一步（发码）的唯一回执：账号存在、不存在、已停用、发信失败
 * 都是这一个 200 —— 防枚举，前端只看 `cooldownSeconds`，不从响应推断账号情况。
 */
export interface PasswordResetCodeSent {
  success: true
  /** 重发冷却秒数（契约固定 60）。 */
  cooldownSeconds: number
}

/** 找回密码第二步（验码）的回执：一次性 resetToken，明文只在这一条响应里出现。 */
export interface PasswordResetGrant {
  success: true
  resetToken: string
  /** resetToken 有效期秒数（契约固定 600）。 */
  expiresIn: number
}

/**
 * 个人 API 令牌状态：只回状态与时间，从不回哈希与明文。
 * 导入令牌与只读接口令牌同形（两张卡共用一套展示）。
 */
export interface ApiTokenStatus {
  active: boolean
  createdAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
}

/** 生成 / 重置时唯一的明文返回，展示一次后即不可再取。 */
export interface ApiTokenIssued {
  token: string
  createdAt: string
}

export interface PageNode {
  id: number
  parentId: number | null
  title: string
  sortOrder: number
  updatedAt: string
  children: PageNode[]
}

export interface TrashNode {
  id: number
  parentId: number | null
  title: string
  deletedAt: string
  updatedAt: string
}

export interface PageDetail {
  id: number
  parentId: number | null
  /** 页面所属空间；读写入口都按它判定角色。 */
  spaceId: number
  title: string
  sortOrder: number
  contentHtml: string
  contentText: string
  /** 服务端派生的 Markdown（只读展示/导出用，空页为空串）；前端从不回写。 */
  contentMd: string
  createdBy: number
  updatedBy: number
  createdAt: string
  updatedAt: string
}

/**
 * 编辑态详情：`GET /api/pages/:id?format=json` 在普通详情上追加 `contentJson`。
 * 正文 JSON 只在 R2 里，普通详情不碰它（阅读热路径零 R2 读）。
 */
export interface PageContentDetail extends PageDetail {
  contentJson: string
}

export interface PageInput {
  title: string
  contentJson: string
  contentHtml: string
  contentText: string
}

export interface RevisionSummary {
  /** 页内版本号（第 N 版），版本寻址与展示都用它，不再暴露版本行 id。 */
  versionNo: number
  title: string
  editorId: number
  createdAt: string
}

export interface RevisionDetail extends RevisionSummary {
  pageId: number
  contentHtml: string
  contentText: string
}

/**
 * 版本保留数的只读预告：按已保存的设置算出会删掉多少条。
 * `limit` 为 null 表示「不限」（后端内部口径是空串/缺行）。
 */
export interface RevisionRetentionPreview {
  limit: number | null
  totalRevisions: number
  prunableRevisions: number
}

/** 全站修剪的结果：limit 是本次实际生效的上限，deleted 是真实删除条数。 */
export interface RevisionPruneResult {
  limit: number
  deleted: number
}

/**
 * 页尾评论（契约：/api/pages/:pageId/comments）。
 * `html` 是服务端 Markdown 渲染 + 净化后的成品，前端直接呈现、不再加工；
 * `canEdit` / `canDelete` 由服务端按当前用户算好，前端只照它显隐按钮。
 * 已软删但仍有存活回复的顶层评论照常下发：`deletedAt` 非空、`html` 为空串。
 */
export interface CommentDto {
  id: number
  /** NULL=顶层评论；回复一律归一指向其顶层评论 id（只有一级）。 */
  parentId: number | null
  authorId: number
  authorName: string
  /** 头像地址；没有头像时为 null。 */
  authorAvatarUrl: string | null
  /** 原始 Markdown，仅编辑回填用。 */
  bodyMd: string
  html: string
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
  canEdit: boolean
  canDelete: boolean
}

export interface CommentThread extends CommentDto {
  replies: CommentDto[]
}

export interface CommentList {
  /** 未删除的顶层 + 未删除的回复条数（规格的计数口径）。 */
  total: number
  threads: CommentThread[]
}

export interface SearchResult {
  pageId: number
  title: string
  snippet: string
  updatedAt: string
  /** 全空间搜索：结果自带所属空间，前端据此标注。 */
  spaceId: number
  spaceName: string
}

export interface SearchResponse {
  query: string
  results: SearchResult[]
}

export interface UploadedFile {
  key: string
  url: string
  contentType: string
  size: number
}

/** 二进制下载的回执：文件本体 + 服务端原样下发的 Content-Disposition 头（这里不解析）。 */
export interface FileDownload {
  blob: Blob
  contentDisposition: string | null
}

export interface AdminUser extends User {
  isActive: boolean
  approvalStatus: ApprovalStatus
  createdAt: string
}

export interface SiteSettings {
  siteName: string
  setupPageEnabled: boolean
  registrationEnabled: boolean
  registrationApprovalRequired: boolean
  require2fa: boolean
  /** 与 GET /api/auth/config 同口径：SMTP 非密字段齐全即为 true。 */
  emailConfigured: boolean
  /** 每页保留的历史版本数；null = 不限（后端存空串）。 */
  revisionRetentionLimit: number | null
}

/** SMTP 传输层三态：TLS（465 隐式加密）/ STARTTLS（升级）/ 不加密。 */
export type SmtpEncryption = "tls" | "starttls" | "none"

/**
 * 系统管理 → 邮件配置。GET 永不回密码，只用 passwordSet 表示存没存过；
 * 明文只由管理员在 PUT 时提交。
 */
export interface SmtpSettings {
  host: string
  port: number
  encryption: SmtpEncryption
  username: string
  from: string
  fromName: string
  passwordSet: boolean
}

/**
 * GET /api/admin/system/smtp 的响应：状态标志 + 非密配置。
 * 从没保存过时 `config` 为 null（表单空着渲染，不当作错误）。
 */
export interface SmtpConfigState {
  emailConfigured: boolean
  config: SmtpSettings | null
}

/**
 * PUT /api/admin/system/smtp 的载荷。password 语义：空串或纯 `•` = 保留原密文，
 * `null` = 清空，其它值 = 重新加密保存。
 */
export interface SmtpConfigInput {
  host: string
  port: number
  encryption: SmtpEncryption
  username: string
  password: string | null
  from: string
  fromName: string
}

/** 空间角色：站点管理员对所有空间的有效角色都是 admin。 */
export type SpaceRole = "admin" | "editor" | "viewer"

export interface Space {
  id: number
  /** 对外地址段：由空间名生成、创建后不随改名变化（`/s/<slug>/…`）。 */
  slug: string
  name: string
  description: string
  /** 当前用户在该空间的有效角色（站点管理员由前端统一视为 admin）。 */
  myRole: SpaceRole
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export interface SpaceMember {
  userId: number
  username: string
  email: string
  role: SpaceRole
  createdAt: string
}

export interface SpaceCandidate {
  userId: number
  username: string
  email: string
}

/**
 * 系统管理「空间总览」的行：统计字段只在这个端点返回。
 * `slug` 与本项目的 Space DTO 同源（`GET /api/spaces` 必带）；若后端这个端点
 * 漏下发，前端只是不给设置入口，不拿数字 id 顶替地址。
 */
export interface AdminSpace {
  id: number
  slug?: string
  name: string
  description: string
  isDefault: boolean
  createdBy: number
  createdAt: string
  updatedAt: string
  memberCount: number
  pageCount: number
  trashedPageCount: number
}

/**
 * 系统管理 → 数据库维护的体积口径（GET /api/admin/storage）。
 * D1 是 Ciki 独占库，`sizeScope` 即本库；前端只展示 `pageCount` 与体积，
 * 不渲染 scope 文案（不出现「共享库」字样）。
 * 体积由 Cloudflare D1 REST API 的 `file_size` 取得（服务端约 5 分钟缓存）；
 * 取不到时 `databaseSizeBytes` 为 null、`measure` 为 `unavailable` ——
 * 显示「不可得」，绝不估算。
 */
export interface AdminStorage {
  /** 未删除页面数（不含回收站）。 */
  pageCount: number
  trashedPageCount: number
  revisionCount: number
  databaseSizeBytes: number | null
  sizeScope: string
  /** 体积来源：API 取到为 `cloudflare-d1-api`，取不到为 `unavailable`。 */
  measure: "cloudflare-d1-api" | "unavailable"
}

/* ------------------------------------------------------------------ *
 * 端点
 * ------------------------------------------------------------------ */

export const setupApi = {
  state: () => api.get<SetupState>("/setup/state"),
  run: (secret: string) =>
    api.post<SetupResult>("/setup", undefined, {
      headers: { "X-Setup-Secret": secret },
      skipRefresh: true
    }),
  runAsAdmin: () => api.post<SetupResult>("/admin/setup")
}

export const authApi = {
  config: () => api.get<AuthConfig>("/auth/config", { skipRefresh: true }),
  register: (email: string, password: string) =>
    api.post<RegisterResult>(
      "/auth/register",
      { email, password },
      { skipRefresh: true }
    ),
  /**
   * 注册邮箱验证（公开，不依赖会话）：未知邮箱 / 码错 / 过期 / 已用过一律
   * 400 `INVALID_CODE`，前端只有一句话可说；成功只置「已验证」，不发放会话。
   */
  verifyEmail: (email: string, code: string) =>
    api.post<{ success: true }>(
      "/auth/email/verify",
      { email, code },
      { skipRefresh: true }
    ),
  /**
   * 重发注册验证码（公开）：账号不存在、已停用、已拒绝、已验证一律 200 但不发信，
   * 冷却期内重复请求也是 200。站点没配发信时 503 `EMAIL_NOT_CONFIGURED`。
   */
  resendVerificationEmail: (email: string) =>
    api.post<VerificationEmailSent>(
      "/auth/email/resend",
      { email },
      { skipRefresh: true }
    ),
  login: (email: string, password: string) =>
    api.post<LoginResponse>(
      "/auth/login",
      { email, password },
      { skipRefresh: true }
    ),
  /** 登录第二步：同一端点按 method 分流（totp / email_otp；passkey 走下面两个端点）。 */
  verifySecondFactor: (
    tempToken: string,
    method: SecondFactorMethod,
    code: string
  ) =>
    api.post<{ success: true; user: User }>("/auth/2fa/verify", {
      tempToken,
      method,
      code
    }),
  /** 登录第二步选了邮箱验证码时发码（公开，只认有效的 2fa_login 挑战）。 */
  sendLoginEmailCode: (tempToken: string) =>
    api.post<EmailCodeSent>("/auth/2fa/email-otp/send-login", { tempToken }),
  passkeyAuthOptions: (tempToken: string) =>
    api.post<Record<string, unknown>>(
      "/auth/2fa/passkey/authenticate/options",
      { tempToken },
      { skipRefresh: true }
    ),
  passkeyAuthVerify: (tempToken: string, credential: Record<string, unknown>) =>
    api.post<{ success: true; user: User }>(
      "/auth/2fa/passkey/authenticate/verify",
      {
        tempToken,
        ...credential
      }
    ),
  logout: () => api.post<{ success: true }>("/auth/logout"),
  totpSetup: (password?: string) =>
    api.post<TotpSetup>("/auth/2fa/totp/setup", password ? { password } : {}),
  totpEnable: (code: string, password?: string) =>
    api.post<{ success: true }>("/auth/2fa/totp/enable", {
      code,
      ...(password ? { password } : {})
    }),
  totpDisable: (password: string) =>
    api.post<{ success: true }>("/auth/2fa/totp/disable", { password }),
  passkeyRegisterOptions: (password?: string) =>
    api.post<Record<string, unknown>>(
      "/auth/2fa/passkey/register/options",
      password ? { password } : {}
    ),
  passkeyRegisterVerify: (
    credential: Record<string, unknown>,
    password?: string
  ) =>
    api.post<{ success: true }>("/auth/2fa/passkey/register/verify", {
      ...credential,
      ...(password ? { password } : {})
    }),
  passkeyRemove: (credentialId: string, password: string) =>
    api.del<{ success: true }>(
      `/auth/2fa/passkey/${encodeURIComponent(credentialId)}`,
      { password }
    ),
  passkeyDisableAll: (password: string) =>
    api.post<{ success: true }>("/auth/2fa/passkey/disable", { password }),
  /**
   * 邮箱验证码 2FA：先发码（send-verify）、再拿码开启（enable），验证走过一次
   * 往返才真正开启；已有其它因子时两个端点都要带密码重认证。
   */
  emailOtpSendVerify: (password?: string) =>
    api.post<EmailCodeSent>(
      "/auth/2fa/email-otp/send-verify",
      password ? { password } : {}
    ),
  emailOtpEnable: (code: string, password?: string) =>
    api.post<{ success: true }>("/auth/2fa/email-otp/enable", {
      code,
      ...(password ? { password } : {})
    }),
  /** 关闭邮箱验证码始终要求密码，且不依赖 SMTP 是否可用（否则会被锁死）。 */
  emailOtpDisable: (password: string) =>
    api.post<{ success: true }>("/auth/2fa/email-otp/disable", { password }),
  /**
   * 邮箱找回密码三步（均公开，不依赖会话）：发码 → 验码换 resetToken → 用令牌设密。
   * 第一步一律 200（站点没配发信时 503）；第二步错码/过期统一 `INVALID_CODE`；
   * 第三步只认 resetToken，成功后该账号全部会话失效、不自动登录。
   */
  passwordForgot: (email: string) =>
    api.post<PasswordResetCodeSent>(
      "/auth/password/forgot",
      { email },
      { skipRefresh: true }
    ),
  passwordVerify: (email: string, code: string) =>
    api.post<PasswordResetGrant>(
      "/auth/password/verify",
      { email, code },
      { skipRefresh: true }
    ),
  passwordReset: (resetToken: string, newPassword: string) =>
    api.post<{ success: true }>(
      "/auth/password/reset",
      { resetToken, newPassword },
      { skipRefresh: true }
    )
}

export const meApi = {
  get: () => api.get<Me>("/me"),
  updateProfile: (patch: { username?: string; avatarKey?: string | null }) =>
    api.put<Me>("/me/profile", patch),
  /**
   * 头像专用上传口（规格 §1）：落 avatars/，服务端同请求里换掉本人头像并删旧图；
   * 响应是与 GET /api/me 相同的 Me，调用方一次拿到新 avatarUrl。
   */
  uploadAvatar: (file: File) => uploadTo<Me>("/me/avatar", file),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.put<{ success: true }>("/me/password", {
      currentPassword,
      newPassword
    }),
  sessions: () => api.get<SessionInfo[]>("/me/sessions"),
  revokeSession: (id: string) =>
    api.del<{ success: true }>(`/me/sessions/${id}`),
  importToken: () => api.get<ApiTokenStatus>("/me/import-token"),
  // POST 已有令牌时覆盖（即「重置」），明文只在这一个响应里出现
  createImportToken: () => api.post<ApiTokenIssued>("/me/import-token", {}),
  revokeImportToken: () => api.del<{ success: true }>("/me/import-token"),
  /** 只读接口令牌：与导入令牌同一套契约形状，互相独立、各管各的。 */
  readToken: () => api.get<ApiTokenStatus>("/me/read-token"),
  createReadToken: () => api.post<ApiTokenIssued>("/me/read-token", {}),
  revokeReadToken: () => api.del<{ success: true }>("/me/read-token")
}

/**
 * 站点名的公开读取（未登录的登录页也要用）。
 * 契约把它挂在公开的 GET /api/auth/config 上，这里只取 siteName，组件不关心
 * 同一响应里的注册开关。
 */
export const siteApi = {
  get: async (): Promise<SiteInfo> => {
    const config = await authApi.config()
    return {
      siteName: config.siteName,
      emailConfigured: config.emailConfigured === true
    }
  }
}

/** 空间参数缺省时后端按默认空间处理（契约里空串/缺省同义）。 */
function spaceQuery(spaceId?: number | null): string {
  return spaceId ? `?spaceId=${spaceId}` : ""
}

export const pagesApi = {
  tree: (spaceId?: number | null) =>
    api.get<PageNode[]>(`/pages${spaceQuery(spaceId)}`),
  trash: (spaceId?: number | null) =>
    api.get<TrashNode[]>(`/pages/trash${spaceQuery(spaceId)}`),
  get: (id: number) => api.get<PageDetail>(`/pages/${id}`),
  /** 编辑态：在详情上追加 `contentJson`（服务端按 `content_hash` 从 R2 取）。 */
  getForEditor: (id: number) =>
    api.get<PageContentDetail>(`/pages/${id}?format=json`),
  /**
   * 阅读页「下载 .md」：服务端按该页 MD 是否引用站内图自动分流（无图回 .md、
   * 含图回 zip），都是二进制，文件名在 Content-Disposition 里。
   */
  download: (id: number) => downloadFile(`/pages/${id}/download`),
  create: (input: PageInput & { parentId: number | null; spaceId?: number }) =>
    api.post<PageDetail>("/pages", input),
  update: (id: number, input: PageInput) =>
    api.put<PageDetail>(`/pages/${id}`, input),
  move: (
    id: number,
    parentId: number | null,
    sortOrder?: number,
    spaceId?: number
  ) =>
    api.post<{ success: true }>(`/pages/${id}/move`, {
      parentId,
      ...(sortOrder === undefined ? {} : { sortOrder }),
      ...(spaceId ? { spaceId } : {})
    }),
  remove: (id: number) => api.del<{ success: true }>(`/pages/${id}`),
  restore: (id: number) => api.post<{ success: true }>(`/pages/${id}/restore`),
  removePermanent: (id: number) =>
    api.del<{ success: true }>(`/pages/${id}/permanent`),
  revisions: (id: number) =>
    api.get<RevisionSummary[]>(`/pages/${id}/revisions`),
  /** 版本按页内 `version_no`（第 N 版）寻址，不再用版本行 id。 */
  revision: (id: number, versionNo: number) =>
    api.get<RevisionDetail>(`/pages/${id}/revisions/${versionNo}`),
  restoreRevision: (id: number, versionNo: number) =>
    api.post<PageDetail>(`/pages/${id}/revisions/${versionNo}/restore`),
  /** 删单条版本；每页最新一条由服务端拒绝（409 REVISION_IS_LATEST）。 */
  deleteRevision: (id: number, versionNo: number) =>
    api.del<{ success: true }>(`/pages/${id}/revisions/${versionNo}`),
  /** 按页只保留最新一条，其余全删；返回真实删除条数。 */
  pruneRevisions: (id: number) =>
    api.post<{ deleted: number }>(`/pages/${id}/revisions/prune`)
}

export const commentsApi = {
  /** 一次取整页（不分页）：顶层按时间正序，各自回复按时间正序平铺。 */
  list: (pageId: number) => api.get<CommentList>(`/pages/${pageId}/comments`),
  /** 顶层评论不带 parentId；回复的 parentId 恒为顶层评论 id。 */
  create: (
    pageId: number,
    input: { bodyMd: string; parentId?: number | null }
  ) => api.post<CommentDto>(`/pages/${pageId}/comments`, input),
  update: (pageId: number, commentId: number, bodyMd: string) =>
    api.put<CommentDto>(`/pages/${pageId}/comments/${commentId}`, { bodyMd }),
  remove: (pageId: number, commentId: number) =>
    api.del<{ success: true }>(`/pages/${pageId}/comments/${commentId}`),
  /** 预览走与列表同一条服务端渲染净化链，前端不自引 MD 库。 */
  preview: (pageId: number, bodyMd: string) =>
    api.post<{ html: string }>(`/pages/${pageId}/comments/preview`, {
      bodyMd
    })
}

export const searchApi = {
  query: (q: string, limit = 20) =>
    api.get<SearchResponse>(`/search?q=${encodeURIComponent(q)}&limit=${limit}`)
}

export const spacesApi = {
  list: () => api.get<Space[]>("/spaces"),
  get: (id: number) => api.get<Space>(`/spaces/${id}`),
  create: (input: { name: string; description?: string }) =>
    api.post<Space>("/spaces", input),
  update: (id: number, input: { name?: string; description?: string }) =>
    api.put<Space>(`/spaces/${id}`, input),
  remove: (id: number) => api.del<{ success: true }>(`/spaces/${id}`),
  members: (id: number) => api.get<SpaceMember[]>(`/spaces/${id}/members`),
  addMember: (id: number, input: { userId: number; role: SpaceRole }) =>
    api.post<SpaceMember>(`/spaces/${id}/members`, input),
  updateMember: (id: number, userId: number, role: SpaceRole) =>
    api.put<SpaceMember>(`/spaces/${id}/members/${userId}`, { role }),
  removeMember: (id: number, userId: number) =>
    api.del<{ success: true }>(`/spaces/${id}/members/${userId}`),
  candidates: (id: number, q: string) =>
    api.get<SpaceCandidate[]>(
      `/spaces/${id}/member-candidates?q=${encodeURIComponent(q)}`
    )
}

export const adminApi = {
  users: (status: "all" | "pending") =>
    api.get<AdminUser[]>(`/admin/users?status=${status}`),
  createUser: (email: string, password: string, role: Role) =>
    api.post<AdminUser>("/admin/users", { email, password, role }),
  updateUser: (
    id: number,
    patch: {
      email?: string
      password?: string
      role?: Role
      isActive?: boolean
    }
  ) => api.put<AdminUser>(`/admin/users/${id}`, patch),
  deleteUser: (id: number) => api.del<{ success: true }>(`/admin/users/${id}`),
  approve: (id: number) =>
    api.post<{ success: true }>(`/admin/users/${id}/approve`),
  reject: (id: number) =>
    api.post<{ success: true }>(`/admin/users/${id}/reject`),
  runAsAdmin: () => api.post<SetupResult>("/admin/setup"),
  /** 最近一轮真实清理（排除 dry-run 与被防双跑守卫跳过的运行）。 */
  r2Cleanup: () => api.get<R2CleanupStatus>("/admin/r2-cleanup"),
  /** 手动触发清理：dryRun=true 只算不删，false 走真实删除。 */
  runR2Cleanup: (dryRun: boolean) =>
    api.post<R2CleanupRunResult>("/admin/r2-cleanup", { dryRun }),
  spaces: () => api.get<AdminSpace[]>("/admin/spaces"),
  /** 数据库体积与页数（数据库维护页那一行）。 */
  storage: () => api.get<AdminStorage>("/admin/storage"),
  settings: () => api.get<SiteSettings>("/admin/settings"),
  saveSettings: (patch: Partial<SiteSettings>) =>
    api.put<{ success: true }>("/admin/settings", patch),
  smtp: () => api.get<SmtpConfigState>("/admin/system/smtp"),
  saveSmtp: (input: SmtpConfigInput) =>
    api.put<{ success: true; emailConfigured: boolean }>(
      "/admin/system/smtp",
      input
    ),
  /** 只发当前管理员邮箱；请求体不参与决定收件人。 */
  testSmtp: () => api.post<{ success: true }>("/admin/system/smtp/test", {}),
  revisionRetention: () =>
    api.get<RevisionRetentionPreview>("/admin/revisions/retention"),
  pruneAllRevisions: () =>
    api.post<RevisionPruneResult>("/admin/revisions/prune")
}

/**
 * 契约里表达「凭据 / 验证码不对」的失败 —— 它们**都不是会话过期**。
 *
 * 后端的 401 一个状态码承载两种含义（见 docs/api-contract.md：登录失败
 * `Invalid credentials`、两步验证失败「挑战无效/过期/验证码错」），会话中间件
 * 的 `Unauthorized` 才是真的失效；不改契约，前端按冻结文案分流。
 * 键为小写后的原文，两侧空白一并忽略。
 */
const CREDENTIAL_FAILURE_MESSAGES: Record<string, string> = {
  "invalid credentials": "邮箱或密码不正确。",
  "invalid verification code": "验证码不正确，请重新输入。",
  // /auth/2fa/totp/enable 输错码回 400 Invalid code，与上面的 401 是同一件事
  "invalid code": "验证码不正确，请重新输入。",
  "invalid or expired 2fa session": "两步验证已失效，请返回上一步重新登录。",
  "verification failed": "Passkey 验证未通过，请重试。"
}

/**
 * 登录表单自己发的端点：用户在两步页里还没有会话，这里的 401 只可能是
 * 「这次验证没通过」，不可能是 Cookie 失效。
 */
const AUTH_FORM_PATHS = [
  "/auth/login",
  "/auth/2fa/verify",
  "/auth/2fa/passkey/authenticate/options",
  "/auth/2fa/passkey/authenticate/verify",
  "/auth/2fa/email-otp/send-login",
  "/auth/password/forgot",
  "/auth/password/verify",
  "/auth/password/reset",
  "/auth/email/verify",
  "/auth/email/resend"
]

function isAuthFormPath(path: string | undefined) {
  if (!path) return false
  return AUTH_FORM_PATHS.includes(path.split("?")[0])
}

/** 邮箱找回密码三步（#48 契约）：验码失败即作废、只能重新发码，与 2FA 的输错重输不同。 */
const PASSWORD_RESET_PATHS = [
  "/auth/password/forgot",
  "/auth/password/verify",
  "/auth/password/reset"
]

function isPasswordResetPath(path: string | undefined) {
  if (!path) return false
  return PASSWORD_RESET_PATHS.includes(path.split("?")[0])
}

/** 注册邮箱验证（#85 契约）：未知邮箱与码错/过期/已用过的回执完全同形。 */
const EMAIL_VERIFY_PATHS = ["/auth/email/verify"]

function isEmailVerifyPath(path: string | undefined) {
  if (!path) return false
  return EMAIL_VERIFY_PATHS.includes(path.split("?")[0])
}

/** 把契约错误码翻成可以直接给用户看的句子（组件只管展示返回值）。 */
export function describeApiError(error: unknown): string {
  if (!(error instanceof ApiError)) return "网络异常，请稍后重试"
  switch (error.code) {
    case "ACCOUNT_PENDING_APPROVAL":
      return "账号正在等待管理员批准，批准后即可登录。"
    case "ACCOUNT_REJECTED":
      return "该账号的注册申请已被拒绝，请联系管理员。"
    case "RATE_LIMITED":
      return "尝试次数过多，请稍后再试。"
    case "ACCOUNT_LOCKED":
      return `连续登录失败次数过多，请在 ${error.retryAfter ?? 0} 秒后重试。`
    case "REGISTRATION_DISABLED":
      return "站点已关闭注册，请联系管理员开通账号。"
    case "EMAIL_TAKEN":
      return "这个邮箱已经注册过，直接登录即可。"
    case "METHOD_NOT_ENABLED":
      return "这个账号没有开启邮箱验证码。"
    case "2FA_METHOD_UNAVAILABLE":
      return "该账号开启的两步验证方式当前都不可用，请联系管理员。"
    case "PREFIX_CONFLICT":
      return "检测到另一个表前缀下已有本项目的数据，为避免出现两套表，初始化已中止。"
    case "LEDGER_CONFLICT":
      return "检测到两套迁移账本同时存在（或旧账本结构异常），为避免丢记录，升级已中止，请先确认只保留一套账本。"
    case "MIGRATION_REJECTED":
      // 结构/账本停在中间版本：服务端的详细信息在错误体 error 里，这里给管理员一句
      // 能照着做的下一步（数据没有被改动）。
      return "这个库的形态不是本版支持的升级来源：请先用上一版升到最新，再回来点一次；数据库没有被改动。"
    case "REVISION_IS_LATEST":
      return "每页最新的一条版本不能删除。"
    case "RETENTION_UNLIMITED":
      return "当前设置为不限，没有可修剪的版本。"
    case "CLEANUP_IN_PROGRESS":
      // 倒计时由数据库维护页的「进行中」提示行按 retryAfter 给出，这里只说状态
      return "清理正在进行，请稍后再试。"
    case "REVISION_UNRENDERABLE":
      return "这个版本的内容无法在当前编辑器版本下渲染，暂时不能查看或回滚。"
    case "CONTENT_MISSING":
      // 正文存储（内容桶）取不到对象：是运维问题，别把用户往「内容坏了」上引。
      return "页面正文暂时取不到（内容存储不可用或对象缺失），请稍后重试；持续失败请让管理员检查内容存储（ciki-content）。"
    case "PAGE_MOVE_CYCLE":
      return "不能把页面移动到它自己的子页面下。"
    case "PARENT_DELETED":
      return "目标父页面还在回收站里，请先恢复父页面。"
    case "PAGE_NOT_DELETED":
      return "只有已删除的页面才能彻底删除。"
    // 页尾评论（契约「页尾评论」）：软删的评论仍以占位保留，
    // 并发删除时再编辑会撞 409；只说结果，不讲软删之类的机制。
    case "COMMENT_EMPTY":
      return "评论内容不能为空。"
    case "COMMENT_NOT_FOUND":
      return "找不到这条评论，可能已被删除。"
    case "COMMENT_DELETED":
      return "这条评论已被删除，不能再修改。"
    // 导入专用：contentJson 解析不了、或按当前 schema 渲染不了。
    case "INVALID_CONTENT_JSON":
      return "页面内容的格式不正确，无法保存。"
    case "PAYLOAD_TOO_LARGE":
      return "内容或图片超过了单次保存上限，请精简后重试。"
    case "FILE_TOO_LARGE":
      return "图片超过 10MB，请压缩后再上传。"
    case "INVALID_USERNAME":
      return "用户名不合法，请检查后重试。"
    case "USERNAME_TAKEN":
      // 契约「PUT /api/me/profile」：username 必须唯一，撞名 409。只说结果，
      // 不解释唯一索引之类的实现机制。
      return "这个用户名已经有人用了，请换一个。"
    case "INVALID_AVATAR":
      return "头像无效，请重新上传。"
    case "INVALID_SPACE_NAME":
      return "空间名称需为 1–64 个字符。"
    case "INVALID_SPACE_DESCRIPTION":
      return "空间描述最多 500 个字符。"
    case "SPACE_NOT_FOUND":
      return "空间不存在，或你已不是它的成员。"
    case "SPACE_DEFAULT_PROTECTED":
      return "默认空间不能删除。"
    case "SPACE_NOT_EMPTY":
      return "空间里还有页面，请先把页面移动到其他空间，或彻底删除回收站里的页面。"
    case "SPACE_MISMATCH":
      return "目标父页面不在这个空间里。"
    // 导入是唯一带这个码的入口（页面直链无权时仍走 404 口径）。
    case "SPACE_FORBIDDEN":
      return "你在这个空间里没有导入页面的权限。"
    // 导入与建页面都可能在站点缺默认空间时撞上（409）。
    case "DEFAULT_SPACE_MISSING":
      return "站点还没有可用的默认空间，请联系管理员。"
    case "ALREADY_MEMBER":
      return "该用户已经是这个空间的成员。"
    case "USER_NOT_ELIGIBLE":
      return "该用户当前不可加入空间（需处于启用且已批准状态）。"
    case "LAST_SPACE_ADMIN":
      return "空间至少需要保留一名管理员。"
    case "MEMBER_NOT_FOUND":
      return "这个成员已经不在空间里了。"
    case "USER_NOT_FOUND":
      return "找不到这个用户。"
    case "INVALID_ROLE":
      return "成员角色不合法。"
    case "EMAIL_NOT_CONFIGURED":
      return "还没有配置可用的 SMTP，请先在系统管理 → 邮件配置里填写。"
    case "INVALID_EMAIL":
      return "邮箱格式不正确，请检查后重试。"
    case "INVALID_CODE":
      // 找回密码的验码（auth.ts）与邮箱 2FA 的启用验码（auth-2fa.ts）共用这个码：
      // 前者失败即作废、必须重新拿码，后者只是输错、可以就地重输。
      // 注册邮箱验证（#85）同时可能是「未知邮箱」，只说到已验证码这一层。
      if (isEmailVerifyPath(error.path)) return "验证码不正确或已过期。"
      return isPasswordResetPath(error.path)
        ? "验证码不正确或已过期，请重新获取。"
        : "验证码不正确，请重新输入。"
    case "EMAIL_NOT_VERIFIED":
      // 登录门禁（#85）：登录页会给「去验证 / 重新发送验证码」两个入口，
      // 这里只兜其它 surfaces 上的裸展示。
      return "邮箱还没有验证，请先完成邮箱验证。"
    case "INVALID_RESET_TOKEN":
      return "这次重置已失效（验证码换来的凭证过期或已被使用），请重新获取验证码。"
    case "WEAK_PASSWORD":
      return "密码至少 8 位。"
    case "SMTP_SEND_FAILED": {
      // 服务端已脱敏（密码与 base64 换 ***），这里原样带出真实原因便于排障
      const reason = error.message.replace(/^smtp send failed:\s*/i, "").trim()
      return reason ? `发信失败：${reason}` : "发信失败，请检查 SMTP 配置。"
    }
    case "INVALID_SMTP_CONFIG": {
      const reason = error.message
        .replace(/^invalid smtp config:\s*/i, "")
        .trim()
      return reason
        ? `SMTP 配置不合法：${reason}`
        : "SMTP 配置不合法，请检查后重试。"
    }
    default:
      break
  }
  const credentialFailure =
    CREDENTIAL_FAILURE_MESSAGES[error.message.trim().toLowerCase()]
  if (credentialFailure) return credentialFailure
  if (error.status === 400 && /password required/i.test(error.message)) {
    return "这个操作需要输入账号密码确认身份。"
  }
  if (error.status === 403 && /password is incorrect/i.test(error.message)) {
    return "密码不正确，请重试。"
  }
  if (error.status === 401) {
    // 登录 / 两步表单的 401 即使文案没命中上表（例如后端改词）也不能说成
    // 「会话过期」，否则用户会被引导去重新走一遍整个登录。
    if (isAuthFormPath(error.path)) return "验证未通过，请重试。"
    return "登录状态已失效，请重新登录。"
  }
  if (error.status === 403) return error.message || "没有权限执行这个操作。"
  if (error.status === 404) return "对象不存在，或已被删除。"
  if (error.status === 409)
    return error.message || "当前状态冲突，请刷新后重试。"
  if (error.status === 400 && /site ?name/i.test(error.message)) {
    return "站点名称需为 1–32 个字符。"
  }
  if (error.status === 400 && /revisionRetentionLimit/i.test(error.message)) {
    return "保留数需为不小于 1 的整数，留空表示不限。"
  }
  if (error.status === 400 && /invalid username/i.test(error.message)) {
    return "用户名不合法，请检查后重试。"
  }
  if (error.status === 400 && /invalid avatar/i.test(error.message)) {
    return "头像无效，请重新上传。"
  }
  if (error.status === 413) return "内容太大，服务器拒绝了这次请求。"
  if (error.status === 429) return "操作太频繁，请稍后再试。"
  // 清理接口扫描期异常回 500 {"error":"Cleanup failed"}；与同文件其余按原文匹配的
  // 规则一致，这里认的是文案而不是端点，别把英文原文直接摆给管理员
  if (error.status === 500 && /^cleanup failed$/i.test(error.message)) {
    return "清理失败，请稍后重试。"
  }
  return error.message || "请求失败，请稍后重试。"
}
