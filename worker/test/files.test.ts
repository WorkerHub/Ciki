import { describe, expect, it } from "vitest"
import { adminSession, initializedContext, request } from "./support/app"

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52
])

function formWith(bytes: Uint8Array, type: string): FormData {
  const form = new FormData()
  form.append("file", new File([bytes], "upload.bin", { type }))
  return form
}

async function upload(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  form: FormData
): Promise<Response> {
  return request(env, "/api/files", {
    method: "POST",
    headers: { cookie },
    body: form
  })
}

describe("图片：类型校验、大小上限、会话读取", () => {
  it("上传 PNG 返回 key/url；带会话可读、无会话 401", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)

    const res = await upload(env, admin, formWith(PNG, "image/png"))
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      key: string
      url: string
      contentType: string
      size: number
    }
    expect(body.url).toBe(`/api/files/${body.key}`)
    expect(body.contentType).toBe("image/png")
    expect(body.size).toBe(PNG.length)
    expect(r2.store.has(body.key)).toBe(true)

    const read = await request(env, `/api/files/${body.key}`, {
      headers: { cookie: admin }
    })
    expect(read.status).toBe(200)
    expect(read.headers.get("content-type")).toBe("image/png")
    expect(read.headers.get("cache-control")).toContain("private")
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(PNG)

    const anonymous = await request(env, `/api/files/${body.key}`)
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get("cache-control")).toContain("no-store")
  })

  it("拒收 SVG 与伪装文件", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const svg = await upload(
      env,
      admin,
      formWith(
        new TextEncoder().encode("<svg onload=alert(1)></svg>"),
        "image/svg+xml"
      )
    )
    expect(svg.status).toBe(400)

    const fake = await upload(
      env,
      admin,
      formWith(new TextEncoder().encode("not really an image"), "image/png")
    )
    expect(fake.status).toBe(400)
  })

  it("超过 10MB 返回 413", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    big.set(PNG)

    const res = await upload(env, admin, formWith(big, "image/png"))
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ code: "FILE_TOO_LARGE" })
  })

  it("非法 key / 不存在的 key 返回 404", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    for (const key of [
      "..%2Fetc%2Fpasswd",
      "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bee.png"
    ]) {
      const res = await request(env, `/api/files/${key}`, {
        headers: { cookie: admin }
      })
      expect(res.status).toBe(404)
    }
  })

  it("上传统计受会话保护", async () => {
    const { env } = await initializedContext()
    const res = await upload(env, "", formWith(PNG, "image/png"))
    expect(res.status).toBe(401)
  })
})
