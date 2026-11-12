/**
 * 两个 R2 桶体积口径：`GET /api/admin/storage` 的 `assetsSizeBytes` /
 * `contentSizeBytes`（`worker/src/core/bucket-size.ts`）。
 *
 * 钉住四件事：
 *   1. 分页求和：每页 1000、循环到 truncated=false，字节数与对象数都准确（>1000 对象多页）；
 *   2. 防死循环：截断页不给游标 / 游标原地踏步 / 游标回到见过的值，一律中止并整桶降级；
 *   3. 降级形状与 d1-size 对齐：失败为 `{ bytes: null, measure: "unavailable" }`，
 *      **不返回半截求和**；前端据此不渲染该项；
 *   4. 两桶独立：某一桶统计失败只让该项为 null，另一桶与 D1 计数照常。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readBucketSize } from "../src/core/bucket-size"
import { resetD1SizeCache } from "../src/core/d1-size"
import { MemoryR2 } from "./support/memory-r2"
import { adminSession, initializedContext, request } from "./support/app"

/** PNG 魔数开头的最小夹具（上传口只验魔数，与 files.test.ts 同源）。 */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52
])

/** 一页对象的最小形状：体积统计只读 key 与 size。 */
function objectOf(key: string, size: number) {
  return { key, size } as unknown as R2Object
}

/**
 * 可编排的假桶：`pages` 是每次 list() 依次返回的一页，`cursors` 记下调用时带的游标。
 * 页用完还有调用就抛错——多调一次本身就是「循环没停」的证据。
 */
