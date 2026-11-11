import { describe, expect, it } from "vitest"
import type { Env } from "../src/types"
import { isUsernameConflict } from "../src/core/identity"
import { insertWithUniqueUsername } from "../src/core/username"
import {
  adminSession,
  enableSmtpConfig,
  initializedContext,
  jsonRequest,
  register,
  request,
  userSession,
  type TestContext
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

describe("username 唯一性：自动后缀、改名撞名 409", () => {
  /** 按邮箱读库里的显示名（比 /api/me 少绕一层，注册后不必登录）。 */
  function usernameOf(db: TestContext["db"], email: string): string {
    const row = db.db
      .prepare("SELECT username FROM ciki_users WHERE email = ?")
      .get(email) as { username: string } | undefined
    if (!row) throw new Error("user not found")
    return row.username
  }

  it("注册与管理员建号：撞名自动加 -2/-3，后缀不超 40 码点", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env, "owner@example.com")
    await enableSmtpConfig(env)

    // 同前缀、不同域：邮箱不同，显示名相同。
    for (const email of ["dup@example.com", "dup@example.org"]) {
      const res = await register(env, email)
      expect(res.status).toBe(201)
    }
    expect(usernameOf(db, "dup@example.com")).toBe("dup")
    expect(usernameOf(db, "dup@example.org")).toBe("dup-2")

    // 管理员后台建号同口径。
    const created = await jsonRequest(
      env,
      "POST",
      "/api/admin/users",
      { email: "dup@example.net", password: "Test-Password-123" },
      admin
    )
    expect(created.status).toBe(201)
    expect(usernameOf(db, "dup@example.net")).toBe("dup-3")

    // 40 码点基础名：后缀算在 40 码点之内（截短腾位），不是超限截断掉后缀。
    const long = "a".repeat(42)
    for (const email of [`${long}@example.com`, `${long}@example.org`]) {
      expect((await register(env, email)).status).toBe(201)
    }
    const first = usernameOf(db, `${long}@example.com`)
    const second = usernameOf(db, `${long}@example.org`)
    expect(Array.from(first)).toHaveLength(40)
    expect(Array.from(second)).toHaveLength(40)
    expect(second).toBe(`${"a".repeat(38)}-2`)
  })

  it("改名撞名 409 USERNAME_TAKEN（大小写也算）；改成自己当前名可以", async () => {
    const { env } = await initializedContext()
    const alice = await adminSession(env, "alice@example.com")
    const bob = await userSession(env, alice, "bob@example.com")

    const clash = await jsonRequest(
      env,
      "PUT",
      "/api/me/profile",
      { username: "Alice" },
      bob
    )
    expect(clash.status).toBe(409)
    expect(await clash.json()).toMatchObject({ code: "USERNAME_TAKEN" })
    expect((await me(env, bob)).username).toBe("bob")

    // 自己改名只换大小写不算撞名。
    const self = await jsonRequest(
      env,
      "PUT",
      "/api/me/profile",
      { username: "Bob" },
      bob
    )
    expect(self.status).toBe(200)
    expect((await me(env, bob)).username).toBe("Bob")
  })

  it("并发兜底：查重后写入撞唯一约束 → 换下一个后缀，不回 500", async () => {
    const { env } = await initializedContext()
    await adminSession(env, "seed@example.com")

    let attempts = 0
    const name = await insertWithUniqueUsername(
      env.DB,
      "ciki_",
      "fresh",
      async (username) => {
        attempts += 1
        if (attempts === 1) {
          // 等价于「查完重名、写入那一刻被别人占了」，用 D1 的真实报法。
          throw new Error(
            "D1_ERROR: UNIQUE constraint failed: ciki_users.username: SQLITE_CONSTRAINT"
          )
        }
        return username
      }
    )
    expect(name).toBe("fresh-2")
    expect(attempts).toBe(2)

    // 邮箱冲突不是重名：原样抛给路由层（映射 409 EMAIL_TAKEN），不静默重试。
    await expect(
      insertWithUniqueUsername(env.DB, "ciki_", "other", async () => {
        throw new Error("UNIQUE constraint failed: ciki_users.email")
      })
    ).rejects.toThrow(/users\.email/)
  })

  it("唯一约束分类：按 <表>.<列> 精确判定，邮箱冲突与其它错误都不算重名", () => {
    // 列形态（SQLite 对列唯一索引的报法，带表前缀时是 <前缀>users.username）。
    expect(
      isUsernameConflict(
        new Error("UNIQUE constraint failed: ciki_users.username")
      )
    ).toBe(true)
    expect(
      isUsernameConflict(new Error("UNIQUE constraint failed: users.username"))
    ).toBe(true)
    // 多列唯一索引：逗号分隔，任一段是 username 才是重名。
    expect(
      isUsernameConflict(
        new Error(
          "UNIQUE constraint failed: ciki_users.email, ciki_users.username"
        )
      )
    ).toBe(true)
    // 邮箱冲突：不是重名，绝不能被重试吞掉。
    expect(
      isUsernameConflict(
        new Error("UNIQUE constraint failed: ciki_users.email")
      )
    ).toBe(false)
    expect(
      isUsernameConflict(
        new Error("UNIQUE constraint failed: ciki_users.old_username")
      )
    ).toBe(false)
    // 表达式索引的报法才带索引名；非 username 索引不算。
    expect(
      isUsernameConflict(
        new Error("UNIQUE constraint failed: index 'ciki_users_username'")
      )
    ).toBe(true)
    expect(
      isUsernameConflict(
        new Error("UNIQUE constraint failed: index 'ciki_users_email'")
      )
    ).toBe(false)
    // D1 会在末尾追加 `: SQLITE_CONSTRAINT`（真实线上报法），不能因此漏判。
    expect(
      isUsernameConflict(
        new Error(
          "D1_ERROR: UNIQUE constraint failed: ciki_users.username: SQLITE_CONSTRAINT"
        )
      )
    ).toBe(true)
    expect(
      isUsernameConflict(
        new Error(
          "D1_ERROR: UNIQUE constraint failed: ciki_users.email: SQLITE_CONSTRAINT"
        )
      )
    ).toBe(false)
    expect(
      isUsernameConflict(
        new Error(
          "D1_ERROR: UNIQUE constraint failed: index 'ciki_users_username': SQLITE_CONSTRAINT"
        )
      )
    ).toBe(true)
    // 非唯一约束、非约束错误一律不算。
    expect(
      isUsernameConflict(
        new Error("NOT NULL constraint failed: ciki_users.username")
      )
    ).toBe(false)
    expect(isUsernameConflict(new Error("boom"))).toBe(false)
  })

  it("首个用户守卫：insert 返回 null 原样返回、不重试，路由据此回 503", async () => {
    const { env } = await initializedContext()
    await adminSession(env, "dup@example.com")

    // 单元层：null 是「没建号」的终态，不能被当成一次失败的后缀重试。
    let attempts = 0
    const notCreated = await insertWithUniqueUsername(
      env.DB,
      "ciki_",
      "fresh",
      async () => {
        attempts += 1
        return null
      }
    )
    expect(notCreated).toBeNull()
    expect(attempts).toBe(1)

    // 路由层：表已非空 + 想要的用户名已被占（会先试 dup、dup-2 再写入），
    // 未配发信时的守卫拦下写入 → 仍是 503，不是重试耗尽后的 500。
    const res = await register(env, "dup@example.org")
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: "EMAIL_NOT_CONFIGURED" })
  })

  it("评论按 username 展示：重名账号显示 dup-2", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env, "alice@example.com")
    const first = await userSession(env, admin, "dup@example.org")
    const suffixed = await userSession(env, admin, "dup@example.com")

    const spaces = (await (
      await jsonRequest(env, "GET", "/api/spaces", undefined, admin)
    ).json()) as Array<{ id: number; isDefault: boolean }>
    const spaceId = spaces.find((space) => space.isDefault)?.id
    expect(spaceId).toBeDefined()

    const suffixedId = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, suffixed)
    ).json()) as { id: number }
    await jsonRequest(
      env,
      "POST",
      `/api/spaces/${spaceId}/members`,
      { userId: suffixedId.id, role: "editor" },
      admin
    )

    const page = (await (
      await jsonRequest(
        env,
        "POST",
        "/api/pages",
        {
          title: "评论展示",
          spaceId,
          parentId: null,
          contentJson: JSON.stringify({ type: "doc" }),
          contentHtml: "<p>评论展示</p>",
          contentText: "评论展示"
        },
        admin
      )
    ).json()) as { id: number }

    const posted = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments`,
      { bodyMd: "重名账号的评论" },
      suffixed
    )
    expect(posted.status).toBe(201)

    const threads = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${page.id}/comments`,
        undefined,
        admin
      )
    ).json()) as { threads: Array<{ authorName: string }> }
    expect(threads.threads[0]?.authorName).toBe("dup-2")
    // 先注册的那一个保持 dup，没有被误改。
    expect((await me(env, first)).username).toBe("dup")
  })
})
