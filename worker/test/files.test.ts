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
    const deliveredText = await readRes.text()
    expect(deliveredText).toContain('type: "ciki-embed-height"')
    expect(deliveredText).toContain("ResizeObserver")
    expect(deliveredText).toContain("</body>")
    expect(deliveredText.indexOf('type: "ciki-embed-height"')).toBeLessThan(
      deliveredText.lastIndexOf("</body>")
    )
    expect(readRes.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(deliveredText).byteLength)
    )
    // R2 中存储的原文件字节保持不变
    const r2Raw = await r2.get(body.key)
    expect(new Uint8Array(await r2Raw!.arrayBuffer())).toEqual(htmlBytes)

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

describe("Embed 下发注入与高度自适应上报协议（规格 §1/§2/§5）", () => {
  it("标准 HTML（含 </body>）：精准注入在 </body> 前，R2 原文件字节不变", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)

    const rawHtml =
      "<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>"
    const rawBytes = new TextEncoder().encode(rawHtml)
    const key = "embeds/11111111-2222-3333-4444-555555555555.html"
    await r2.put(key, rawBytes, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: { category: "embeds", uploaderId: "1" }
    })

    const res = await request(env, `/api/files/${key}`, {
      headers: { cookie: admin }
    })
    expect(res.status).toBe(200)
    const html = await res.text()

    // 1. 注入发生且位于 </body> 之前
    const scriptPos = html.indexOf('type: "ciki-embed-height"')
    const bodyPos = html.lastIndexOf("</body>")
    expect(scriptPos).toBeGreaterThan(0)
    expect(bodyPos).toBeGreaterThan(scriptPos)
    expect(html.endsWith("</body></html>")).toBe(true)

    // 2. 协议消息体与上报要素逐字对齐
    expect(html).toContain(
      'window.parent.postMessage({ type: "ciki-embed-height", height: h }, "*")'
    )
    expect(html).toContain(
      "Math.max(de ? de.offsetHeight : 0, b ? b.offsetHeight : 0, b ? b.scrollHeight : 0)"
    )
    // 视口项彻底剔除：不得含 de.scrollHeight（避免将 iframe 当前视口高误报为内容高）
    expect(html).not.toContain("de.scrollHeight")
    expect(html).toContain("new ResizeObserver")
    expect(html).toContain('addEventListener("DOMContentLoaded"')
    expect(html).toContain('addEventListener("load"')

    // 3. 独立作用域（IIFE）与异常自吞
    expect(html).toMatch(/<script>\s*\(function\(\)\s*\{/i)
    expect(html).toContain("catch (_)")

    // 4. Content-Length 与实际下发字节完全一致
    expect(res.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(html).byteLength)
    )

    // 5. R2 存储原文件逐字节不变
    const r2Obj = await r2.get(key)
    expect(new Uint8Array(await r2Obj!.arrayBuffer())).toEqual(rawBytes)
  })

  it("大写 </BODY> 标签：精准注入在大写 </BODY> 前", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)

    const rawHtml =
      "<!DOCTYPE html><html><body><h1>UPPERCASE</h1></BODY></html>"
    const rawBytes = new TextEncoder().encode(rawHtml)
    const key = "embeds/22222222-3333-4444-5555-666666666666.html"
    await r2.put(key, rawBytes, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: { category: "embeds", uploaderId: "1" }
    })

    const res = await request(env, `/api/files/${key}`, {
      headers: { cookie: admin }
    })
    expect(res.status).toBe(200)
    const html = await res.text()

    const scriptPos = html.indexOf('type: "ciki-embed-height"')
    const bodyPos = html.lastIndexOf("</BODY>")
    expect(scriptPos).toBeGreaterThan(0)
    expect(bodyPos).toBeGreaterThan(scriptPos)
    expect(html.endsWith("</BODY></html>")).toBe(true)
  })

  it("无 <body> 标签的 HTML 片段：追加到文件末尾", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)

    const rawHtml = '<div class="embed-box">Plain Fragment</div>'
    const rawBytes = new TextEncoder().encode(rawHtml)
    const key = "embeds/33333333-4444-5555-6666-777777777777.html"
    await r2.put(key, rawBytes, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: { category: "embeds", uploaderId: "1" }
    })

    const res = await request(env, `/api/files/${key}`, {
      headers: { cookie: admin }
    })
    expect(res.status).toBe(200)
    const html = await res.text()

    expect(html.startsWith(rawHtml)).toBe(true)
    expect(html.indexOf('type: "ciki-embed-height"')).toBeGreaterThan(
      rawHtml.length
    )
  })

  it("安全边界不变：走现行 CSP，不包含任何外部资源链接或新增权限", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)

    const rawHtml = "<html><body><p>Safe</p></body></html>"
    const key = "embeds/44444444-5555-6666-7777-888888888888.html"
    await r2.put(key, new TextEncoder().encode(rawHtml), {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: { category: "embeds", uploaderId: "1" }
    })

    const res = await request(env, `/api/files/${key}`, {
      headers: { cookie: admin }
    })
    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
    )
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  })

  it("Unicode 字符（如 'İ'）：在原串正则匹配，避免 toLowerCase 码元长度变化导致切片错位", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)

    // 'İ'（U+0130）若经 toLowerCase() 会变成 'i\u0307'（2 个码元），产生长度漂移
    const rawHtml = "<!DOCTYPE html><html><body>İçerik</body></html>"
    const rawBytes = new TextEncoder().encode(rawHtml)
    const key = "embeds/55555555-6666-7777-8888-999999999999.html"
    await r2.put(key, rawBytes, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: { category: "embeds", uploaderId: "1" }
    })

    const res = await request(env, `/api/files/${key}`, {
      headers: { cookie: admin }
    })
    expect(res.status).toBe(200)
    const html = await res.text()

    // 验证闭合标签未被破坏、注入脚本完整在 </body> 之前
    expect(html).toContain("İçerik<script>")
    expect(html).toContain("</script></body></html>")
    expect(html).not.toContain("<<script>")
  })

  it("Embed 下发不透传原文件的 ETag（内容已被动态注入脚本）", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)

    const rawHtml = "<html><body><p>No ETag</p></body></html>"
    const key = "embeds/66666666-7777-8888-9999-000000000000.html"
    await r2.put(key, new TextEncoder().encode(rawHtml), {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: { category: "embeds", uploaderId: "1" }
    })

    const res = await request(env, `/api/files/${key}`, {
      headers: { cookie: admin }
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("etag")).toBeNull()
  })

  it("Embed 下发注入主题跟随逻辑：URL 参数解析与父级消息监听", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)

    const rawHtml =
      "<!DOCTYPE html><html><body><div id='app'>Content</div></body></html>"
    const key = "embeds/77777777-8888-9999-aaaa-bbbbbbbbbbbb.html"
    await r2.put(key, new TextEncoder().encode(rawHtml), {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: { category: "embeds", uploaderId: "1" }
    })

    const res = await request(env, `/api/files/${key}`, {
      headers: { cookie: admin }
    })
    expect(res.status).toBe(200)
    const html = await res.text()

    // 1. 验证启动阶段解析 query 参数并设置 dataset 的逻辑
    expect(html).toContain(
      "var params = new URLSearchParams(window.location.search)"
    )
    expect(html).toContain(
      'applyTheme(params.get("mode"), params.get("style"))'
    )
    expect(html).toContain('de.classList.toggle("dark", isDark)')
    expect(html).toContain('de.setAttribute("data-theme", style)')

    // 2. 验证消息监听：来源必须是 window.parent，类型必须是 ciki-embed-theme
    expect(html).toContain("event.source !== window.parent")
    expect(html).toContain('data.type !== "ciki-embed-theme"')

    // 3. 验证取值范围白名单：mode 仅限 light/dark，style 仅限 nova/paper
    expect(html).toContain('mode === "light" || mode === "dark"')
    expect(html).toContain('style === "nova" || style === "paper"')
  })

  it("注入脚本在真实 DOM 环境执行：首屏 query 应用与父级 message 动态切换", async () => {
    const { Window } = await import("happy-dom")
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)

    const rawHtml =
      "<!DOCTYPE html><html><head></head><body><h1>Anim</h1></body></html>"
    const key = "embeds/88888888-9999-aaaa-bbbb-cccccccccccc.html"
    await r2.put(key, new TextEncoder().encode(rawHtml), {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: { category: "embeds", uploaderId: "1" }
    })

    const res = await request(env, `/api/files/${key}`, {
      headers: { cookie: admin }
    })
    const html = await res.text()

    // 模拟带着 ?mode=dark&style=paper 打开 iframe
    const parentWindow = {} as unknown as Window
    const window = new Window({
      url: `https://example.com/api/files/${key}?mode=dark&style=paper`
    })
    ;(window as unknown as { parent: unknown }).parent = parentWindow
    window.document.write(html)
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/i)
    expect(scriptMatch).not.toBeNull()
    window.eval(scriptMatch![1])

    const docEl = window.document.documentElement
    expect(docEl.getAttribute("data-theme")).toBe("paper")
    expect(docEl.classList.contains("dark")).toBe(true)
    expect(docEl.dataset.themeStyle).toBeUndefined()

    // 模拟 window.parent 发送合法的切换消息
    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: parentWindow,
        data: {
          type: "ciki-embed-theme",
          mode: "light",
          style: "nova"
        }
      })
    )
    expect(docEl.getAttribute("data-theme")).toBe("nova")
    expect(docEl.classList.contains("dark")).toBe(false)

    // 模拟非 parent 来源的伪造消息：严格被忽略
    const fakeWindow = {} as unknown as Window
    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: fakeWindow,
        data: {
          type: "ciki-embed-theme",
          mode: "dark",
          style: "paper"
        }
      })
    )
    expect(docEl.getAttribute("data-theme")).toBe("nova")
    expect(docEl.classList.contains("dark")).toBe(false)

    // 模拟非法取值的主题消息：严格被忽略
    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: parentWindow,
        data: {
          type: "ciki-embed-theme",
          mode: "cyberpunk",
          style: "neon"
        }
      })
    )
    expect(docEl.getAttribute("data-theme")).toBe("nova")
    expect(docEl.classList.contains("dark")).toBe(false)
  })
})
