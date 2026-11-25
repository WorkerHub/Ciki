import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Me } from "@/lib/api"
import { THEME_META_COLORS } from "@/lib/theme"
import { useAuthStore } from "@/stores/auth"
import {
  _resetThemeMigratingForTest,
  syncAccountTheme,
  useThemeStore
} from "@/stores/theme"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    meApi: {
      ...actual.meApi,
      updateThemeStyle: vi.fn()
    }
  }
})

const { meApi } = await import("@/lib/api")

function setSystemDark(dark: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: dark,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

const isDark = () => document.documentElement.classList.contains("dark")

describe("主题三档（亮 / 暗 / 自动）", () => {
  beforeEach(() => {
    document.documentElement.className = ""
    document.documentElement.removeAttribute("data-mode")
    document.documentElement.removeAttribute("data-theme")
    localStorage.clear()
    useThemeStore.setState({ theme: "auto", style: "nova" })
  })

  it("深色档：写 .dark、data-mode 与 color-scheme，并持久化", () => {
    useThemeStore.getState().setTheme("dark")
    expect(isDark()).toBe(true)
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark")
    expect(document.documentElement.style.colorScheme).toBe("dark")
    expect(localStorage.getItem("ciki-theme")).toContain('"theme":"dark"')
  })

  it("浅色档：撤掉 .dark，Kumo 的 data-mode 同步为 light", () => {
    useThemeStore.getState().setTheme("dark")
    useThemeStore.getState().setTheme("light")
    expect(isDark()).toBe(false)
    expect(document.documentElement.getAttribute("data-mode")).toBe("light")
    expect(useThemeStore.getState().resolved).toBe("light")
  })

  it("自动档跟随系统，系统变化时重算", () => {
    setSystemDark(true)
    useThemeStore.getState().setTheme("auto")
    expect(isDark()).toBe(true)
    expect(useThemeStore.getState().resolved).toBe("dark")

    setSystemDark(false)
    useThemeStore.getState().syncSystem()
    expect(isDark()).toBe(false)
    expect(useThemeStore.getState().resolved).toBe("light")
  })

  it("自动档下系统切到深色时 syncSystem 会跟随", () => {
    setSystemDark(false)
    useThemeStore.getState().setTheme("auto")
    expect(isDark()).toBe(false)
    setSystemDark(true)
    useThemeStore.getState().syncSystem()
    expect(isDark()).toBe(true)
  })

  it("风格切换：切至纸面写 data-theme=paper 并持久化，切回 Nova 写 data-theme=nova", () => {
    useThemeStore.getState().setStyle("paper")
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper")
    expect(localStorage.getItem("ciki-theme")).toContain('"style":"paper"')

    useThemeStore.getState().setStyle("nova")
    expect(document.documentElement.getAttribute("data-theme")).toBe("nova")
    expect(localStorage.getItem("ciki-theme")).toContain('"style":"nova"')
  })

  it("2 主题 × 2 模式矩阵：各组合下属性、meta theme-color 与类名准确落定", () => {
    let meta = document.querySelector('meta[name="theme-color"]')
    if (!meta) {
      meta = document.createElement("meta")
      meta.setAttribute("name", "theme-color")
      document.head.appendChild(meta)
    }

    // 1. Nova 浅色
    useThemeStore.getState().setStyle("nova")
    useThemeStore.getState().setTheme("light")
    expect(document.documentElement.getAttribute("data-theme")).toBe("nova")
    expect(document.documentElement.getAttribute("data-mode")).toBe("light")
    expect(isDark()).toBe(false)
    expect(meta.getAttribute("content")).toBe("#ffffff")

    // 2. Nova 深色
    useThemeStore.getState().setStyle("nova")
    useThemeStore.getState().setTheme("dark")
    expect(document.documentElement.getAttribute("data-theme")).toBe("nova")
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark")
    expect(isDark()).toBe(true)
    expect(meta.getAttribute("content")).toBe("#0a0a0a")

    // 3. 纸面 浅色
    useThemeStore.getState().setStyle("paper")
    useThemeStore.getState().setTheme("light")
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper")
    expect(document.documentElement.getAttribute("data-mode")).toBe("light")
    expect(isDark()).toBe(false)
    expect(meta.getAttribute("content")).toBe("#f7f4ee")

    // 4. 纸面 深色
    useThemeStore.getState().setStyle("paper")
    useThemeStore.getState().setTheme("dark")
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper")
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark")
    expect(isDark()).toBe(true)
    expect(meta.getAttribute("content")).toBe("#0b0c0e")
  })

  it("THEME_META_COLORS 与各主题 light/dark 颜色保持单一真源", () => {
    expect(THEME_META_COLORS.nova.light).toBe("#ffffff")
    expect(THEME_META_COLORS.nova.dark).toBe("#0a0a0a")
    expect(THEME_META_COLORS.paper.light).toBe("#f7f4ee")
    expect(THEME_META_COLORS.paper.dark).toBe("#0b0c0e")
  })
})

describe("账号主题同步与一次性迁移 (syncAccountTheme)", () => {
  const baseUser: Me = {
    id: 1,
    email: "test@example.com",
    username: "testuser",
    role: "user",
    approvalStatus: "approved",
    createdAt: "2026-11-25T00:00:00.000Z",
    avatarUrl: null,
    twofa: {
      totpEnabled: false,
      passkeyEnabled: false,
      passkeyCount: 0,
      emailOtpEnabled: false
    }
  }

  beforeEach(() => {
    document.documentElement.className = ""
    document.documentElement.removeAttribute("data-mode")
    document.documentElement.removeAttribute("data-theme")
    localStorage.clear()
    vi.mocked(meApi.updateThemeStyle).mockReset()
    _resetThemeMigratingForTest()
    useAuthStore.setState({ user: null, status: "ready", restricted: false })
  })

  it("首次登录一次性迁移：服务端为默认 nova 且本地镜像为 paper 时，回写服务端一次并更新账号与本地镜像", async () => {
    useThemeStore.setState({ theme: "light", style: "paper" })
    const userWithNova: Me = { ...baseUser, themeStyle: "nova" }
    const updatedUser: Me = { ...baseUser, themeStyle: "paper" }
    vi.mocked(meApi.updateThemeStyle).mockResolvedValue(updatedUser)

    await syncAccountTheme(userWithNova)

    // 调用接口回写服务端 paper
    expect(meApi.updateThemeStyle).toHaveBeenCalledTimes(1)
    expect(meApi.updateThemeStyle).toHaveBeenCalledWith("paper")

    // 更新了 authStore 与 themeStore
    expect(useAuthStore.getState().user?.themeStyle).toBe("paper")
    expect(useThemeStore.getState().style).toBe("paper")
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper")
  })

  it("此后以服务端为准：服务端为 paper 时，不回写服务端，直接应用服务端风格", async () => {
    useThemeStore.setState({ theme: "light", style: "nova" })
    const userWithPaper: Me = { ...baseUser, themeStyle: "paper" }

    await syncAccountTheme(userWithPaper)

    // 不回写
    expect(meApi.updateThemeStyle).not.toHaveBeenCalled()

    // 应用服务端 paper 风格
    expect(useThemeStore.getState().style).toBe("paper")
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper")
  })

  it("服务端为默认 nova 且本地镜像为 nova 时，不回写服务端，保持现状", async () => {
    useThemeStore.setState({ theme: "light", style: "nova" })
    const userWithNova: Me = { ...baseUser, themeStyle: "nova" }

    await syncAccountTheme(userWithNova)

    expect(meApi.updateThemeStyle).not.toHaveBeenCalled()
    expect(useThemeStore.getState().style).toBe("nova")
  })

  it("未登录状态（user 为 null）：直接返回，不报错、不等待、保留本地镜像", async () => {
    useThemeStore.setState({ theme: "light", style: "paper" })

    await syncAccountTheme(null)

    expect(meApi.updateThemeStyle).not.toHaveBeenCalled()
    expect(useThemeStore.getState().style).toBe("paper")
  })

  it("迁移回写失败（网络异常）：降级回退至服务端 nova，不抛出异常", async () => {
    useThemeStore.setState({ theme: "light", style: "paper" })
    const userWithNova: Me = { ...baseUser, themeStyle: "nova" }
    vi.mocked(meApi.updateThemeStyle).mockRejectedValue(
      new Error("Network Error")
    )

    await expect(syncAccountTheme(userWithNova)).resolves.toBeUndefined()

    // 遵循以服务端为准回退到 nova
    expect(useThemeStore.getState().style).toBe("nova")
    expect(document.documentElement.getAttribute("data-theme")).toBe("nova")
  })

  it("并发防重：一次性迁移在进行中时，后续并发调用直接返回，不重复调用接口", async () => {
    useThemeStore.setState({ theme: "light", style: "paper" })
    const userWithNova: Me = { ...baseUser, themeStyle: "nova" }

    let resolveUpdate: (value: Me) => void = () => {}
    const slowPromise = new Promise<Me>((resolve) => {
      resolveUpdate = resolve
    })
    vi.mocked(meApi.updateThemeStyle).mockReturnValue(slowPromise)

    // 第一次调用触发迁移进行中
    const p1 = syncAccountTheme(userWithNova)
    // 第二次并发调用
    const p2 = syncAccountTheme(userWithNova)

    // 解锁
    resolveUpdate({ ...baseUser, themeStyle: "paper" })
    await Promise.all([p1, p2])

    // 只调用了一次接口
    expect(meApi.updateThemeStyle).toHaveBeenCalledTimes(1)
  })
})
