import { describe, expect, it } from "vitest"
import type { Env } from "../src/types"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  register,
  request,
  userSession
} from "./support/app"

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52
])

interface MeShape {
  id: number
  username: string
  email: string
  role: string
  avatarUrl: string | null
  approvalStatus: string
  createdAt: string
  twofa: { totpEnabled: boolean; passkeyEnabled: boolean; passkeyCount: number }
}

async function me(env: Env, cookie: string): Promise<MeShape> {
  const res = await jsonRequest(env, "GET", "/api/me", undefined, cookie)
  expect(res.status).toBe(200)
  return (await res.json()) as MeShape
}

async function uploadImage(
  env: Env,
  cookie: string
): Promise<{ key: string; url: string }> {
  const form = new FormData()
  form.append("file", new File([PNG], "avatar.png", { type: "image/png" }))
  const res = await request(env, "/api/files", {
    method: "POST",
    headers: { cookie },
    body: form
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { key: string; url: string }
}

function avatarForm(bytes: Uint8Array, type = "image/png"): FormData {
  const form = new FormData()
  form.append("file", new File([bytes], "avatar.png", { type }))
  return form
}

async function postAvatar(
  env: Env,
  cookie: string,
  form: FormData
): Promise<Response> {
  return request(env, "/api/me/avatar", {
    method: "POST",
    headers: cookie ? { cookie } : {},
    body: form
  })
}

describe("身份模型：username 与显示名", () => {
  it("注册即以邮箱前缀作 username，对外身份不含内部整数 id", async () => {
    const { env, db } = await initializedContext()
    const cookie = await adminSession(env, "alice@example.com")

    const profile = await me(env, cookie)
    expect(profile.username).toBe("alice")
    expect(profile.email).toBe("alice@example.com")
    expect(profile.avatarUrl).toBeNull()
    expect(profile).not.toHaveProperty("publicId")

    const row = db.db
      .prepare("SELECT id, username FROM ciki_users WHERE email = ?")
      .get("alice@example.com") as { id: number; username: string }
    expect(row.username).toBe("alice")
    expect(Number.isInteger(row.id)).toBe(true)
    expect(profile.id).toBe(row.id)
  })

  it("注册时 username 唯一（重名自动加后缀）；重复邮箱注册 409 EMAIL_TAKEN", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env, "alice@example.com")
    const other = await userSession(env, admin, "bob@example.com")

    const [first, second] = [await me(env, admin), await me(env, other)]
    expect(second.username).toBe("bob")
    expect(second.id).not.toBe(first.id)

    const duplicate = await register(env, "alice@example.com")
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toMatchObject({ code: "EMAIL_TAKEN" })
  })

  it("PUT /api/me/profile 改显示名；id/email/username 之外的字段不接受写入", async () => {
    const { env } = await initializedContext()
    const cookie = await adminSession(env)
    const before = await me(env, cookie)

    const saved = await jsonRequest(
      env,
      "PUT",
      "/api/me/profile",
      { username: "  观察者  " },
      cookie
    )
    expect(saved.status).toBe(200)
    expect(((await saved.json()) as MeShape).username).toBe("观察者")
    expect((await me(env, cookie)).username).toBe("观察者")

    const invalid = await jsonRequest(
      env,
      "PUT",
      "/api/me/profile",
      { username: "" },
      cookie
    )
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: "INVALID_USERNAME" })

    for (const body of [
      {},
      { username: "   " },
      { username: "x".repeat(41) },
      { username: 123 },
      { username: "a\nb" }
    ]) {
      const res = await jsonRequest(env, "PUT", "/api/me/profile", body, cookie)
      expect(res.status).toBe(400)
    }

    const readOnly = await jsonRequest(
      env,
      "PUT",
      "/api/me/profile",
      { id: 999, email: "other@example.com" },
      cookie
    )
    expect(readOnly.status).toBe(400)
    const after = await me(env, cookie)
    expect(after.id).toBe(before.id)
    expect(after.email).toBe(before.email)
    // 上面已经成功改过名，这里确认只读字段的写入被整单拒绝、名字没被带回旧值。
    expect(after.username).toBe("观察者")
  })
})

describe("Profile 头像", () => {
  it("本人上传的 key 可设为头像；换头像删旧图；他人 key/虚构 key 400；null 清除", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env, "alice@example.com")
    const other = await userSession(env, admin, "bob@example.com")

    const first = await uploadImage(env, admin)
    const setFirst = await jsonRequest(
      env,
      "PUT",
      "/api/me/profile",
      { avatarKey: first.key },
      admin
    )
    expect(setFirst.status).toBe(200)
    expect((await setFirst.json()) as MeShape).toMatchObject({
      avatarUrl: `/api/files/${first.key}`
    })
    expect((await me(env, admin)).avatarUrl).toBe(`/api/files/${first.key}`)

    const second = await uploadImage(env, admin)
    const setSecond = await jsonRequest(
      env,
      "PUT",
      "/api/me/profile",
      { avatarKey: second.key },
      admin
    )
    expect(setSecond.status).toBe(200)
    expect(r2.store.has(first.key)).toBe(false)
    expect(r2.store.has(second.key)).toBe(true)

    const foreign = await uploadImage(env, other)
    const steal = await jsonRequest(
      env,
      "PUT",
      "/api/me/profile",
      { avatarKey: foreign.key },
      admin
    )
    expect(steal.status).toBe(400)
    expect(await steal.json()).toMatchObject({ code: "INVALID_AVATAR" })
    expect((await me(env, admin)).avatarUrl).toBe(`/api/files/${second.key}`)

    for (const avatarKey of [
      "not-a-key.png",
      "00000000-0000-0000-0000-000000000000.png",
      123
    ]) {
      const res = await jsonRequest(
        env,
        "PUT",
        "/api/me/profile",
        { avatarKey },
        admin
      )
      expect(res.status).toBe(400)
    }

    const cleared = await jsonRequest(
      env,
      "PUT",
      "/api/me/profile",
      { avatarKey: null },
      admin
    )
    expect(cleared.status).toBe(200)
    expect((await me(env, admin)).avatarUrl).toBeNull()
    expect(r2.store.has(second.key)).toBe(false)
  })
})