function fakeBucket(
  pages: Array<
    { sizes: number[]; truncated?: boolean; cursor?: string } | Error
  >
) {
  const calls: Array<{ limit?: number; cursor?: string }> = []
  let index = 0
  const bucket = {
    list: async (options?: { limit?: number; cursor?: string }) => {
      calls.push({ limit: options?.limit, cursor: options?.cursor })
      const page = pages[index]
      index += 1
      if (page === undefined)
        throw new Error("list() called past the last page")
      if (page instanceof Error) throw page
      return {
        objects: page.sizes.map((size, i) => objectOf(`k${index}-${i}`, size)),
        truncated: page.truncated === true,
        cursor: page.cursor
      }
    }
  }
  return { bucket: bucket as unknown as R2Bucket, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

beforeEach(() => {
  resetD1SizeCache()
  vi.spyOn(console, "warn").mockImplementation(() => {})
  // 路由同时取 D1 体积：给一个恒定响应，免得用例真去联网。
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse({ success: true, result: { file_size: 10_485_760 } })
    )
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetD1SizeCache()
})

describe("readBucketSize：分页求和与死循环防护", () => {
  it("每页 1000 循环到 truncated=false：>1000 对象的求和与对象数准确", async () => {
    // 1500 个对象分两页：第一页 1000（含一个 0 字节空对象），第二页 500。
    const first = Array.from({ length: 1000 }, () => 100)
    first[999] = 0
    const { bucket, calls } = fakeBucket([
      { sizes: first, truncated: true, cursor: "c1" },
      { sizes: Array.from({ length: 500 }, () => 10) }
    ])

    const result = await readBucketSize(bucket)

    expect(result).toEqual({
      bytes: 999 * 100 + 500 * 10,
      objectCount: 1500,
      measure: "r2-list"
    })
    // 两页各带 1000 上限；第二页游标来自第一页，说明是顺序翻页而非重复拉第一页。
    expect(calls).toEqual([
      { limit: 1000, cursor: undefined },
      { limit: 1000, cursor: "c1" }
    ])
  })

  it("空桶是真实的 0，不是「不可得」", async () => {
    const { bucket } = fakeBucket([{ sizes: [] }])

    expect(await readBucketSize(bucket)).toEqual({
      bytes: 0,
      objectCount: 0,
      measure: "r2-list"
    })
  })

  it("截断页没有游标：中止并降级，不空转", async () => {
    const { bucket, calls } = fakeBucket([{ sizes: [7], truncated: true }])

    expect(await readBucketSize(bucket)).toEqual({
      bytes: null,
      objectCount: null,
      measure: "unavailable"
    })
    expect(calls).toHaveLength(1)
  })

  it("游标原地踏步：第二页即中止并降级（不返回半截求和）", async () => {
    const { bucket, calls } = fakeBucket([
      { sizes: [10], truncated: true, cursor: "c1" },
      { sizes: [20], truncated: true, cursor: "c1" }
    ])

    expect(await readBucketSize(bucket)).toEqual({
      bytes: null,
      objectCount: null,
      measure: "unavailable"
    })
    expect(calls).toHaveLength(2)
  })

  it("游标回到见过的值：照样中止，不无限翻页", async () => {
    const { bucket, calls } = fakeBucket([
      { sizes: [10], truncated: true, cursor: "c1" },
      { sizes: [20], truncated: true, cursor: "c2" },
      { sizes: [30], truncated: true, cursor: "c1" }
    ])

    expect((await readBucketSize(bucket)).measure).toBe("unavailable")
    expect(calls).toHaveLength(3)
  })

  it("中途某一页抛错：整桶降级为 null，不拿已扫到的部分充数", async () => {
    const { bucket } = fakeBucket([
      { sizes: [100], truncated: true, cursor: "c1" },
      new Error("R2 list failed")
    ])

    expect(await readBucketSize(bucket)).toEqual({
      bytes: null,
      objectCount: null,
      measure: "unavailable"
    })
  })
})

describe("/api/admin/storage：两个 R2 桶体积独立统计", () => {
  it("按桶分别给数，与页面计数、D1 体积并存", async () => {
    const { env, r2, content } = await initializedContext()
    await r2.put("images/a.png", new Uint8Array(1200))
    await r2.put("images/b.png", new Uint8Array(800))
    await content.put("content/hash-1", new Uint8Array(4096))
    const admin = await adminSession(env)

    const res = await request(env, "/api/admin/storage", {
      headers: { cookie: admin }
    })
    const body = (await res.json()) as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(body.assetsSizeBytes).toBe(2000)
    expect(body.contentSizeBytes).toBe(4096)
    expect(body.assetsObjectCount).toBe(2)
    expect(body.contentObjectCount).toBe(1)
    // 原有口径不动：D1 体积与计数各行其道
    expect(body.databaseSizeBytes).toBe(10_485_760)
    expect(body.measure).toBe("cloudflare-d1-api")
    expect(body.pageCount).toBe(0)
  })

  it(">1000 对象跨页统计：求和与对象数准确、循环终止", async () => {
    const r2 = new MemoryR2(1000)
    const { env } = await initializedContext({
      R2: r2 as unknown as R2Bucket
    })
    for (let i = 0; i < 1005; i += 1) {
      await r2.put(
        `images/${String(i).padStart(4, "0")}.png`,
        new Uint8Array(11)
      )
    }
    const admin = await adminSession(env)

    const res = await request(env, "/api/admin/storage", {
      headers: { cookie: admin }
    })
    const body = (await res.json()) as {
      assetsSizeBytes: number | null
      assetsObjectCount: number | null
    }

    expect(body.assetsSizeBytes).toBe(1005 * 11)
    expect(body.assetsObjectCount).toBe(1005)
  })

  it("图片桶 list 抛错：该项为 null，正文桶与页数照常，接口不报错", async () => {
    const { env, content } = await initializedContext()
    await content.put("content/hash-1", new Uint8Array(512))
    const brokenR2 = {
      list: async () => {
        throw new Error("R2 unavailable")
      }
    }
    env.R2 = brokenR2 as unknown as R2Bucket
    const admin = await adminSession(env)

    const res = await request(env, "/api/admin/storage", {
      headers: { cookie: admin }
    })
    const body = (await res.json()) as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(body.assetsSizeBytes).toBeNull()
    expect(body.assetsObjectCount).toBeNull()
    expect(body.contentSizeBytes).toBe(512)
    expect(body.databaseSizeBytes).toBe(10_485_760)
    expect(body.pageCount).toBe(0)
    expect(body.measure).toBe("cloudflare-d1-api")
  })

  it("造数往返：上传图片 / 新建页面后体积增加，对象真删后回落", async () => {
    const { env, r2, content } = await initializedContext()
    const admin = await adminSession(env)
    interface Row {
      assetsSizeBytes: number | null
      contentSizeBytes: number | null
      assetsObjectCount: number | null
      contentObjectCount: number | null
    }
    const storage = async (): Promise<Row> => {
      const res = await request(env, "/api/admin/storage", {
        headers: { cookie: admin }
      })
      return (await res.json()) as Row
    }

    const before = await storage()
    expect(before.assetsSizeBytes).toBe(0)
    expect(before.contentSizeBytes).toBe(0)

    // 真走上传口（POST /api/files）落图片桶。
    const form = new FormData()
    form.append("file", new File([PNG], "p.png", { type: "image/png" }))
    const uploaded = await request(env, "/api/files", {
      method: "POST",
      headers: { cookie: admin },
      body: form
    })
    expect(uploaded.status).toBe(201)
    const { key } = (await uploaded.json()) as { key: string }

    const withImage = await storage()
    expect(withImage.assetsSizeBytes).toBe(PNG.length)
    expect(withImage.assetsObjectCount).toBe(1)
    expect(withImage.contentSizeBytes).toBe(0)

    // 真走建页口（POST /api/pages）：正文 JSON 以 content/<sha256> 落内容桶。
    const doc = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "正文" }] }
      ]
    })
    const created = await request(env, "/api/pages", {
      method: "POST",
      headers: { cookie: admin, "content-type": "application/json" },
      body: JSON.stringify({
        title: "体积造数",
        parentId: null,
        contentJson: doc,
        contentHtml: "<p>正文</p>",
        contentText: "正文"
      })
    })
    expect(created.status).toBe(201)

    const withPage = await storage()
    expect(withPage.contentSizeBytes).toBeGreaterThan(0)
    expect(withPage.contentObjectCount).toBeGreaterThanOrEqual(1)
    // 建页不动图片桶（两桶不混）
    expect(withPage.assetsSizeBytes).toBe(PNG.length)

    // 对象真删（与月度清理的删除是同一个 R2 操作）→ 两个体积各自回落。
    await r2.delete(key)
    let listed = await content.list()
    for (const object of listed.objects) await content.delete(object.key)
    while (listed.truncated) {
      listed = await content.list({ cursor: listed.cursor })
      for (const object of listed.objects) await content.delete(object.key)
    }

    const after = await storage()
    expect(after.assetsSizeBytes).toBe(0)
    expect(after.assetsObjectCount).toBe(0)
    expect(after.contentSizeBytes).toBe(0)
    expect(after.contentObjectCount).toBe(0)
  })
})
