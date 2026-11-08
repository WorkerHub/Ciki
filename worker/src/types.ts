/**
 * Worker 的运行期绑定与密钥。密钥只来自 wrangler secrets：
 * 线上由 CI 经 `wrangler deploy --secrets-file` 上传，本地来自 worker/.dev.vars
 * （见 worker/.dev.vars.example，已被 gitignore）。
 */
export interface Env {
  /** 共享 D1（既有 workerhub 库）：表名一律经 getTablePrefix() 拼前缀。 */
  DB: D1Database
  /** 图片存储桶 ciki-assets（规格 §2.4：只收图片，读经会话校验）。 */
  R2: R2Bucket
  /** Workers Static Assets：前端构建产物 web/dist。 */
  ASSETS: Fetcher
  /** setup / 数据库维护的 X-Setup-Secret 令牌（仓库级 secret）。 */
  SETUP_SECRET: string
  /**
   * TOTP 密钥的 AES-GCM 加密钥（仓库级 secret）：32 字节，base64 或 hex。
   * 缺失/非法时全站 API fail closed；解析见 src/core/secret-box.ts。
   */
  ENCRYPTION_KEY: string
  /**
   * 表前缀三态，解析见 src/lib/table-prefix.ts 的 getTablePrefix()：
   * 未设置 → "ciki_"；自定义值 → 补尾 "_"；"" → 无前缀。
   * 部署期由 scripts/materialize-config.mjs 注入，不在仓库里写死。
   */
  TABLE_PREFIX?: string
  /**
   * waker 项目的回调签名钥（可选，只来自 secrets）。
   *
   * 月度 R2 孤儿清理的触发开关就是它配没配（规格 §3：不设 WAKER_MODE）：
   * 配了 → waker 回调接管、`scheduled()` 自行跳过；没配 → 走 Worker 内置
   * Cron Trigger，waker 回调口由 SDK fail closed（500 signing_key_missing）。
   * 解析口径见 src/core/waker-gate.ts（空值 / `*_PLACEHOLDER` 一律算未配置）。
   */
  WAKER_SIGNING_KEY?: string
}

export type HonoEnv = {
  Bindings: Env
  Variables: {
    userId: string
    role: string
    sessionId: string
    restricted: boolean
  }
}
