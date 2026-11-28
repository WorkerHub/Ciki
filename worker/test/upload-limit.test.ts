import { describe, expect, it } from "vitest"
import {
  DEFAULT_MAX_IMAGE_UPLOAD_MB,
  normalizeMaxImageUploadInput,
  parseMaxImageUploadMb
} from "../src/core/upload-limit"
import {
  adminSession,
  createApiToken,
  createImportToken,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52
])

const GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00
])

function formWithBytes(
  bytes: Uint8Array,
  filename: string,
  type: string
): FormData {
  const form = new FormData()
  form.append("file", new File([bytes], filename, { type }))
  return form
}

describe("图片上传上限核心 helper（单元测试）", () => {
  describe("parseMaxImageUploadMb", () => {
    it("合法 1–100 整数解析为对应数值", () => {
      expect(parseMaxImageUploadMb("1")).toBe(1)
      expect(parseMaxImageUploadMb("10")).toBe(10)
      expect(parseMaxImageUploadMb("25")).toBe(25)
      expect(parseMaxImageUploadMb("100")).toBe(100)
      expect(parseMaxImageUploadMb("  50  ")).toBe(50)
    })

    it("缺行、空串、非法或超范围值一律回退默认 10", () => {
      expect(parseMaxImageUploadMb(null)).toBe(DEFAULT_MAX_IMAGE_UPLOAD_MB)
      expect(parseMaxImageUploadMb("")).toBe(DEFAULT_MAX_IMAGE_UPLOAD_MB)
      expect(parseMaxImageUploadMb("   ")).toBe(DEFAULT_MAX_IMAGE_UPLOAD_MB)
      expect(parseMaxImageUploadMb("0")).toBe(DEFAULT_MAX_IMAGE_UPLOAD_MB)
      expect(parseMaxImageUploadMb("101")).toBe(DEFAULT_MAX_IMAGE_UPLOAD_MB)
      expect(parseMaxImageUploadMb("-1")).toBe(DEFAULT_MAX_IMAGE_UPLOAD_MB)
      expect(parseMaxImageUploadMb("1.5")).toBe(DEFAULT_MAX_IMAGE_UPLOAD_MB)
      expect(parseMaxImageUploadMb("abc")).toBe(DEFAULT_MAX_IMAGE_UPLOAD_MB)
      expect(parseMaxImageUploadMb("NaN")).toBe(DEFAULT_MAX_IMAGE_UPLOAD_MB)
    })
  })

  describe("normalizeMaxImageUploadInput", () => {
    it("合法输入：1–100 整数（数字或数字字符串）", () => {
      expect(normalizeMaxImageUploadInput(1)).toEqual({ ok: true, mb: 1 })
      expect(normalizeMaxImageUploadInput(25)).toEqual({ ok: true, mb: 25 })
      expect(normalizeMaxImageUploadInput(100)).toEqual({ ok: true, mb: 100 })
      expect(normalizeMaxImageUploadInput("25")).toEqual({ ok: true, mb: 25 })
      expect(normalizeMaxImageUploadInput(" 50 ")).toEqual({ ok: true, mb: 50 })
    })

    it("重置为默认：null 或空串", () => {
      expect(normalizeMaxImageUploadInput(null)).toEqual({ ok: true, mb: null })
      expect(normalizeMaxImageUploadInput("")).toEqual({ ok: true, mb: null })
      expect(normalizeMaxImageUploadInput("   ")).toEqual({
        ok: true,
        mb: null
      })
    })

    it("非法输入回 { ok: false }", () => {
      expect(normalizeMaxImageUploadInput(0)).toEqual({ ok: false })
      expect(normalizeMaxImageUploadInput("0")).toEqual({ ok: false })
      expect(normalizeMaxImageUploadInput(101)).toEqual({ ok: false })
      expect(normalizeMaxImageUploadInput("101")).toEqual({ ok: false })
      expect(normalizeMaxImageUploadInput(-1)).toEqual({ ok: false })
      expect(normalizeMaxImageUploadInput(1.5)).toEqual({ ok: false })
      expect(normalizeMaxImageUploadInput("1.5")).toEqual({ ok: false })
      expect(normalizeMaxImageUploadInput("abc")).toEqual({ ok: false })
      expect(normalizeMaxImageUploadInput(true)).toEqual({ ok: false })
      expect(normalizeMaxImageUploadInput(false)).toEqual({ ok: false })
      expect(normalizeMaxImageUploadInput({})).toEqual({ ok: false })
      expect(normalizeMaxImageUploadInput([])).toEqual({ ok: false })
      expect(normalizeMaxImageUploadInput(undefined)).toEqual({ ok: false })
    })
  })
})