describe("头像专用上传口", () => {
  it("一次请求落 avatars/ 并换头像：响应同 GET /api/me、写 uploaderId/category、删旧图", async () => {
    const { env, r2 } = await initializedContext()
    const admin = await adminSession(env)

    const first = await postAvatar(env, admin, avatarForm(PNG))
    expect(first.status).toBe(200)
    const firstMe = (await first.json()) as MeShape
    const firstKey = (firstMe.avatarUrl ?? "").replace("/api/files/", "")
    expect(firstKey).toMatch(/^avatars\/[0-9a-f-]{36}\.png$/)
    expect(firstMe).toEqual(await me(env, admin))
    // R2 的 customMetadata 只收字符串：整数用户 id 落库时转成十进制文本。
    expect(r2.store.get(firstKey)?.customMetadata).toMatchObject({
      uploaderId: String(firstMe.id),
      category: "avatars"
    })

    // 头像 URL 指向 avatars/ 前缀，带会话可读
    const read = await request(env, firstMe.avatarUrl ?? "", {
      headers: { cookie: admin }
    })
    expect(read.status).toBe(200)

    const second = await postAvatar(env, admin, avatarForm(PNG))
    expect(second.status).toBe(200)
    const secondMe = (await second.json()) as MeShape
    const secondKey = (secondMe.avatarUrl ?? "").replace("/api/files/", "")
    expect(secondKey).not.toBe(firstKey)
    expect(r2.store.has(firstKey)).toBe(false)
    expect(r2.store.has(secondKey)).toBe(true)
    expect(await me(env, admin)).toEqual(secondMe)
  })

  it("校验口径与 /api/files 一致：非图片 400、超 10MB 413、未登录 401", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const fake = await postAvatar(
      env,
      admin,
      avatarForm(new TextEncoder().encode("not really an image"))
    )
    expect(fake.status).toBe(400)

    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    big.set(PNG)
    const tooLarge = await postAvatar(env, admin, avatarForm(big))
    expect(tooLarge.status).toBe(413)
    expect(await tooLarge.json()).toMatchObject({ code: "FILE_TOO_LARGE" })

    const anonymous = await postAvatar(env, "", avatarForm(PNG))
    expect(anonymous.status).toBe(401)

    // 失败一律不落盘、不改头像
    expect((await me(env, admin)).avatarUrl).toBeNull()
  })
})

describe("邮箱唯一：冲突一律 409 而不是 500", () => {
  it("管理员改邮箱撞已有邮箱 → 409 EMAIL_TAKEN，原值不变", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env, "alice@example.com")
    const other = await userSession(env, admin, "bob@example.com")
    const bob = await me(env, other)

    const res = await jsonRequest(
      env,
      "PUT",
      `/api/admin/users/${bob.id}`,
      { email: "alice@example.com" },
      admin
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "EMAIL_TAKEN" })
    expect((await me(env, other)).email).toBe("bob@example.com")
  })

  it("管理员建号撞已有邮箱 → 409 EMAIL_TAKEN", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env, "alice@example.com")

    const res = await jsonRequest(
      env,
      "POST",
      "/api/admin/users",
      { email: "alice@example.com", password: "another-password" },
      admin
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "EMAIL_TAKEN" })
  })
})

describe("站点名称", () => {
  it("默认 Ciki；管理员改名后管理端与公开配置同时生效", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const initial = (await (
      await jsonRequest(env, "GET", "/api/admin/settings", undefined, admin)
    ).json()) as { siteName: string }
    expect(initial.siteName).toBe("Ciki")
    const publicInitial = (await (
      await request(env, "/api/auth/config")
    ).json()) as {
      siteName: string
    }
    expect(publicInitial.siteName).toBe("Ciki")

    const saved = await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      { siteName: "  团队文档  " },
      admin
    )
    expect(saved.status).toBe(200)

    const after = (await (
      await jsonRequest(env, "GET", "/api/admin/settings", undefined, admin)
    ).json()) as { siteName: string }
    expect(after.siteName).toBe("团队文档")
    const publicAfter = (await (
      await request(env, "/api/auth/config")
    ).json()) as {
      siteName: string
    }
    expect(publicAfter.siteName).toBe("团队文档")
  })

  it("仅管理员可改；非法站点名 400 且不改值", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)

    const denied = await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      { siteName: "别人改的" },
      user
    )
    expect(denied.status).toBe(403)

    for (const siteName of ["", "   ", "x".repeat(33), 123, "a\nb"]) {
      const res = await jsonRequest(
        env,
        "PUT",
        "/api/admin/settings",
        { siteName },
        admin
      )
      expect(res.status).toBe(400)
    }

    const current = (await (
      await jsonRequest(env, "GET", "/api/admin/settings", undefined, admin)
    ).json()) as { siteName: string }
    expect(current.siteName).toBe("Ciki")
  })
})
