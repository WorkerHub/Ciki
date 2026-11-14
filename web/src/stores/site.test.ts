import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_SITE_NAME, useSiteStore } from "@/stores/site"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    siteApi: { ...actual.siteApi, get: vi.fn() }
  }
})

const { siteApi } = await import("@/lib/api")

const reset = () =>
  useSiteStore.setState({
    name: DEFAULT_SITE_NAME,
    emailConfigured: false,
    loaded: false
  })

/**
 * 发信状态（emailConfigured）是邮箱 2FA 入口的唯一开关。
 * 系统管理保存 SMTP 后要能让用户安全设置页当场跟上，不能靠强刷浏览器。
 */
describe("站点公开配置的同步", () => {
  beforeEach(() => {
    reset()
    vi.mocked(siteApi.get).mockReset()
  })

  it("load() 同时刷新站名与发信状态", async () => {
    vi.mocked(siteApi.get).mockResolvedValue({
      siteName: "团队知识库",
      emailConfigured: true
    })

    await useSiteStore.getState().load()

    expect(useSiteStore.getState().name).toBe("团队知识库")
    expect(useSiteStore.getState().emailConfigured).toBe(true)
    expect(useSiteStore.getState().loaded).toBe(true)
  })

  it("load() 失败时保留现值，只把 loaded 置真", async () => {
    useSiteStore.setState({ name: "旧站名", emailConfigured: true })
    vi.mocked(siteApi.get).mockRejectedValue(new Error("boom"))

    await useSiteStore.getState().load()

    expect(useSiteStore.getState().name).toBe("旧站名")
    expect(useSiteStore.getState().emailConfigured).toBe(true)
    expect(useSiteStore.getState().loaded).toBe(true)
  })

  it("已知发信状态时直接同步，不必再发一次请求", () => {
    useSiteStore.getState().setEmailConfigured(true)
    expect(useSiteStore.getState().emailConfigured).toBe(true)

    useSiteStore.getState().setEmailConfigured(false)
    expect(useSiteStore.getState().emailConfigured).toBe(false)
    expect(siteApi.get).not.toHaveBeenCalled()
  })
})