describe("系统管理设置接口 · maxImageUploadMb", () => {
  it("未配置时 GET 恒返回生效值 10", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const res = await jsonRequest(
      env,
      "GET",
      "/api/admin/settings",
      undefined,
      admin
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { maxImageUploadMb: number }
    expect(body.maxImageUploadMb).toBe(10)
  })

  it("PUT/PATCH 设置与校验：25 生效、非法入参 400 且原值不变、null 回落默认 10", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 1. PUT 设 25
    const put25 = await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      { maxImageUploadMb: 25 },
      admin
    )
    expect(put25.status).toBe(200)

    const get25 = await jsonRequest(
      env,
      "GET",
      "/api/admin/settings",
      undefined,
      admin
    )
    expect(
      ((await get25.json()) as { maxImageUploadMb: number }).maxImageUploadMb
    ).toBe(25)

    // 2. PATCH 设 "50"
    const patch50 = await jsonRequest(
      env,
      "PATCH",
      "/api/admin/settings",
      { maxImageUploadMb: "50" },
      admin
    )
    expect(patch50.status).toBe(200)

    const get50 = await jsonRequest(
      env,
      "GET",
      "/api/admin/settings",
      undefined,
      admin
    )
    expect(
      ((await get50.json()) as { maxImageUploadMb: number }).maxImageUploadMb
    ).toBe(50)

    // 3. 非法入参：0 / 101 / 小数 / 非数字 / 布尔值回 400，且原值不变
    for (const invalid of [
      0,
      "0",
      101,
      "101",
      1.5,
      "1.5",
      "abc",
      true,
      false,
      {}
    ]) {
      const bad = await jsonRequest(
        env,
        "PUT",
        "/api/admin/settings",
        { maxImageUploadMb: invalid },
        admin
      )
      expect(bad.status).toBe(400)
      expect(await bad.json()).toMatchObject({
        error: "maxImageUploadMb must be an integer between 1 and 100 or null"
      })
    }

    const unchanged = await jsonRequest(
      env,
      "GET",
      "/api/admin/settings",
      undefined,
      admin
    )
    expect(
      ((await unchanged.json()) as { maxImageUploadMb: number })
        .maxImageUploadMb
    ).toBe(50)

    // 4. PUT null → 回落默认 10
    const putNull = await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      { maxImageUploadMb: null },
      admin
    )
    expect(putNull.status).toBe(200)

    const getNull = await jsonRequest(
      env,
      "GET",
      "/api/admin/settings",
      undefined,
      admin
    )
    expect(
      ((await getNull.json()) as { maxImageUploadMb: number }).maxImageUploadMb
    ).toBe(10)

    // 5. PUT "" → 回落默认 10
    await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      { maxImageUploadMb: 20 },
      admin
    )
    const putEmpty = await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      { maxImageUploadMb: "" },
      admin
    )
    expect(putEmpty.status).toBe(200)

    const getEmpty = await jsonRequest(
      env,
      "GET",
      "/api/admin/settings",
      undefined,
      admin
    )
    expect(
      ((await getEmpty.json()) as { maxImageUploadMb: number }).maxImageUploadMb
    ).toBe(10)
  })

  it("权限拦截：非管理员调管理接口被拒（未登录 401，普通用户 403）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)

    const unauth = await jsonRequest(env, "PUT", "/api/admin/settings", {
      maxImageUploadMb: 25
    })
    expect(unauth.status).toBe(401)

    const forbidden = await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      { maxImageUploadMb: 25 },
      user
    )
    expect(forbidden.status).toBe(403)
  })
})

