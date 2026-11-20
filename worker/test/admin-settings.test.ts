import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  request
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
})
