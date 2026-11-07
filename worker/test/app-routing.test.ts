import { describe, expect, it } from "vitest"
import { app } from "../src/index"
import type { Env } from "../src/types"

/** ASSETS 桩："/" 返回 index.html，其余 404（和真实静态资源行为一致）。 */
function makeEnv(overrides: Partial<Env> = {}): Env {
  const assets = {
    fetch: async (req: Request) => {
      const { pathname } = new URL(req.url)
      if (pathname === "/") {
        return new Response("<html>ciki</html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        })
      }
      return new Response("not found", { status: 404 })
    }
  }
  return { ASSETS: assets, ...overrides } as unknown as Env
}

describe("Worker 路由骨架", () => {
  it("GET /api/health → 200 {status:'ok'}", async () => {
    const res = await app.request("/api/health", {}, makeEnv())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
  })

  it("未命中的 /api/* 返回 JSON 404，而不是 SPA 的 200 HTML", async () => {
    const res = await app.request("/api/setup/state", {}, makeEnv())

    expect(res.status).toBe(404)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.json()).toEqual({ error: "Not found" })
  })

  it("前端路由回落 index.html", async () => {
    const res = await app.request("/pages/abc", {}, makeEnv())

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
  })

  it("非法表前缀 fail closed：500 且不回显配置值", async () => {
    const res = await app.request(
      "/api/health",
      {},
      makeEnv({ TABLE_PREFIX: "2026" })
    )

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: "Invalid TABLE_PREFIX configuration"
    })
  })
})