describe("三条通用图片入口动态生效实测（验收标准 §3）", () => {
  it("设上限 1MB → 2MB 图片在会话/导入/令牌三入口均 413 且 limitBytes=1048576，0.5MB 通过", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const importToken = await createImportToken(env, admin)
    const writeToken = await createApiToken(env, admin, "write")

    // 设上限为 1MB
    const set1Mb = await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      { maxImageUploadMb: 1 },
      admin
    )
    expect(set1Mb.status).toBe(200)

    const twoMb = new Uint8Array(2 * 1024 * 1024)
    twoMb.set(PNG)

    const halfMb = new Uint8Array(500 * 1024)
    halfMb.set(PNG)

    // 1. 会话入口：POST /api/files
    const sessionFail = await request(env, "/api/files", {
      method: "POST",
      headers: { cookie: admin },
      body: formWithBytes(twoMb, "test.png", "image/png")
    })
    expect(sessionFail.status).toBe(413)
    expect(await sessionFail.json()).toEqual({
      error: "File too large",
      code: "FILE_TOO_LARGE",
      limitBytes: 1024 * 1024
    })

    const sessionOk = await request(env, "/api/files", {
      method: "POST",
      headers: { cookie: admin },
      body: formWithBytes(halfMb, "test.png", "image/png")
    })
    expect(sessionOk.status).toBe(201)

    // 2. 导入入口：POST /api/import/files
    const importFail = await request(env, "/api/import/files", {
      method: "POST",
      headers: { authorization: `Bearer ${importToken.token}` },
      body: formWithBytes(twoMb, "test.png", "image/png")
    })
    expect(importFail.status).toBe(413)
    expect(await importFail.json()).toEqual({
      error: "File too large",
      code: "FILE_TOO_LARGE",
      limitBytes: 1024 * 1024
    })

    const importOk = await request(env, "/api/import/files", {
      method: "POST",
      headers: { authorization: `Bearer ${importToken.token}` },
      body: formWithBytes(halfMb, "test.png", "image/png")
    })
    expect(importOk.status).toBe(201)

    // 3. 令牌入口：POST /api/write/files
    const writeFail = await request(env, "/api/write/files", {
      method: "POST",
      headers: { authorization: `Bearer ${writeToken.token}` },
      body: formWithBytes(twoMb, "test.png", "image/png")
    })
    expect(writeFail.status).toBe(413)
    expect(await writeFail.json()).toEqual({
      error: "File too large",
      code: "FILE_TOO_LARGE",
      limitBytes: 1024 * 1024
    })

    const writeOk = await request(env, "/api/write/files", {
      method: "POST",
      headers: { authorization: `Bearer ${writeToken.token}` },
      body: formWithBytes(halfMb, "test.png", "image/png")
    })
    expect(writeOk.status).toBe(201)
  })

  it("设 25MB → 11MB GIF 三入口均通过并可回源打开；改回默认 → 11MB 再被拒且 limitBytes=10485760", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)
    const importToken = await createImportToken(env, admin)
    const writeToken = await createApiToken(env, admin, "write")

    // 设上限为 25MB
    await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      { maxImageUploadMb: 25 },
      admin
    )

    const elevenMbGif = new Uint8Array(11 * 1024 * 1024)
    elevenMbGif.set(GIF)

    // 1. 会话入口上传 11MB GIF 通过
    const sessionOk = await request(env, "/api/files", {
      method: "POST",
      headers: { cookie: admin },
      body: formWithBytes(elevenMbGif, "anim.gif", "image/gif")
    })
    expect(sessionOk.status).toBe(201)
    const sessionData = (await sessionOk.json()) as { key: string; url: string }
    expect(r2.store.has(sessionData.key)).toBe(true)

    // 回源 GET 打开正常
    const sessionGet = await request(env, sessionData.url, {
      headers: { cookie: admin }
    })
    expect(sessionGet.status).toBe(200)
    expect(sessionGet.headers.get("content-type")).toBe("image/gif")
    expect(new Uint8Array(await sessionGet.arrayBuffer())).toEqual(elevenMbGif)

    // 2. 导入入口上传 11MB GIF 通过
    const importOk = await request(env, "/api/import/files", {
      method: "POST",
      headers: { authorization: `Bearer ${importToken.token}` },
      body: formWithBytes(elevenMbGif, "import.gif", "image/gif")
    })
    expect(importOk.status).toBe(201)
    const importData = (await importOk.json()) as { key: string; url: string }
    expect(r2.store.has(importData.key)).toBe(true)

    // 3. 令牌入口上传 11MB GIF 通过
    const writeOk = await request(env, "/api/write/files", {
      method: "POST",
      headers: { authorization: `Bearer ${writeToken.token}` },
      body: formWithBytes(elevenMbGif, "write.gif", "image/gif")
    })
    expect(writeOk.status).toBe(201)
    const writeData = (await writeOk.json()) as { key: string; url: string }
    expect(r2.store.has(writeData.key)).toBe(true)

    // 4. 改回默认 10MB（PUT null）
    await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      { maxImageUploadMb: null },
      admin
    )

    // 11MB GIF 在三个入口再次被拒，且 limitBytes 为默认 10MB
    const defaultLimit = 10 * 1024 * 1024

    const sessionFail = await request(env, "/api/files", {
      method: "POST",
      headers: { cookie: admin },
      body: formWithBytes(elevenMbGif, "anim.gif", "image/gif")
    })
    expect(sessionFail.status).toBe(413)
    expect(await sessionFail.json()).toEqual({
      error: "File too large",
      code: "FILE_TOO_LARGE",
      limitBytes: defaultLimit
    })

    const importFail = await request(env, "/api/import/files", {
      method: "POST",
      headers: { authorization: `Bearer ${importToken.token}` },
      body: formWithBytes(elevenMbGif, "import.gif", "image/gif")
    })
    expect(importFail.status).toBe(413)
    expect(await importFail.json()).toEqual({
      error: "File too large",
      code: "FILE_TOO_LARGE",
      limitBytes: defaultLimit
    })

    const writeFail = await request(env, "/api/write/files", {
      method: "POST",
      headers: { authorization: `Bearer ${writeToken.token}` },
      body: formWithBytes(elevenMbGif, "write.gif", "image/gif")
    })
    expect(writeFail.status).toBe(413)
    expect(await writeFail.json()).toEqual({
      error: "File too large",
      code: "FILE_TOO_LARGE",
      limitBytes: defaultLimit
    })
  })

  it("Content-Length 头预检：超过生效上限 + 1MB 余量时直接返回 413 且携带 limitBytes", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 上限设为 5MB
    await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      { maxImageUploadMb: 5 },
      admin
    )

    const limitBytes = 5 * 1024 * 1024
    const overDeclared = String(limitBytes + 1024 * 1024 + 1)

    const res = await request(env, "/api/files", {
      method: "POST",
      headers: {
        cookie: admin,
        "content-length": overDeclared,
        "content-type": "multipart/form-data; boundary=----WebKitFormBoundary"
      },
      body: "dummy"
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({
      error: "File too large",
      code: "FILE_TOO_LARGE",
      limitBytes
    })
  })
})

