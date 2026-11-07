import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  makeContext,
  request
} from "./support/app"

describe("Worker 路由骨架", () => {
  it("GET /api/health → 200 {status:'ok'}", async () => {
    const { env } = makeContext()
    const res = await request(env, "/api/health")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
  })

  it("未命中的 /api/* 返回 JSON（不是 SPA 的 200 HTML）：未登录 401，登录后 404", async () => {
    const { env } = await initializedContext()
    const anonymous = await request(env, "/api/nope")
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get("content-type")).toContain("application/json")

    const admin = await adminSession(env)
    const res = await request(env, "/api/nope", { headers: { cookie: admin } })
    expect(res.status).toBe(404)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.json()).toEqual({ error: "Not found" })
  })

  it("前端路由回落 index.html", async () => {
    const { env } = makeContext()
    const res = await request(env, "/pages/abc")

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
  })

  it("非法表前缀 fail closed：500 且不回显配置值", async () => {
    const { env } = makeContext({ TABLE_PREFIX: "2026" })
    const res = await request(env, "/api/health")

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: "Invalid TABLE_PREFIX configuration"
    })
  })

  it("ENCRYPTION_KEY 缺失或非法时 API fail closed", async () => {
    for (const key of ["", "too-short", "ENCRYPTION_KEY_PLACEHOLDER"]) {
      const { env } = makeContext({ ENCRYPTION_KEY: key })
      const res = await request(env, "/api/health")
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: "Server misconfigured" })
    }
  })

  it("未登录访问业务接口：401 JSON + Cache-Control: no-store", async () => {
    const { env } = await initializedContext()
    for (const path of ["/api/pages", "/api/search?q=团队", "/api/me"]) {
      const res = await request(env, path)
      expect(res.status).toBe(401)
      expect(res.headers.get("cache-control")).toContain("no-store")
      expect(await res.json()).toEqual({ error: "Unauthorized" })
    }
  })

  it("GET /api/setup/state 未初始化时公开可读", async () => {
    const { env } = makeContext()
    const res = await request(env, "/api/setup/state")

    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toContain("no-store")
    expect(await res.json()).toEqual({ initialized: false, enabled: true })
  })
})
