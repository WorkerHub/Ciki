/**
 * Worker 的运行期绑定与密钥。密钥只来自 wrangler secrets：
 * 线上由 CI 经 `wrangler deploy --secrets-file` 上传，本地来自 worker/.dev.vars
 * （见 worker/.dev.vars.example，已被 gitignore）。
 */
import type { TokenScope } from "./core/token-scope"

export interface Env {
  /** 共享 D1（既有 workerhub 库）：表名一律经 getTablePrefix() 拼前缀。 */
  DB: D1Database
  /** 图片存储桶 ciki-assets（规格 §2.4：只收图片，读经会话校验）。 */
  R2: R2Bucket
  /**
   * 正文存储桶 ciki-content（规格「内容上 R2」）：只放 `content/<sha256>` 对象，
   * 与图片桶完全隔离。页面当前正文与全部历史版本正文都按内容哈希存在这里，
   * D1 只留 `content_hash` 指针与派生件（html/纯文本/MD）。
   */
  CONTENT: R2Bucket
  /** Workers Static Assets：前端构建产物 web/dist。 */
  ASSETS: Fetcher
  /** setup / 数据库维护的 X-Setup-Secret 令牌（仓库级 secret）。 */
  SETUP_SECRET: string
  /**
   * 敏感字段的 AES-GCM 加密钥（仓库级 secret）：32 字节，base64 或 hex。
   * 当前用于 TOTP 密钥（AAD `ciki:totp:<userId>`）与 SMTP 密码
   * （AAD `ciki:smtp:password`）。缺失/非法时全站 API fail closed；
   * 解析见 src/core/secret-box.ts。
   */
  ENCRYPTION_KEY: string
  /**
   * 表前缀三态，解析见 src/lib/table-prefix.ts 的 getTablePrefix()：
   * 未设置 → "ciki_"；自定义值 → 补尾 "_"；"" → 无前缀。
   * 部署期由 scripts/materialize-secrets.mjs 注入，不在仓库里写死。
   */
  TABLE_PREFIX?: string
  /**
   * waker 项目的回调签名钥（可选，只来自 secrets）。
   *
   * 月度 R2 清理（图片 + 内容两套）的触发开关就是它（规格 §3：不设 WAKER_MODE），三态：
   * 未配置 → 走 Worker 内置 Cron Trigger；`false`（保留值）→ 显式关闭自动清理；
   * 其余非空值 → waker 回调接管、`scheduled()` 自行跳过。未配置与关闭两态的回调口都由 SDK
   * fail closed（500 signing_key_missing，`false` 绝不当钥）。
   * 解析口径见 src/core/waker-gate.ts（空值 / `*_PLACEHOLDER` 一律算未配置）。
   */
  WAKER_SIGNING_KEY?: string
  /**
   * 组织级共用 Cloudflare API Token（部署与 Worker 运行时是同一把，来自 CI）。
   *
   * 运行时只用于「系统管理 → 数据库维护」取库体积：调 D1 REST API 需要
   * `Account > D1 > Read`。缺失、空值或仍是 `*_PLACEHOLDER` 时视为未配置，
   * 体积回退为 `null`（前端显示「不可得」），见 src/core/d1-size.ts。
   */
  CLOUDFLARE_API_TOKEN?: string
  /** Cloudflare 账户 ID（同一批 CI 注入值，运行时拼 D1 REST API 地址用）。 */
  CLOUDFLARE_ACCOUNT_ID?: string
  /** 本实例所用的 D1 库 ID（运行时拼 D1 REST API 地址用）。 */
  D1_DATABASE_ID?: string
}

export type HonoEnv = {
  Bindings: Env
  Variables: {
    /**
     * 当前会话的用户主键（整数自增）。对外身份是 `username`，但内部引用
     * （页面作者、评论作者、会话归属）一律用这个整数，不再有 UUID。
     */
    userId: number
    role: string
    sessionId: string
    restricted: boolean
    /**
     * 当前令牌的空间范围（`null` = 不限制），由读 / 写中间件在命中令牌后按
     * `token_space_scopes.token_id` 写入（见 core/token-scope.ts）。
     * `/api/read/*` 与 `/api/write/*` 在现行成员过滤之外叠这一层。
     */
    tokenScope: TokenScope
  }
}
