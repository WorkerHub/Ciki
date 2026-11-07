import { Hono } from "hono"
import { getTablePrefix, isValidTablePrefix } from "./lib/table-prefix"
import type { HonoEnv } from "./types"

const app = new Hono<HonoEnv>()

// 前缀是拼进 SQL 标识符的配置，非法即全站 fail closed：宁可 500，也不拿畸形
// 前缀建表/查表。日志只说明原因，不回显配置值。
app.use("*", async (c, next) => {
  const prefix = getTablePrefix(c.env)
  if (!isValidTablePrefix(prefix)) {
    console.error(
      "TABLE_PREFIX 配置非法：只允许字母、数字、下划线（空串表示无前缀）"
    )
    return c.json({ error: "Invalid TABLE_PREFIX configuration" }, 500)
  }
  await next()
})

// 存活探针。生效前缀不在这里暴露——它只经 setup / 管理面的接口回显（后端单）。
app.get("/api/health", (c) => c.json({ status: "ok" }))

// SPA 回落：静态资源命中就直接返回，未命中（客户端路由）返回 index.html。
app.get("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw)
  if (res.status !== 404) return res
  return c.env.ASSETS.fetch(new Request(new URL("/", c.req.url), c.req.raw))
})

export default { fetch: app.fetch } satisfies ExportedHandler<
  HonoEnv["Bindings"]
>
