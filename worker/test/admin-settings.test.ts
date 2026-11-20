import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"

type SettingsShape = {
  setupPageEnabled: boolean
  /** 嵌套 setup 对象必须不存在（不留双形状兼容层）。 */
  setup?: unknown
}

function getSettings(env: Parameters<typeof jsonRequest>[0], cookie: string) {
  return jsonRequest(env, "GET", "/api/admin/settings", undefined, cookie)
}

function setupState(env: Parameters<typeof request>[0]) {
  return request(env, "/api/setup/state")
}

describe("系统管理 · 初始化页面开关（setupPageEnabled 契约往返）", () => {
  it("初始化完成后 setupPageEnabled=false 且无嵌套 setup 对象", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const res = await getSettings(env, admin)
    expect(res.status).toBe(200)
    const body = (await res.json()) as SettingsShape
    expect(body.setupPageEnabled).toBe(false)
    expect(body.setup).toBeUndefined()
  })

  it("同实例连续往返：初始 false → PATCH 设 true（GET true, state true）→ PATCH 设 false（GET false, state false）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 1. 初始状态：setupPageEnabled=false，setupState enabled=false，无嵌套 setup
    const initialRes = await getSettings(env, admin)
    expect(initialRes.status).toBe(200)
    const initialBody = (await initialRes.json()) as SettingsShape
    expect(initialBody.setupPageEnabled).toBe(false)
    expect(initialBody.setup).toBeUndefined()

    const initialState = (await (await setupState(env)).json()) as {
      enabled: boolean
    }
    expect(initialState.enabled).toBe(false)

    // 2. PATCH 设 true：落库后 GET 回读为 true，/api/setup/state 联动为 true
    const patchTrue = await jsonRequest(
      env,
      "PATCH",
      "/api/admin/settings",
      { setupPageEnabled: true },
      admin
    )
    expect(patchTrue.status).toBe(200)

    const afterTrue = (await (
      await getSettings(env, admin)
    ).json()) as SettingsShape
    expect(afterTrue.setupPageEnabled).toBe(true)
    expect(afterTrue.setup).toBeUndefined()

    const stateTrue = (await (await setupState(env)).json()) as {
      enabled: boolean
    }
    expect(stateTrue.enabled).toBe(true)

    // 3. 同一实例接着 PATCH 设 false：落库后 GET 回读为 false，/api/setup/state 联动为 false
    const patchFalse = await jsonRequest(
      env,
      "PATCH",
      "/api/admin/settings",
      { setupPageEnabled: false },
      admin
    )
    expect(patchFalse.status).toBe(200)

    const afterFalse = (await (
      await getSettings(env, admin)
    ).json()) as SettingsShape
    expect(afterFalse.setupPageEnabled).toBe(false)
    expect(afterFalse.setup).toBeUndefined()

    const stateFalse = (await (await setupState(env)).json()) as {
      enabled: boolean
    }
    expect(stateFalse.enabled).toBe(false)
  })

  it("PATCH 设 true：落库后 GET 返回 true，/api/setup/state 同步 enabled=true", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const patch = await jsonRequest(
      env,
      "PATCH",
      "/api/admin/settings",
      { setupPageEnabled: true },
      admin
    )
    expect(patch.status).toBe(200)

    const after = (await (
      await getSettings(env, admin)
    ).json()) as SettingsShape
    expect(after.setupPageEnabled).toBe(true)
    expect(after.setup).toBeUndefined()

    const state = (await (await setupState(env)).json()) as {
      enabled: boolean
    }
    expect(state.enabled).toBe(true)
  })

  it("PATCH 设 false：落库后 GET 返回 false，/api/setup/state 同步 enabled=false", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const patch = await jsonRequest(
      env,
      "PATCH",
      "/api/admin/settings",
      { setupPageEnabled: false },
      admin
    )
    expect(patch.status).toBe(200)

    const after = (await (
      await getSettings(env, admin)
    ).json()) as SettingsShape
    expect(after.setupPageEnabled).toBe(false)
    expect(after.setup).toBeUndefined()

    const state = (await (await setupState(env)).json()) as {
      enabled: boolean
    }
    expect(state.enabled).toBe(false)
  })

  it("PUT 与 PATCH 同源：PUT 设 true 同样落库并回读为 true", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const put = await jsonRequest(
      env,
      "PUT",
      "/api/admin/settings",
      { setupPageEnabled: true },
      admin
    )
    expect(put.status).toBe(200)

    const after = (await (
      await getSettings(env, admin)
    ).json()) as SettingsShape
    expect(after.setupPageEnabled).toBe(true)
    expect(after.setup).toBeUndefined()
  })

  it("非 boolean 值一律 400 且不改库", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    for (const value of [1, "true", null, {}, ["x"]]) {
      const res = await jsonRequest(
        env,
        "PATCH",
        "/api/admin/settings",
        { setupPageEnabled: value },
        admin
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({
        error: "setupPageEnabled must be a boolean"
      })
    }

    const after = (await (
      await getSettings(env, admin)
    ).json()) as SettingsShape
    expect(after.setupPageEnabled).toBe(false)
  })

  it("局部更新字段隔离：PATCH setupPageEnabled 不影响 siteName 等配置，反之亦然", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 先设定自定义 siteName
    const rename = await jsonRequest(
      env,
      "PATCH",
      "/api/admin/settings",
      { siteName: "Custom Site" },
      admin
    )
    expect(rename.status).toBe(200)

    // PATCH 仅设 setupPageEnabled: true
    const patch = await jsonRequest(
      env,
      "PATCH",
      "/api/admin/settings",
      { setupPageEnabled: true },
      admin
    )
    expect(patch.status).toBe(200)

    const settings1 = (await (await getSettings(env, admin)).json()) as {
      siteName: string
      setupPageEnabled: boolean
    }
    expect(settings1.siteName).toBe("Custom Site")
    expect(settings1.setupPageEnabled).toBe(true)

    // PATCH 更新 siteName 不影响已设置的 setupPageEnabled
    const patch2 = await jsonRequest(
      env,
      "PATCH",
      "/api/admin/settings",
      { siteName: "Updated Name" },
      admin
    )
    expect(patch2.status).toBe(200)

    const settings2 = (await (await getSettings(env, admin)).json()) as {
      siteName: string
      setupPageEnabled: boolean
    }
    expect(settings2.siteName).toBe("Updated Name")
    expect(settings2.setupPageEnabled).toBe(true)
  })

  it("越权拦截：未认证或普通用户 PATCH 设 setupPageEnabled 被拦截且不改值", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)

    // 1. 未认证 401
    const unauth = await jsonRequest(env, "PATCH", "/api/admin/settings", {
      setupPageEnabled: true
    })
    expect(unauth.status).toBe(401)

    // 2. 普通用户 403
    const forbidden = await jsonRequest(
      env,
      "PATCH",
      "/api/admin/settings",
      { setupPageEnabled: true },
      user
    )
    expect(forbidden.status).toBe(403)

    // 3. 校验状态依然未变（false）
    const after = (await (
      await getSettings(env, admin)
    ).json()) as SettingsShape
    expect(after.setupPageEnabled).toBe(false)
  })
})
