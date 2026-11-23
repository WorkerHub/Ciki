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
    // 规格 §1：新上传的 key 带类别前缀，通用上传口固定为 pages/
    expect(body.key).toMatch(/^pages\/[0-9a-f-]{36}\.png$/)
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

  it("读接口双认：存量平铺 key 与已知前缀 key 都能读", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)
    const id = "0f3c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b"

    for (const key of [
      `${id}.png`,
      `avatars/${id}.png`,
      `imports/${id}.png`,
      `pages/${id}.webp`
    ]) {
      await r2.put(key, PNG, { httpMetadata: { contentType: "image/png" } })
      const res = await request(env, `/api/files/${key}`, {
        headers: { cookie: admin }
      })
      expect(res.status).toBe(200)
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
    }
  })

  it("未知前缀与形状不符的 key 一律 404（对象存在也不放行）", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)
    const id = "0f3c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b"

    for (const key of [
      `misc/${id}.png`,
      `pages/a/${id}.png`,
      `avatars/${id}.svg`,
      `${id.toUpperCase()}.png`
    ]) {
      await r2.put(key, PNG, { httpMetadata: { contentType: "image/png" } })
      const res = await request(env, `/api/files/${key}`, {
        headers: { cookie: admin }
      })
      expect(res.status).toBe(404)
    }
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

  it("上传 Excalidraw 场景 JSON：消毒落盘、元数据匹配、带会话可读", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)

    const rawScene = {
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements: [
        {
          id: "r1",
          type: "rectangle",
          x: 10,
          y: 20,
          link: "javascript:alert(1)",
          customData: { leaked: "yes" }
        },
        {
          id: "e1",
          type: "embeddable",
          link: "https://evil.com"
        }
      ],
      appState: {
        viewBackgroundColor: "#FFFFFF",
        gridSize: 10,
        zoom: { value: 2 }
      },
      files: {
        ignored: "data"
      }
    }

    const sceneBytes = new TextEncoder().encode(JSON.stringify(rawScene))
    const form = new FormData()
    form.append(
      "file",
      new File([sceneBytes], "scene.json", { type: "application/json" })
    )

    const res = await upload(env, admin, form)
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      key: string
      url: string
      contentType: string
      size: number
    }
    expect(body.url).toBe(`/api/files/${body.key}`)
    expect(body.key).toMatch(/^pages\/[0-9a-f-]{36}\.json$/)
    expect(body.contentType).toBe("application/json")
    expect(r2.store.has(body.key)).toBe(true)

    // 检查 customMetadata
    const r2Obj = await r2.get(body.key)
    expect(r2Obj?.customMetadata?.category).toBe("pages")
    expect(r2Obj?.customMetadata?.uploaderId).toBeTruthy()

    // 检查落盘内容已消毒（embeddable 剥除、customData 剥除、link 清洗为 null、files 清空）
    const savedText = await r2Obj?.text()
    const savedJson = JSON.parse(savedText ?? "{}")
    expect(savedJson.elements).toHaveLength(1)
    expect(savedJson.elements[0].id).toBe("r1")
    expect(savedJson.elements[0].link).toBeNull()
    expect(savedJson.elements[0].customData).toBeUndefined()
    expect(savedJson.appState.viewBackgroundColor).toBe("#ffffff")
    expect(savedJson.appState.zoom).toBeUndefined()
    expect(savedJson.files).toEqual({})

    // 带会话读取
    const read = await request(env, `/api/files/${body.key}`, {
      headers: { cookie: admin }
    })
    expect(read.status).toBe(200)
    expect(read.headers.get("content-type")).toBe("application/json")
    expect(read.headers.get("cache-control")).toContain("private")
    expect(read.headers.get("cache-control")).toContain("max-age=3600")

    // 无会话读取 401
    const anon = await request(env, `/api/files/${body.key}`)
    expect(anon.status).toBe(401)
  })

  it("场景 JSON 超过 2MB 返回 413", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 构造大于 2MB 的 JSON
    const largePadding = "x".repeat(2 * 1024 * 1024 + 10)
    const rawScene = {
      type: "excalidraw",
      version: 2,
      elements: [
        {
          id: "t1",
          type: "text",
          text: largePadding
        }
      ],
      appState: {}
    }
    const sceneBytes = new TextEncoder().encode(JSON.stringify(rawScene))
    const form = new FormData()
    form.append(
      "file",
      new File([sceneBytes], "big.json", { type: "application/json" })
    )

    const res = await upload(env, admin, form)
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ code: "FILE_TOO_LARGE" })
  })

  it("非法 JSON 或非 Excalidraw 格式返回 400", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 非法 JSON 语法
    const badSyntaxForm = new FormData()
    badSyntaxForm.append(
      "file",
      new File([new TextEncoder().encode("{ bad json")], "broken.json", {
        type: "application/json"
      })
    )
    const badRes = await upload(env, admin, badSyntaxForm)
    expect(badRes.status).toBe(400)

    // 缺少必要字段（不是 excalidraw）
    const notExcalidrawForm = new FormData()
    notExcalidrawForm.append(
      "file",
      new File(
        [new TextEncoder().encode(JSON.stringify({ some: "data" }))],
        "other.json",
        { type: "application/json" }
      )
    )
    const otherRes = await upload(env, admin, notExcalidrawForm)
    expect(otherRes.status).toBe(400)
  })

  it("头像上传接口拒收场景 JSON", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const rawScene = {
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: {}
    }
    const form = new FormData()
    form.append(
      "file",
      new File(
        [new TextEncoder().encode(JSON.stringify(rawScene))],
        "avatar.json",
        { type: "application/json" }
      )
    )

    const res = await request(env, "/api/me/avatar", {
      method: "POST",
      headers: { cookie: admin },
      body: form
    })
    expect(res.status).toBe(400)
  })

  it("Embed 上传：仅收 .html、≤1MB、UUID key、完整 CSP 下发头与会话隔离", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)

    const htmlContent =
      "<!DOCTYPE html><html><head><style>body{margin:0}</style></head><body><script>console.log(1)</script></body></html>"
    const htmlBytes = new TextEncoder().encode(htmlContent)

    const form = new FormData()
    form.append(
      "file",
      new File([htmlBytes], "my-animation.html", { type: "text/html" })
    )

    // 1. 上传成功 201
    const uploadRes = await request(env, "/api/files/embeds", {
      method: "POST",
      headers: { cookie: admin },
      body: form
    })
    expect(uploadRes.status).toBe(201)
    const body = (await uploadRes.json()) as {
      key: string
      url: string
      contentType: string
      size: number
    }
    expect(body.url).toBe(`/api/files/${body.key}`)
    expect(body.key).toMatch(/^embeds\/[0-9a-f-]{36}\.html$/)
    expect(body.contentType).toBe("text/html; charset=utf-8")
    expect(body.size).toBe(htmlBytes.length)
    expect(r2.store.has(body.key)).toBe(true)

    // 2. 检查 customMetadata
    const r2Obj = await r2.get(body.key)
    expect(r2Obj?.customMetadata?.category).toBe("embeds")
    expect(r2Obj?.customMetadata?.uploaderId).toBeTruthy()

    // 3. 带会话下发：全套安全头
    const readRes = await request(env, `/api/files/${body.key}`, {
      headers: { cookie: admin }
    })
    expect(readRes.status).toBe(200)
    expect(readRes.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(readRes.headers.get("x-content-type-options")).toBe("nosniff")
    expect(readRes.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
    )
    expect(readRes.headers.get("cache-control")).toContain("private")
    expect(new Uint8Array(await readRes.arrayBuffer())).toEqual(htmlBytes)

    // 4. 未登录下发拒 401
    const anonRead = await request(env, `/api/files/${body.key}`)
    expect(anonRead.status).toBe(401)

    // 5. 非 .html 拒绝 400
    const notHtmlForm = new FormData()
    notHtmlForm.append(
      "file",
      new File([htmlBytes], "animation.js", { type: "text/javascript" })
    )
    const badExtRes = await request(env, "/api/files/embeds", {
      method: "POST",
      headers: { cookie: admin },
      body: notHtmlForm
    })
    expect(badExtRes.status).toBe(400)
    expect((await badExtRes.json()) as { error: string }).toMatchObject({
      error: "Only .html files are accepted"
    })

    // 6. >1MB 拒绝 413
    const tooLargeBytes = new Uint8Array(1024 * 1024 + 1)
    const tooLargeForm = new FormData()
    tooLargeForm.append(
      "file",
      new File([tooLargeBytes], "large.html", { type: "text/html" })
    )
    const tooLargeRes = await request(env, "/api/files/embeds", {
      method: "POST",
      headers: { cookie: admin },
      body: tooLargeForm
    })
    expect(tooLargeRes.status).toBe(413)
    expect((await tooLargeRes.json()) as { code: string }).toMatchObject({
      code: "FILE_TOO_LARGE"
    })

    // 7. 未登录上传拒 401
    const anonUpload = await request(env, "/api/files/embeds", {
      method: "POST",
      body: form
    })
    expect(anonUpload.status).toBe(401)
  })
})
