import { Hono } from "hono"
import { getTablePrefix } from "../lib/table-prefix"
import { getSetting } from "../db/queries/settings"
import {
  findForeignPrefixConflict,
  isInitialized,
  runSetup
} from "../lib/setup"
import { safeEqual } from "../core/auth"
import { normalizeLanguage } from "../core/language"
import { consumeCounter, ensureCountersTable } from "../core/counters"
import { renameUnusedDefaultSpace } from "../db/queries/spaces"
import { clientIp, readJsonBody } from "../lib/http"
import { DEFAULT_SPACE_NAME, DEFAULT_SPACE_NAME_EN } from "../lib/migrations"
import type { HonoEnv } from "../types"

export const setupRoutes = new Hono<HonoEnv>()

/**
 * 公开状态端点：只回答“是否已初始化 / 初始化页是否可见”，不含表前缀与任何密钥。
 * 未初始化时恒为可见（enabled=true）。
 */
setupRoutes.get("/state", async (c) => {
  c.header("Cache-Control", "no-store")
  const prefix = getTablePrefix(c.env)
  try {
    const initialized = await isInitialized(c.env.DB, prefix)
    if (!initialized) return c.json({ initialized: false, enabled: true })
    const value = await getSetting(c.env.DB, prefix, "setup_page_enabled")
    return c.json({ initialized: true, enabled: (value ?? "1") !== "0" })
  } catch {
    // 未初始化或不可读：默认开放初始化入口。
    return c.json({ initialized: false, enabled: true })
  }
})

/**
 * 只跑迁移（纯升级，与建账号端点分离）。密钥只认 X-Setup-Secret 请求头，
 * 常量时间比较；按 IP 限流 3 次/10 分钟（D1 计数表为权威）。
 */
setupRoutes.post("/", async (c) => {
  const prefix = getTablePrefix(c.env)
  const ip = clientIp(c)

  // 前缀冲突先做只读探测：冲突时一个表都不写（限流计数表会建表，必须排在后面）。
  // 冲突细节只在密钥正确时返回，避免未授权探测共享库里其他项目的前缀。
  const conflict = await findForeignPrefixConflict(c.env).catch(() => null)
  if (conflict) {
    const header = c.req.header("X-Setup-Secret")
    if (
      !c.env.SETUP_SECRET ||
      !(await safeEqual(header ?? "", c.env.SETUP_SECRET))
    ) {
      return c.json({ error: "Invalid setup secret" }, 403)
    }
    const result = await runSetup(c.env)
    return c.json(result, 409)
  }

  try {
    await ensureCountersTable(c.env.DB, prefix)
    const state = await consumeCounter(c.env.DB, prefix, {
      action: "setup",
      ip,
      windowSeconds: 600
    })
    if (state.count > 3) {
      const retryAfter = Math.max(
        1,
        state.windowStart + 600 - Math.floor(Date.now() / 1000)
      )
      return c.json(
        { error: "Too many requests", code: "RATE_LIMITED", retryAfter },
        429
      )
    }
  } catch {
    // 计数不可用时不放行：密钥接口宁可 500，也不做无限重试。
    return c.json({ error: "Setup unavailable" }, 500)
  }

  const secret = c.req.header("X-Setup-Secret")
  if (
    !c.env.SETUP_SECRET ||
    !(await safeEqual(secret ?? "", c.env.SETUP_SECRET))
  ) {
    return c.json({ error: "Invalid setup secret" }, 403)
  }

  // 初始化页随当前界面语言发送；缺省/非法一律回退 zh（与 §3 语言链一致）。
  const body = await readJsonBody<{ language?: unknown }>(c)
  const language = normalizeLanguage(body?.language)

  try {
    const result = await runSetup(c.env)
    if (!result.success) return c.json(result, 409)
    // 全新英文安装：默认空间名仍是播种名、且尚无用户时改成英文。存量库因
    // 「已有用户」守卫不改名；用户改过名的空间因名字不符也不会被覆盖。
    if (language === "en") {
      await renameUnusedDefaultSpace(
        c.env.DB,
        prefix,
        DEFAULT_SPACE_NAME,
        DEFAULT_SPACE_NAME_EN,
        new Date().toISOString()
      )
    }
    return c.json(result)
  } catch (err) {
    console.error("Setup failed:", err instanceof Error ? err.message : err)
    return c.json({ error: "Setup failed" }, 500)
  }
})

// GET /api/setup 及未知子路径：明确拒绝，密钥永不进 URL。
setupRoutes.get("*", (c) => {
  c.header("Allow", "POST")
  return c.json(
    {
      error:
        "GET setup is deprecated. Use POST /api/setup with the X-Setup-Secret header."
    },
    405
  )
})
