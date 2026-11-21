/**
 * PWA 安装清单（规格对齐模板）：断言 /manifest.webmanifest 由 Worker 动态下发、
 * 字段完整、图标齐全、支持站点名动态下发，且未被 SPA 回落吞掉。
 */
import { describe, expect, it } from "vitest"
import { DEFAULT_SITE_NAME } from "../src/core/identity"
import { SITE_DESCRIPTION, THEME_COLOR } from "../src/lib/manifest"
import { setSetting } from "../src/db/queries/settings"
import { initializedContext, makeContext, request } from "./support/app"

describe("PWA 安装清单", () => {
  it("GET /manifest.webmanifest：默认状态下返回标准清单，含完整字段与图标", async () => {
    const { env } = makeContext()
    const res = await request(env, "/manifest.webmanifest")

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain(
      "application/manifest+json"
    )
    expect(res.headers.get("cache-control")).toBe("public, max-age=60")

    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({
      id: "/",
      name: DEFAULT_SITE_NAME,
      short_name: DEFAULT_SITE_NAME,
      description: SITE_DESCRIPTION,
      start_url: "/",
      display: "standalone",
      background_color: THEME_COLOR,
      theme_color: THEME_COLOR,
      icons: [
        { src: "/icons/pwa-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/pwa-512.png", sizes: "512x512", type: "image/png" },
        {
          src: "/icons/pwa-maskable-512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable"
        }
      ]
    })
  })

  it("GET /manifest.webmanifest：读取运行时 DB 设置 site_name（与 /api/public 一致）", async () => {
    const { env } = await initializedContext()
    await setSetting(env.DB, "ciki_", "site_name", "团队知识库")

    const res = await request(env, "/manifest.webmanifest")
    expect(res.status).toBe(200)

    const body = (await res.json()) as { name: string; short_name: string }
    expect(body.name).toBe("团队知识库")
    expect(body.short_name).toBe("团队知识库")
  })
})
