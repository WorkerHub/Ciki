/**
 * 公开引导端点（规格 §5.5）：只有站点名、仓库地址、版本号等公开静态事实。
 * 可缓存 60 秒——它不含任何私有字段，也不读用户会话。
 *
 * 防泄露约束（《tech-scheme》§5A.6）：tablePrefix、setup_page_enabled 等内部
 * 状态严禁暴露于此端点。
 */
import { Hono } from "hono"
import { DEFAULT_SITE_NAME } from "../core/identity"
import { getSetting } from "../db/queries/settings"
import { AGENT_GUIDE_TEMPLATE } from "../docs/agent-guide-content"
import { CONTRACT_VERSION } from "../docs/openapi"
import { getTablePrefix } from "../lib/table-prefix"
import type { HonoEnv } from "../types"

export const UNKNOWN_VERSION = "v1.0.0-0-unknown"
export const REPOSITORY_URL = "https://github.com/WorkerHub/Ciki"

export const publicRoutes = new Hono<HonoEnv>()

publicRoutes.get("/", async (c) => {
  c.header("Cache-Control", "public, max-age=60")
  const prefix = getTablePrefix(c.env)
  const siteName =
    (await getSetting(c.env.DB, prefix, "site_name").catch(() => null)) ??
    DEFAULT_SITE_NAME
  const version = (c.env.APP_VERSION ?? "").trim() || UNKNOWN_VERSION

  return c.json({
    name: siteName,
    repositoryUrl: REPOSITORY_URL,
    version,
    openapi: "/api/openapi.json",
    agentGuide: "/api/public/agent-guide"
  })
})

publicRoutes.get("/agent-guide", (c) => {
  const version = (c.env.APP_VERSION ?? "").trim() || UNKNOWN_VERSION
  const content = AGENT_GUIDE_TEMPLATE.replace(
    "{{CONTRACT_VERSION}}",
    CONTRACT_VERSION
  ).replace("{{BUILD_VERSION}}", version)
  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=60"
    }
  })
})
