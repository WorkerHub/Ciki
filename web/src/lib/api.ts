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

async function request<T>(
  path: string,
  init: RequestInit & { skipRefresh?: boolean } = {}
): Promise<T> {
  const res = await rawRequest(path, init)
  const body = await parseBody(res)
  if (!res.ok) {
    const error = (body ?? {}) as ApiErrorBody
    throw new ApiError(
      res.status,
      error.error || `请求失败（${res.status}）`,
      error.code,
      error.retryAfter,
      error,
      path
    )
  }
  return body as T
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
  id: string
  email: string
  role: Role
}

export interface Me extends User {
  /** 对外展示的用户 ID（8 位，系统生成且不可改）。 */
  publicId: string
  /** 显示名，可改、不要求唯一。 */
  username: string
  /** 头像地址；没有头像时为 null。 */
  avatarUrl: string | null
  approvalStatus: ApprovalStatus
  createdAt: string
  twofa: {
    totpEnabled: boolean
    passkeyEnabled: boolean
    passkeyCount: number
  }
}

export interface AuthConfig {
  registrationEnabled: boolean
  registrationApprovalRequired: boolean
  /** 站点名（公开读，登录页也要用）；旧后端缺失时由调用方回退。 */
  siteName: string
}

/** 公开的站点名读取结果。 */
export interface SiteInfo {
  siteName: string
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

/** 导入令牌状态：只回状态与时间，从不回哈希与明文。 */
export interface ImportTokenStatus {
  active: boolean
  createdAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
}

/** 生成 / 重置时唯一的明文返回，展示一次后即不可再取。 */
export interface ImportTokenIssued {
  token: string
  createdAt: string
}

export interface PageNode {
  id: string
  parentId: string | null
  title: string
  sortOrder: number
  updatedAt: string
  children: PageNode[]
}

export interface TrashNode {
  id: string
  parentId: string | null
  title: string
  deletedAt: string
  updatedAt: string
}

export interface PageDetail {
  id: string
  parentId: string | null
  /** 页面所属空间；读写入口都按它判定角色。 */
  spaceId: string
  title: string
  sortOrder: number
  contentJson: string
  contentHtml: string
  contentText: string
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

export interface PageInput {
  title: string
  contentJson: string
  contentHtml: string
  contentText: string
}

export interface RevisionSummary {
  id: string
  title: string
  editorId: string
  createdAt: string
}

export interface RevisionDetail extends RevisionSummary {
  pageId: string
  contentJson: string
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

export interface SearchResult {
  pageId: string
  title: string
  snippet: string
  updatedAt: string
  /** 全空间搜索：结果自带所属空间，前端据此标注。 */
  spaceId: string
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
  /** 每页保留的历史版本数；null = 不限（后端存空串）。 */
  revisionRetentionLimit: number | null
}

/** 空间角色：站点管理员对所有空间的有效角色都是 admin。 */
export type SpaceRole = "admin" | "editor" | "viewer"

export interface Space {
  id: string
  name: string
  description: string
  /** 当前用户在该空间的有效角色（站点管理员由前端统一视为 admin）。 */
  myRole: SpaceRole
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export interface SpaceMember {
  userId: string
  username: string
  publicId: string
  email: string
  role: SpaceRole
  createdAt: string
}

export interface SpaceCandidate {
  userId: string
  username: string
  publicId: string
  email: string
}

/** 系统管理「空间总览」的行：统计字段只在这个端点返回。 */
export interface AdminSpace {
  id: string
  name: string
  description: string
  isDefault: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
  memberCount: number
  pageCount: number
  trashedPageCount: number
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
    api.post<{ success: true; approvalRequired: boolean }>(
      "/auth/register",
      { email, password },
      { skipRefresh: true }
    ),
  login: (email: string, password: string) =>
    api.post<LoginResponse>(
      "/auth/login",
      { email, password },
      { skipRefresh: true }
    ),
  verifyTotp: (tempToken: string, code: string) =>
    api.post<{ success: true; user: User }>("/auth/2fa/verify", {
      tempToken,
      method: "totp",
      code
    }),
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
    api.post<{ success: true }>("/auth/2fa/passkey/disable", { password })
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
  importToken: () => api.get<ImportTokenStatus>("/me/import-token"),
  // POST 已有令牌时覆盖（即「重置」），明文只在这一个响应里出现
  createImportToken: () => api.post<ImportTokenIssued>("/me/import-token", {}),
  revokeImportToken: () => api.del<{ success: true }>("/me/import-token")
}

/**
 * 站点名的公开读取（未登录的登录页也要用）。
 * 契约把它挂在公开的 GET /api/auth/config 上，这里只取 siteName，组件不关心
 * 同一响应里的注册开关。
 */
export const siteApi = {
  get: async (): Promise<SiteInfo> => {
    const config = await authApi.config()
    return { siteName: config.siteName }
  }
}

/** 空间参数缺省时后端按默认空间处理（契约里空串/缺省同义）。 */
function spaceQuery(spaceId?: string | null): string {
  return spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : ""
}

export const pagesApi = {
  tree: (spaceId?: string | null) =>
    api.get<PageNode[]>(`/pages${spaceQuery(spaceId)}`),
  trash: (spaceId?: string | null) =>
    api.get<TrashNode[]>(`/pages/trash${spaceQuery(spaceId)}`),
  get: (id: string) => api.get<PageDetail>(`/pages/${id}`),
  create: (input: PageInput & { parentId: string | null; spaceId?: string }) =>
    api.post<PageDetail>("/pages", input),
  update: (id: string, input: PageInput) =>
    api.put<PageDetail>(`/pages/${id}`, input),
  move: (
    id: string,
    parentId: string | null,
    sortOrder?: number,
    spaceId?: string
  ) =>
    api.post<{ success: true }>(`/pages/${id}/move`, {
      parentId,
      ...(sortOrder === undefined ? {} : { sortOrder }),
      ...(spaceId ? { spaceId } : {})
    }),
  remove: (id: string) => api.del<{ success: true }>(`/pages/${id}`),
  restore: (id: string) => api.post<{ success: true }>(`/pages/${id}/restore`),
  removePermanent: (id: string) =>
    api.del<{ success: true }>(`/pages/${id}/permanent`),
  revisions: (id: string) =>
    api.get<RevisionSummary[]>(`/pages/${id}/revisions`),
  revision: (id: string, revisionId: string) =>
    api.get<RevisionDetail>(`/pages/${id}/revisions/${revisionId}`),
  restoreRevision: (id: string, revisionId: string) =>
    api.post<PageDetail>(`/pages/${id}/revisions/${revisionId}/restore`),
  /** 删单条版本；每页最新一条由服务端拒绝（409 REVISION_IS_LATEST）。 */
  deleteRevision: (id: string, revisionId: string) =>
    api.del<{ success: true }>(`/pages/${id}/revisions/${revisionId}`),
  /** 按页只保留最新一条，其余全删；返回真实删除条数。 */
  pruneRevisions: (id: string) =>
    api.post<{ deleted: number }>(`/pages/${id}/revisions/prune`)
}

export const searchApi = {
  query: (q: string, limit = 20) =>
    api.get<SearchResponse>(`/search?q=${encodeURIComponent(q)}&limit=${limit}`)
}

export const spacesApi = {
  list: () => api.get<Space[]>("/spaces"),
  get: (id: string) => api.get<Space>(`/spaces/${id}`),
  create: (input: { name: string; description?: string }) =>
    api.post<Space>("/spaces", input),
  update: (id: string, input: { name?: string; description?: string }) =>
    api.put<Space>(`/spaces/${id}`, input),
  remove: (id: string) => api.del<{ success: true }>(`/spaces/${id}`),
  members: (id: string) => api.get<SpaceMember[]>(`/spaces/${id}/members`),
  addMember: (id: string, input: { userId: string; role: SpaceRole }) =>
    api.post<SpaceMember>(`/spaces/${id}/members`, input),
  updateMember: (id: string, userId: string, role: SpaceRole) =>
    api.put<SpaceMember>(`/spaces/${id}/members/${userId}`, { role }),
  removeMember: (id: string, userId: string) =>
    api.del<{ success: true }>(`/spaces/${id}/members/${userId}`),
  candidates: (id: string, q: string) =>
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
    id: string,
    patch: {
      email?: string
      password?: string
      role?: Role
      isActive?: boolean
    }
  ) => api.put<AdminUser>(`/admin/users/${id}`, patch),
  deleteUser: (id: string) => api.del<{ success: true }>(`/admin/users/${id}`),
  approve: (id: string) =>
    api.post<{ success: true }>(`/admin/users/${id}/approve`),
  reject: (id: string) =>
    api.post<{ success: true }>(`/admin/users/${id}/reject`),
  runAsAdmin: () => api.post<SetupResult>("/admin/setup"),
  /** 最近一轮真实清理（排除 dry-run 与被防双跑守卫跳过的运行）。 */
  r2Cleanup: () =>
    api.get<{ lastRun: R2CleanupSummary | null }>("/admin/r2-cleanup"),
  spaces: () => api.get<AdminSpace[]>("/admin/spaces"),
  settings: () => api.get<SiteSettings>("/admin/settings"),
  saveSettings: (patch: Partial<SiteSettings>) =>
    api.put<{ success: true }>("/admin/settings", patch),
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
  "/auth/2fa/passkey/authenticate/verify"
]

function isAuthFormPath(path: string | undefined) {
  if (!path) return false
  return AUTH_FORM_PATHS.includes(path.split("?")[0])
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
    case "PREFIX_CONFLICT":
      return "检测到另一个表前缀下已有本项目的数据，为避免出现两套表，初始化已中止。"
    case "LEDGER_CONFLICT":
      return "检测到两套迁移账本同时存在（或旧账本结构异常），为避免丢记录，升级已中止，请先确认只保留一套账本。"
    case "REVISION_IS_LATEST":
      return "每页最新的一条版本不能删除。"
    case "RETENTION_UNLIMITED":
      return "当前设置为不限，没有可修剪的版本。"
    case "REVISION_UNRENDERABLE":
      return "这个版本的内容无法在当前编辑器版本下渲染，暂时不能查看或回滚。"
    case "PAGE_MOVE_CYCLE":
      return "不能把页面移动到它自己的子页面下。"
    case "PARENT_DELETED":
      return "目标父页面还在回收站里，请先恢复父页面。"
    case "PAGE_NOT_DELETED":
      return "只有已删除的页面才能彻底删除。"
    case "PAYLOAD_TOO_LARGE":
      return "内容或图片超过了单次保存上限，请精简后重试。"
    case "FILE_TOO_LARGE":
      return "图片超过 10MB，请压缩后再上传。"
    case "INVALID_USERNAME":
      return "用户名不合法，请检查后重试。"
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
  return error.message || "请求失败，请稍后重试。"
}
