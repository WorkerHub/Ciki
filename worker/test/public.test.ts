import { describe, expect, it } from "vitest"
import { UNKNOWN_VERSION } from "../src/routes/public"
import { makeContext, request } from "./support/app"

describe("公开端点 GET /api/public", () => {
  it("免鉴权访问，返回版本、站点名与仓库地址，且绝不泄露内部配置", async () => {
    const { env } = makeContext({ APP_VERSION: "v1.2.3-4-gabcdef" })

    const res = await request(env, "/api/public")
    expect(res.status).toBe(200)

    const data = (await res.json()) as Record<string, unknown>
    expect(data).toEqual({
      name: "Ciki",
      repositoryUrl: "https://github.com/WorkerHub/Ciki",
      version: "v1.2.3-4-gabcdef"
    })

    // 防泄露铁律校验：绝无内部状态
    expect(data.tablePrefix).toBeUndefined()
    expect(data.setup_page_enabled).toBeUndefined()
    expect(data.setupPageEnabled).toBeUndefined()
    expect(data.encryptionKey).toBeUndefined()
    expect(data.setupSecret).toBeUndefined()
  })

  it("未注入 APP_VERSION 环境变量时版本回退到 UNKNOWN_VERSION", async () => {
    const { env } = makeContext()

    const res = await request(env, "/api/public")
    expect(res.status).toBe(200)

    const data = (await res.json()) as { version: string }
    expect(data.version).toBe(UNKNOWN_VERSION)
  })
})
