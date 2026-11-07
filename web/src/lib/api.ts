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

  constructor(
    status: number,
    message: string,
    code?: string,
    retryAfter?: number,
    details?: ApiErrorBody
  ) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
    this.details = details
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
      error
    )
  }
  return body as T
}

function json(body: unknown, method = "POST") {
  return { method, body: JSON.stringify(body) } satisfies RequestInit
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
  upload: async (file: File): Promise<UploadedFile> => {
    const form = new FormData()
    form.append("file", file)
    return request<UploadedFile>("/files", { method: "POST", body: form })
  }
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

export interface SearchResult {
  pageId: string
  title: string
  snippet: string
  updatedAt: string
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
  setupPageEnabled: boolean
  registrationEnabled: boolean
  registrationApprovalRequired: boolean
  require2fa: boolean
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
  changePassword: (currentPassword: string, newPassword: string) =>
    api.put<{ success: true }>("/me/password", {
      currentPassword,
      newPassword
    }),
  sessions: () => api.get<SessionInfo[]>("/me/sessions"),
  revokeSession: (id: string) =>
    api.del<{ success: true }>(`/me/sessions/${id}`)
}

export const pagesApi = {
  tree: () => api.get<PageNode[]>("/pages"),
  trash: () => api.get<TrashNode[]>("/pages/trash"),
  get: (id: string) => api.get<PageDetail>(`/pages/${id}`),
  create: (input: PageInput & { parentId: string | null }) =>
    api.post<PageDetail>("/pages", input),
  update: (id: string, input: PageInput) =>
    api.put<PageDetail>(`/pages/${id}`, input),
  move: (id: string, parentId: string | null, sortOrder?: number) =>
    api.post<{ success: true }>(`/pages/${id}/move`, {
      parentId,
      ...(sortOrder === undefined ? {} : { sortOrder })
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
    api.post<PageDetail>(`/pages/${id}/revisions/${revisionId}/restore`)
}

export const searchApi = {
  query: (q: string, limit = 20) =>
    api.get<SearchResponse>(`/search?q=${encodeURIComponent(q)}&limit=${limit}`)
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
  settings: () => api.get<SiteSettings>("/admin/settings"),
  saveSettings: (patch: Partial<SiteSettings>) =>
    api.put<{ success: true }>("/admin/settings", patch)
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
    default:
      break
  }
  if (error.status === 400 && /password required/i.test(error.message)) {
    return "这个操作需要输入账号密码确认身份。"
  }
  if (error.status === 403 && /password is incorrect/i.test(error.message)) {
    return "密码不正确，请重试。"
  }
  if (error.status === 401) return "登录状态已失效，请重新登录。"
  if (error.status === 403) return error.message || "没有权限执行这个操作。"
  if (error.status === 404) return "对象不存在，或已被删除。"
  if (error.status === 409)
    return error.message || "当前状态冲突，请刷新后重试。"
  if (error.status === 413) return "内容太大，服务器拒绝了这次请求。"
  if (error.status === 429) return "操作太频繁，请稍后再试。"
  return error.message || "请求失败，请稍后重试。"
}