describe("不动的上限回归不变（头像 2MB、场景 2MB、Embed 1MB）", () => {
  it("即使 maxImageUploadMb 设为 25MB 或 1MB，头像上限仍写死 2MB", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 设通用图片为 25MB
    await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      { maxImageUploadMb: 25 },
      admin
    )

    // 2.5MB 头像上传必须被拒 413，且 limitBytes 为 2MB
    const twoAndHalfMb = new Uint8Array(2.5 * 1024 * 1024)
    twoAndHalfMb.set(PNG)

    const avatarRes = await request(env, "/api/me/avatar", {
      method: "POST",
      headers: { cookie: admin },
      body: formWithBytes(twoAndHalfMb, "avatar.png", "image/png")
    })
    expect(avatarRes.status).toBe(413)
    expect(await avatarRes.json()).toEqual({
      error: "File too large",
      code: "FILE_TOO_LARGE",
      limitBytes: 2 * 1024 * 1024
    })

    // 正好 2MB 头像允许上传
    const exact2Mb = new Uint8Array(2 * 1024 * 1024)
    exact2Mb.set(PNG)
    const exactAvatar = await request(env, "/api/me/avatar", {
      method: "POST",
      headers: { cookie: admin },
      body: formWithBytes(exact2Mb, "avatar.png", "image/png")
    })
    expect(exactAvatar.status).toBe(200)
  })

  it("Excalidraw 场景 JSON 上限仍写死 2MB 且 413 带 limitBytes=2MB", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 即使通用图片设为 25MB
    await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      { maxImageUploadMb: 25 },
      admin
    )

    // 2.5MB 场景 JSON
    const bigJson = new Uint8Array(2.5 * 1024 * 1024)
    const res = await request(env, "/api/files", {
      method: "POST",
      headers: { cookie: admin },
      body: formWithBytes(bigJson, "scene.json", "application/json")
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({
      error: "File too large",
      code: "FILE_TOO_LARGE",
      limitBytes: 2 * 1024 * 1024
    })
  })

  it("Embed HTML 上限仍写死 1MB 且 413 不携带 limitBytes", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 1.5MB embed
    const bigHtml = new Uint8Array(1.5 * 1024 * 1024)
    const res = await request(env, "/api/files/embeds", {
      method: "POST",
      headers: { cookie: admin },
      body: formWithBytes(bigHtml, "scene.html", "text/html")
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({
      error: "File too large",
      code: "FILE_TOO_LARGE"
    })
  })
})
