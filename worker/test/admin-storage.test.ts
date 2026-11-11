/**
 * 「系统管理 → 数据库维护」的体积口径：`GET /api/admin/storage`。
 *
 * D1 运行时拒绝 `PRAGMA page_count`（SQLITE_AUTH），所以体积改走 Cloudflare
 * D1 REST API 的 `file_size`。这里钉住三件事：
 *   1. 成功时把 API 的数字原样交给前端，请求地址/鉴权头与官方契约一致；
 *   2. 取不到（未配置、HTTP 失败、字段缺失、非数字）一律 `null` + `unavailable`，
 *      **绝不估算**，管理页照常可用；
 *   3. 缓存：成功 5 分钟、失败 60 秒，刷新页面不把 API 打穿。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readDatabaseSize, resetD1SizeCache } from "../src/core/d1-size"
import type { DatabaseSizeConfig } from "../src/core/d1-size"
import { adminSession, initializedContext, request } from "./support/app"

const SIZE_URL =
  "https://api.cloudflare.com/client/v4/accounts/acct-test" +
  "/d1/database/db-test?fields=file_size"

const CONFIG: DatabaseSizeConfig = {
  CLOUDFLARE_API_TOKEN: "test-value",
  CLOUDFLARE_ACCOUNT_ID: "acct-test",
  D1_DATABASE_ID: "db-test"
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

/** 用假 fetch 替掉全局，返回 mock 以便数调用次数、看参数。 */
function stubSizeApi(handler: () => Response | Promise<Response>) {
  const mock = vi.fn(async () => handler())
  vi.stubGlobal("fetch", mock)
  return mock
}

describe("/api/admin/storage：体积走 Cloudflare D1 REST API", () => {
  beforeEach(() => {
    resetD1SizeCache()
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetD1SizeCache()
  })

  it("体积取自 API 的 file_size，计数照旧从 D1 现算", async () => {
    const mock = stubSizeApi(() =>
      jsonResponse({ success: true, result: { file_size: 10_485_760 } })
    )
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const res = await request(env, "/api/admin/storage", {
      headers: { cookie: admin }
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      pageCount: number
      trashedPageCount: number
      revisionCount: number
      spaceCount: number
      userCount: number
      databaseSizeBytes: number | null
      sizeScope: string
      measure: string
    }
    expect(body.databaseSizeBytes).toBe(10_485_760)
    expect(body.measure).toBe("cloudflare-d1-api")
    expect(body.sizeScope).toBe("own-database")
    // 计数仍从 D1 现算：新库里没有页面与版本，只有默认空间与刚注册的管理员。
    expect(body.pageCount).toBe(0)
    expect(body.trashedPageCount).toBe(0)
    expect(body.revisionCount).toBe(0)
    expect(body.spaceCount).toBeGreaterThanOrEqual(1)
    expect(body.userCount).toBe(1)

    // 请求形状照官方契约：带 fields、Bearer 鉴权。
    expect(mock).toHaveBeenCalledTimes(1)
    const [url, init] = mock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> }
    ]
    expect(url).toBe(SIZE_URL)
    expect(init.headers.Authorization).toBe("Bearer test-value")
  })

  it("令牌未配置时连请求都不发，体积为「不可得」", async () => {
    const mock = stubSizeApi(() => jsonResponse({ success: true }))
    const { env } = await initializedContext({
      CLOUDFLARE_API_TOKEN: undefined
    })
    const admin = await adminSession(env)

    const res = await request(env, "/api/admin/storage", {
      headers: { cookie: admin }
    })
    const body = (await res.json()) as {
      databaseSizeBytes: number | null
      measure: string
    }

    expect(res.status).toBe(200)
    expect(body.databaseSizeBytes).toBeNull()
    expect(body.measure).toBe("unavailable")
    expect(mock).not.toHaveBeenCalled()
  })

  it("令牌仍是部署模板值时按未配置处理", async () => {
    const mock = stubSizeApi(() => jsonResponse({ success: true }))
    const result = await readDatabaseSize({
      ...CONFIG,
      CLOUDFLARE_API_TOKEN: "CLOUDFLARE_API_TOKEN_PLACEHOLDER"
    })

    expect(result).toEqual({ bytes: null, measure: "unavailable" })
    expect(mock).not.toHaveBeenCalled()
  })

  it("API 失败一律回 null，不估算；401/403 的日志点名权限", async () => {
    const cases: Array<{ label: string; handler: () => Response }> = [
      { label: "403", handler: () => jsonResponse({ success: false }, 403) },
      { label: "500", handler: () => jsonResponse({ success: false }, 500) },
      {
        label: "success:false",
        handler: () => jsonResponse({ success: false })
      },
      { label: "缺 file_size", handler: () => jsonResponse({ result: {} }) },
      {
        label: "非数字 file_size",
        handler: () => jsonResponse({ result: { file_size: "12345" } })
      },
      {
        label: "负值 file_size",
        handler: () => jsonResponse({ result: { file_size: -1 } })
      }
    ]

    for (const item of cases) {
      resetD1SizeCache()
      stubSizeApi(item.handler)
      const result = await readDatabaseSize(CONFIG)
      expect(result, item.label).toEqual({
        bytes: null,
        measure: "unavailable"
      })
      vi.unstubAllGlobals()
    }

    resetD1SizeCache()
    stubSizeApi(() => jsonResponse({ success: false }, 403))
    await readDatabaseSize(CONFIG)
    const warn = vi.mocked(console.warn)
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes("D1 读权限"))
    ).toBe(true)
  })

  it("网络异常/超时同样回 null", async () => {
    resetD1SizeCache()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down")
      })
    )

    const result = await readDatabaseSize(CONFIG)

    expect(result).toEqual({ bytes: null, measure: "unavailable" })
  })

  it("成功结果缓存 5 分钟，失败结果只缓存 60 秒", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000)

    // 成功：5 分钟内多次读取只打一次 API。
    const okMock = stubSizeApi(() =>
      jsonResponse({ success: true, result: { file_size: 2048 } })
    )
    expect((await readDatabaseSize(CONFIG)).bytes).toBe(2048)
    now.mockReturnValue(1_000_000 + 4 * 60 * 1000)
    expect((await readDatabaseSize(CONFIG)).bytes).toBe(2048)
    expect(okMock).toHaveBeenCalledTimes(1)
    // 过 5 分钟后重新取一次。
    now.mockReturnValue(1_000_000 + 5 * 60 * 1000 + 1)
    expect((await readDatabaseSize(CONFIG)).bytes).toBe(2048)
    expect(okMock).toHaveBeenCalledTimes(2)

    // 失败：60 秒内不重试，过后再试。
    resetD1SizeCache()
    const failMock = stubSizeApi(() => jsonResponse({ success: false }, 500))
    now.mockReturnValue(2_000_000)
    expect((await readDatabaseSize(CONFIG)).measure).toBe("unavailable")
    now.mockReturnValue(2_000_000 + 59 * 1000)
    expect((await readDatabaseSize(CONFIG)).measure).toBe("unavailable")
    expect(failMock).toHaveBeenCalledTimes(1)
    now.mockReturnValue(2_000_000 + 61 * 1000)
    expect((await readDatabaseSize(CONFIG)).measure).toBe("unavailable")
    expect(failMock).toHaveBeenCalledTimes(2)
  })
})
