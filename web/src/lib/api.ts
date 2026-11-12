/**
 * ciki API 客户端 —— 全仓唯一的 HTTP 出口。
 *
 * 字段名严格照后端冻结契约（docs/api-contract.md，分支
 * tds/conv-01a1b404-…）：响应一律 camelCase，时间一律 ISO 8601 字符串。
 * 组件与 store 只调用这里的函数，不自己拼 fetch / 不自己编字段。
 */
import i18n from "@/i18n"
import type { Language } from "@/lib/language"

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
    error.error || i18n.t("errors.httpStatus", { status: res.status }),
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
  /**
   * 界面语言偏好（规格 §2.7）。A1 之前的后端没有这个字段，
   * 读不到时前端保持本机选择，所以这里按可选处理。
   */
  language?: Language
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
 * D1 体积由 Cloudflare D1 REST API 的 `file_size` 取得（服务端约 5 分钟缓存）；
 * 取不到时 `databaseSizeBytes` 为 null、`measure` 为 `unavailable` ——
 * 显示「不可得」，绝不估算。
 * 两个 R2 桶体积（图片 `ciki-assets` / 正文 `ciki-content`）由服务端分页 `list()`
 * 现算、不合并；某一桶统计失败时对应字段为 null，前端整项不渲染。
 */
export interface AdminStorage {
  /** 未删除页面数（不含回收站）。 */
  pageCount: number
  trashedPageCount: number
  revisionCount: number
  databaseSizeBytes: number | null
  /** 图片桶总字节；统计失败为 null（该项不渲染）。 */
  assetsSizeBytes: number | null
  /** 正文桶总字节；统计失败为 null（该项不渲染）。 */
  contentSizeBytes: number | null
  /** 两桶对象数：本期前端不显示，仅随接口备用。 */
  assetsObjectCount: number | null
  contentObjectCount: number | null
  sizeScope: string
  /** 体积来源：API 取到为 `cloudflare-d1-api`，取不到为 `unavailable`。 */
  measure: "cloudflare-d1-api" | "unavailable"
}

/* ------------------------------------------------------------------ *
 * 端点
 * ------------------------------------------------------------------ */

export const setupApi = {
  state: () => api.get<SetupState>("/setup/state"),
  /**
   * 初始化数据库。`language` 决定全新库播种的默认空间名（规格 §2.10）：
   * 初始化页传当前界面语言，缺省时后端看 `Accept-Language` 再回退 `zh`。
   */
  run: (secret: string, language?: Language) =>
    api.post<SetupResult>("/setup", language ? { language } : undefined, {
      headers: { "X-Setup-Secret": secret },
      skipRefresh: true
    }),
  runAsAdmin: () => api.post<SetupResult>("/admin/setup")
}

