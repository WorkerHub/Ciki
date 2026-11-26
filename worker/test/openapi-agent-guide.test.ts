import { describe, expect, it } from "vitest"
import { CONTRACT_VERSION } from "../src/docs/openapi"
import { app } from "../src/index"
import { isCommentWriteRoute } from "../src/middleware/comment-auth"
import { UNKNOWN_VERSION } from "../src/routes/public"
import { makeContext, request } from "./support/app"

describe("实例自述接口与端点测试", () => {
  describe("GET /api/openapi.json", () => {
    it("免鉴权只读访问，返回 OpenAPI 3.1 规范与正确缓存头", async () => {
      const { env } = makeContext({ APP_VERSION: "v2.0.0-10-abcdef0" })
      const res = await request(env, "/api/openapi.json")

      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("application/json")
      expect(res.headers.get("cache-control")).toContain("public")
      expect(res.headers.get("cache-control")).toContain("max-age=60")

      const spec = (await res.json()) as Record<string, unknown>
      expect(spec.openapi).toBe("3.1.0")

      const info = spec.info as Record<string, unknown>
      expect(info.version).toBe("v2.0.0-10-abcdef0")
      expect(info["x-contract-version"]).toBe(CONTRACT_VERSION)

      const components = spec.components as {
        securitySchemes: Record<string, unknown>
        schemas: Record<string, unknown>
      }
      expect(components.securitySchemes.ReadTokenAuth).toBeDefined()
      expect(components.securitySchemes.WriteTokenAuth).toBeDefined()
      expect(components.schemas.ErrorResponse).toBeDefined()
    })

    it("未注入 APP_VERSION 环境变量时版本回退到 UNKNOWN_VERSION", async () => {
      const { env } = makeContext()
      const res = await request(env, "/api/openapi.json")

      expect(res.status).toBe(200)
      const spec = (await res.json()) as { info: { version: string } }
      expect(spec.info.version).toBe(UNKNOWN_VERSION)
    })
  })

  describe("GET /api/public/agent-guide", () => {
    it("免鉴权只读访问，返回 Markdown 纯文本、动态版本页首与正确缓存头", async () => {
      const { env } = makeContext({ APP_VERSION: "v2.0.0-10-abcdef0" })
      const res = await request(env, "/api/public/agent-guide")

      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/markdown")
      expect(res.headers.get("content-type")).toContain("charset=utf-8")
      expect(res.headers.get("cache-control")).toContain("public")
      expect(res.headers.get("cache-control")).toContain("max-age=60")

      const text = await res.text()
      expect(
        text.startsWith(
          `> 契约版本：${CONTRACT_VERSION} | 构建版本：v2.0.0-10-abcdef0`
        )
      ).toBe(true)

      // 核查 8 项核心内容完整性
      expect(text).toContain("Authorization: Bearer")
      expect(text).toContain("token_space_scopes")
      expect(text).toContain("/api/read/spaces")
      expect(text).toContain("/api/read/tree")
      expect(text).toContain("/api/read/search")
      expect(text).toContain("?format=json")
      expect(text).toContain("content_json")
      expect(text).toContain("禁止走 Markdown 中转")
      expect(text).toContain("POST /api/write/files/embeds")
      expect(text).toContain("excalidraw")
      expect(text).toContain("sceneKey")
      expect(text).toContain("ciki-embed-theme")
      expect(text).toContain("data-theme")
      expect(text).toContain(".dark")
      expect(text).toContain("主题配色真值表")
      expect(text).toContain("oklch(1 0 0)")
      expect(text).toContain("oklch(0.145 0 0)")
      expect(text).toContain("#f7f4ee")
      expect(text).toContain("#0b0c0e")
      expect(text).toContain("var(--coral)")
      expect(text).toContain("#e2705a")
      expect(text).toContain("#e8694e")
      expect(text).toContain("chart-1")
      expect(text).toContain("chart-5")
      expect(text).toContain("/api/pages/:id/comments")
      expect(text).toContain("401 Unauthorized")
      expect(text).toContain("404 Not Found")
    })

    it("未注入 APP_VERSION 时页首构建版本回退到 UNKNOWN_VERSION", async () => {
      const { env } = makeContext()
      const res = await request(env, "/api/public/agent-guide")

      expect(res.status).toBe(200)
      const text = await res.text()
      expect(
        text.startsWith(
          `> 契约版本：${CONTRACT_VERSION} | 构建版本：${UNKNOWN_VERSION}`
        )
      ).toBe(true)
    })
  })

  describe("一致性守卫：代码实际注册的对外路由集合与规范 paths 严格对齐", () => {
    it("断言规范 paths 与代码实际路由集合完全一致（防漏项与防幽灵路由）", async () => {
      const { env } = makeContext()
      const res = await request(env, "/api/openapi.json")
      const spec = (await res.json()) as {
        paths: Record<string, Record<string, unknown>>
      }

      // 1. 从 OpenAPI 规范中收集全部注册的 [METHOD, PATH] 对
      const specEndpoints: string[] = []
      for (const [path, methods] of Object.entries(spec.paths)) {
        for (const method of Object.keys(methods)) {
          specEndpoints.push(`${method.toUpperCase()} ${path}`)
        }
      }
      specEndpoints.sort()

      // 2. 从 Hono app.routes 中提取对外公开面路由
      // 包括：/api/public、/api/openapi.json、/api/public/agent-guide、/api/read/*、/api/write/*、以及 write 评论写端点
      const registeredRoutes = app.routes
        .filter((r) => r.method !== "ALL")
        .map((r) => {
          const method = r.method.toUpperCase()
          // 将 Hono 路由参数语法 :id / :commentId / :key{.+ 等归一化为 OpenAPI 标准 {param}
          let path = r.path
            .replace(/:key\{\.\+\}/g, "{key}")
            .replace(/:id/g, "{id}")
            .replace(/:commentId/g, "{commentId}")
          // Hono 中子路由挂载若是 "/" 时规范化去掉尾部斜杠
          if (path.length > 1 && path.endsWith("/")) {
            path = path.slice(0, -1)
          }
          return { method, path, rawPath: r.path }
        })
        .filter(({ method, path, rawPath }) => {
          if (
            path === "/api/public" ||
            path === "/api/openapi.json" ||
            path === "/api/public/agent-guide"
          ) {
            return true
          }
          if (path.startsWith("/api/read/") || path.startsWith("/api/write/")) {
            return true
          }
          if (isCommentWriteRoute(method, rawPath)) {
            return true
          }
          return false
        })

      const codeEndpoints = Array.from(
        new Set(registeredRoutes.map((r) => `${r.method} ${r.path}`))
      ).sort()

      // 断言集合完全双向一致
      expect(specEndpoints).toEqual(codeEndpoints)
    })
  })
})
