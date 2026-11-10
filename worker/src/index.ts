import { Hono } from "hono"
import { getTablePrefix, isValidTablePrefix } from "./lib/table-prefix"
import { isEncryptionKeyUsable } from "./core/secret-box"
import { isWakerConfigured } from "./core/waker-gate"
import { R2CleanupBusyError, runR2Cleanup } from "./core/r2-cleanup"
import { authMiddleware } from "./middleware/auth"
import { authRoutes } from "./routes/auth"
import { auth2faRoutes } from "./routes/auth-2fa"
import { meRoutes } from "./routes/me"
import { adminRoutes } from "./routes/admin"
import { setupRoutes } from "./routes/setup"
import { pageRoutes } from "./routes/pages"
import { spaceRoutes } from "./routes/spaces"
import { searchRoutes } from "./routes/search"
import { fileRoutes } from "./routes/files"
import { importRoutes } from "./routes/import"
import { readRoutes } from "./routes/read"
import { wakerRoutes } from "./routes/waker"
import { CALLBACK_MOUNT_PATH } from "./waker"
import type { Env, HonoEnv } from "./types"

export const app = new Hono<HonoEnv>()

// 前缀是拼进 SQL 标识符的配置，非法即全站 fail closed：宁可 500，也不拿畸形
// 前缀建表/查表。日志只说明原因，不回显配置值。
app.use("*", async (c, next) => {
  const prefix = getTablePrefix(c.env)
  if (!isValidTablePrefix(prefix)) {
    console.error(
      "TABLE_PREFIX 配置非法：空值表示无前缀；非空时须以字母或下划线开头，其后只允许字母、数字、下划线"
    )
    return c.json({ error: "Invalid TABLE_PREFIX configuration" }, 500)
  }
  await next()
})

// 加密钥 fail closed：TOTP 密钥靠它落库，缺/非法时不放行任何 API。
app.use("/api/*", async (c, next) => {
  if (!isEncryptionKeyUsable(c.env.ENCRYPTION_KEY)) {
    console.error("ENCRYPTION_KEY 缺失、仍是占位值，或不是 32 字节 base64/hex")
    return c.json({ error: "Server misconfigured" }, 500)
  }
  await next()
})

// 未登录/敏感响应一律 no-store；files 路由自带缓存头时保留它自己的。
app.use("/api/*", async (c, next) => {
  await next()
  if (!c.res.headers.has("cache-control")) {
    c.res.headers.set("cache-control", "no-store")
  }
})

// 公开路径之外，全部要会话。
const PUBLIC_ROUTES: Array<[string, string]> = [
  ["GET", "/api/health"],
  ["GET", "/api/auth/config"],
  ["POST", "/api/auth/register"],
  ["POST", "/api/auth/login"],
  ["POST", "/api/auth/logout"],
  ["POST", "/api/auth/refresh"],
  // 邮箱找回密码三步：未登录也要能用（只认邮箱 + 验证码 / 一次性 resetToken）。
  ["POST", "/api/auth/password/forgot"],
  ["POST", "/api/auth/password/verify"],
  ["POST", "/api/auth/password/reset"],
  ["POST", "/api/auth/2fa/verify"],
  ["POST", "/api/auth/2fa/passkey/authenticate/options"],
  ["POST", "/api/auth/2fa/passkey/authenticate/verify"],
  // 登录第二步选了邮箱验证码时发码：只认有效的 2fa_login 挑战（tempToken）。
  ["POST", "/api/auth/2fa/email-otp/send-login"]
]

function isPublicRoute(method: string, path: string): boolean {
  // setup 整段公开：state 是公开状态端点，POST 只认请求头密钥，
  // 其余方法由 setup 路由自己回 405 JSON（不能掉进会话 401）。
  if (path === "/api/setup" || path.startsWith("/api/setup/")) return true
  // 导入接口用个人令牌（Bearer）自证，不接受会话 Cookie：整段交给 import 路由
  // 的中间件校验，不能掉进会话 401。
  if (path === "/api/import" || path.startsWith("/api/import/")) return true
  // 只读接口同理，但认的是只读令牌（另一张表，另一套令牌）：会话 Cookie 在这里无效，
  // 导入令牌也进不来（见 middleware/read-token.ts 的双向隔离说明）。
  if (path === "/api/read" || path.startsWith("/api/read/")) return true
  return PUBLIC_ROUTES.some(([m, p]) => m === method && p === path)
}

app.use("/api/*", async (c, next) => {
  if (isPublicRoute(c.req.method, new URL(c.req.url).pathname)) {
    await next()
    return
  }
  return authMiddleware(c, next)
})

app.route("/api/auth/2fa", auth2faRoutes)
app.route("/api/auth", authRoutes)
app.route("/api/me", meRoutes)
app.route("/api/admin", adminRoutes)
app.route("/api/setup", setupRoutes)
app.route("/api/pages", pageRoutes)
app.route("/api/spaces", spaceRoutes)
app.route("/api/search", searchRoutes)
app.route("/api/files", fileRoutes)
app.route("/api/import", importRoutes)
app.route("/api/read", readRoutes)

// 存活探针。生效前缀不在这里暴露——它只经 setup / 管理面的接口回显。
app.get("/api/health", (c) => c.json({ status: "ok" }))

// 未命中的 API 一律 JSON 404：不能落到下面的 SPA 回落，否则调用方会把
// "接口不存在"当成 200 的 HTML 页面。
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404))

// waker 回调入口（规格 §3）：必须在 SPA 回落之前挂上，否则 `/_waker/execute`
// 会被回落成 200 的 index.html，平台会把“没跑”当成功。验签与幂等全在 SDK 里。
app.route(CALLBACK_MOUNT_PATH, wakerRoutes())

// SPA 回落：静态资源命中就直接返回，未命中（客户端路由）返回 index.html。
app.get("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw)
  if (res.status !== 404) return res
  return c.env.ASSETS.fetch(new Request(new URL("/", c.req.url), c.req.raw))
})

app.onError((err, c) => {
  console.error(
    "Unhandled error:",
    err instanceof Error ? err.message : String(err)
  )
  if (err instanceof SyntaxError) {
    return c.json({ error: "Invalid request body" }, 400)
  }
  return c.json({ error: "Internal server error" }, 500)
})

export default {
  fetch: app.fetch,
  /**
   * 内置 Cron Trigger（规格 §3）：`wrangler.toml` 里的 `[triggers] crons` 只认 UTC，
   * 每月跑一次。配了 `WAKER_SIGNING_KEY` 就说明 waker 接管，这里直接让路——
   * 既不跑也不写日志行（下一轮仍由日志表兜底，不会被当成一次真实运行）。
   */
  async scheduled(
    _event: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    if (isWakerConfigured(env)) {
      console.info(
        "scheduled: WAKER_SIGNING_KEY 已配置，waker 接管，Cron 入口跳过本轮 R2 清理"
      )
      return
    }
    try {
      const summary = await runR2Cleanup(env, {
        trigger: "cron",
        dryRun: false,
        rerunGuard: "enforce"
      })
      console.info("scheduled r2 cleanup run:", summary)
    } catch (err) {
      if (err instanceof R2CleanupBusyError) {
        // 另一轮（手动或 waker）正在跑：本轮不跑也不写日志行，下一轮 cron 照旧。
        console.info(
          `scheduled r2 cleanup skipped: another run holds the lock (retry after ${err.retryAfterSeconds}s)`
        )
        return
      }
      console.error(
        "scheduled r2 cleanup failed:",
        err instanceof Error ? err.message : String(err)
      )
    }
  }
} satisfies ExportedHandler<Env>