export const authApi = {
  config: () => api.get<AuthConfig>("/auth/config", { skipRefresh: true }),
  /** 注册入参可带当前界面语言：验证邮件与新账号都以它为准（规格 §2.6）。 */
  register: (email: string, password: string, language?: Language) =>
    api.post<RegisterResult>(
      "/auth/register",
      { email, password, language },
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
  updateProfile: (patch: {
    username?: string
    avatarKey?: string | null
    language?: Language
  }) => api.put<Me>("/me/profile", patch),
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
const CREDENTIAL_FAILURE_MESSAGE_KEYS: Record<string, string> = {
  "invalid credentials": "errors.credentials.invalidCredentials",
  "invalid verification code": "errors.credentials.invalidVerificationCode",
  // /auth/2fa/totp/enable 输错码回 400 Invalid code，与上面的 401 是同一件事
  "invalid code": "errors.credentials.invalidMfaCode",
  "invalid or expired 2fa session": "errors.credentials.twoFactorSession",
  "verification failed": "errors.credentials.passkeyFailed"
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

/**
 * describeApiError 认识的错误码及其文案 key（规格 §2.9）：集合里每个码在
 * locales 都有 `errors.<CODE>`。需要插值或按 path 分流的几条（ACCOUNT_LOCKED、
 * INVALID_CODE、两类 SMTP 失败）在查表前先处理。
 *
 * 下面的注释说明「为什么这么说」——改文案前先读一遍：运维问题别往用户
 * 内容坏了上引，机制细节也别摊给用户。
 */
export const ERROR_TEXT_CODES = new Set<string>([
  // 账号与登录
  "ACCOUNT_PENDING_APPROVAL",
  "ACCOUNT_REJECTED",
  "RATE_LIMITED",
  "ACCOUNT_LOCKED",
  "REGISTRATION_DISABLED",
  "EMAIL_TAKEN",
  "METHOD_NOT_ENABLED",
  "2FA_METHOD_UNAVAILABLE",
  // 初始化与升级：两种冲突都讲清「已中止、数据未动」，措辞对齐数据库维护页
  "PREFIX_CONFLICT",
  "LEDGER_CONFLICT",
  "MIGRATION_REJECTED",
  // 版本
  "REVISION_IS_LATEST",
  "RETENTION_UNLIMITED",
  // 倒计时由数据库维护页的「进行中」提示行按 retryAfter 给出，这里只说状态
  "CLEANUP_IN_PROGRESS",
  "REVISION_UNRENDERABLE",
  // 正文存储（内容桶）取不到对象：是运维问题，别把用户往「内容坏了」上引
  "CONTENT_MISSING",
  // 页面
  "PAGE_MOVE_CYCLE",
  "PARENT_DELETED",
  "PAGE_NOT_DELETED",
  // 页尾评论：软删的评论仍以占位保留，并发删除时再编辑会撞 409；
  // 只说结果，不讲软删之类的机制
  "COMMENT_EMPTY",
  "COMMENT_NOT_FOUND",
  "COMMENT_DELETED",
  // 导入专用：contentJson 解析不了、或按当前 schema 渲染不了
  "INVALID_CONTENT_JSON",
  "PAYLOAD_TOO_LARGE",
  "FILE_TOO_LARGE",
  // 个人资料
  "INVALID_USERNAME",
  // username 必须唯一，撞名 409：只说结果，不解释唯一索引之类的实现机制
  "USERNAME_TAKEN",
  "INVALID_AVATAR",
  "INVALID_LANGUAGE",
  // 空间与成员
  "INVALID_SPACE_NAME",
  "INVALID_SPACE_DESCRIPTION",
  "SPACE_NOT_FOUND",
  "SPACE_DEFAULT_PROTECTED",
  "SPACE_NOT_EMPTY",
  "SPACE_MISMATCH",
  // 导入是唯一带这个码的入口（页面直链无权时仍走 404 口径）
  "SPACE_FORBIDDEN",
  // 导入与建页面都可能在站点缺默认空间时撞上（409）
  "DEFAULT_SPACE_MISSING",
  "ALREADY_MEMBER",
  "USER_NOT_ELIGIBLE",
  "LAST_SPACE_ADMIN",
  "MEMBER_NOT_FOUND",
  "USER_NOT_FOUND",
  "INVALID_ROLE",
  // 邮件与验证码
  "EMAIL_NOT_CONFIGURED",
  "INVALID_EMAIL",
  "EMAIL_NOT_VERIFIED",
  "INVALID_RESET_TOKEN",
  "WEAK_PASSWORD"
])

/** 把契约错误码翻成可以直接给用户看的句子（组件只管展示返回值）。 */
export function describeApiError(error: unknown): string {
  if (!(error instanceof ApiError)) return i18n.t("errors.network")
  const code = error.code
  if (code === "ACCOUNT_LOCKED") {
    return i18n.t("errors.ACCOUNT_LOCKED", {
      seconds: error.retryAfter ?? 0
    })
  }
  // 找回密码的验码（auth.ts）与邮箱 2FA 的启用验码（auth-2fa.ts）共用这个码：
  // 前者失败即作废、必须重新拿码，后者只是输错、可以就地重输。
  // 注册邮箱验证（#85）同时可能是「未知邮箱」，只说到已验证码这一层。
  if (code === "INVALID_CODE") {
    if (isEmailVerifyPath(error.path))
      return i18n.t("errors.INVALID_CODE_VERIFY")
    if (isPasswordResetPath(error.path))
      return i18n.t("errors.INVALID_CODE_RESET")
    return i18n.t("errors.INVALID_CODE")
  }
  // 服务端已脱敏（密码与 base64 换 ***），原文照带出真实原因便于排障
  if (code === "SMTP_SEND_FAILED") {
    const reason = error.message.replace(/^smtp send failed:\s*/i, "").trim()
    return reason
      ? i18n.t("errors.SMTP_SEND_FAILED_REASON", { reason })
      : i18n.t("errors.SMTP_SEND_FAILED")
  }
  if (code === "INVALID_SMTP_CONFIG") {
    const reason = error.message.replace(/^invalid smtp config:\s*/i, "").trim()
    return reason
      ? i18n.t("errors.INVALID_SMTP_CONFIG_REASON", { reason })
      : i18n.t("errors.INVALID_SMTP_CONFIG")
  }
  if (code && ERROR_TEXT_CODES.has(code)) return i18n.t(`errors.${code}`)

  const credentialFailure =
    CREDENTIAL_FAILURE_MESSAGE_KEYS[error.message.trim().toLowerCase()]
  if (credentialFailure) return i18n.t(credentialFailure)
  if (error.status === 400 && /password required/i.test(error.message)) {
    return i18n.t("errors.passwordRequired")
  }
  if (error.status === 403 && /password is incorrect/i.test(error.message)) {
    return i18n.t("errors.passwordIncorrect")
  }
  if (error.status === 401) {
    // 登录 / 两步表单的 401 即使文案没命中上表（例如后端改词）也不能说成
    // 「会话过期」，否则用户会被引导去重新走一遍整个登录。
    if (isAuthFormPath(error.path)) return i18n.t("errors.authFailed")
    return i18n.t("errors.sessionExpired")
  }
  if (error.status === 403) {
    return error.message || i18n.t("errors.forbidden")
  }
  if (error.status === 404) return i18n.t("errors.notFound")
  if (error.status === 409) {
    return error.message || i18n.t("errors.conflict")
  }
  if (error.status === 400 && /site ?name/i.test(error.message)) {
    return i18n.t("errors.siteNameLength")
  }
  if (error.status === 400 && /revisionRetentionLimit/i.test(error.message)) {
    return i18n.t("errors.retentionLimit")
  }
  if (error.status === 400 && /invalid username/i.test(error.message)) {
    return i18n.t("errors.INVALID_USERNAME")
  }
  if (error.status === 400 && /invalid avatar/i.test(error.message)) {
    return i18n.t("errors.INVALID_AVATAR")
  }
  if (error.status === 413) return i18n.t("errors.tooLarge")
  if (error.status === 429) return i18n.t("errors.tooFrequent")
  // 清理接口扫描期异常回 500 {"error":"Cleanup failed"}；与同文件其余按原文匹配的
  // 规则一致，这里认的是文案而不是端点，别把英文原文直接摆给管理员
  if (error.status === 500 && /^cleanup failed$/i.test(error.message)) {
    return i18n.t("errors.cleanupFailed")
  }
  return error.message || i18n.t("errors.requestFailed")
}
