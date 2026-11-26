import fs from "node:fs"
import path from "node:path"
import React from "react"
import { fireEvent, render } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ThemeCycleButton } from "@/components/ThemeToggle"
import type { Me } from "@/lib/api"
import {
  applyTheme,
  isThemeStyle,
  THEME_META_COLORS,
  THEME_STYLES
} from "@/lib/theme"
import { useAuthStore } from "@/stores/auth"
import {
  _resetThemeMigratingForTest,
  migrateThemeStorage,
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

describe("主题三档（亮 / 暗 / 自动）", () => {
  beforeEach(() => {
    document.documentElement.className = ""
    document.documentElement.removeAttribute("data-mode")
    document.documentElement.removeAttribute("data-theme")
    localStorage.clear()
    setSystemDark(false)
    useThemeStore.setState({ mode: "auto", style: "nova", migratedAt: null })
  })

  it("深色档：写 .dark、data-mode 与 color-scheme，并持久化", () => {
    useThemeStore.getState().setMode("dark")
    expect(isDark()).toBe(true)
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark")
    expect(document.documentElement.style.colorScheme).toBe("dark")
    expect(localStorage.getItem("ciki-theme")).toContain('"mode":"dark"')
  })

  it("浅色档：撤掉 .dark，Kumo 的 data-mode 同步为 light", () => {
    useThemeStore.getState().setMode("dark")
    useThemeStore.getState().setMode("light")
    expect(isDark()).toBe(false)
    expect(document.documentElement.getAttribute("data-mode")).toBe("light")
    expect(useThemeStore.getState().resolved).toBe("light")
  })

  it("自动档跟随系统，系统变化时重算", () => {
    setSystemDark(true)
    useThemeStore.getState().setMode("auto")
    expect(isDark()).toBe(true)
    expect(useThemeStore.getState().resolved).toBe("dark")

    setSystemDark(false)
    useThemeStore.getState().syncSystem()
    expect(isDark()).toBe(false)
    expect(useThemeStore.getState().resolved).toBe("light")
  })

  it("自动档下系统切到深色时 syncSystem 会跟随", () => {
    setSystemDark(false)
    useThemeStore.getState().setMode("auto")
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
    useThemeStore.getState().setMode("light")
    expect(document.documentElement.getAttribute("data-theme")).toBe("nova")
    expect(document.documentElement.getAttribute("data-mode")).toBe("light")
    expect(isDark()).toBe(false)
    expect(meta.getAttribute("content")).toBe("#ffffff")

    // 2. Nova 深色
    useThemeStore.getState().setStyle("nova")
    useThemeStore.getState().setMode("dark")
    expect(document.documentElement.getAttribute("data-theme")).toBe("nova")
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark")
    expect(isDark()).toBe(true)
    expect(meta.getAttribute("content")).toBe("#0a0a0a")

    // 3. 纸面 浅色
    useThemeStore.getState().setStyle("paper")
    useThemeStore.getState().setMode("light")
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper")
    expect(document.documentElement.getAttribute("data-mode")).toBe("light")
    expect(isDark()).toBe(false)
    expect(meta.getAttribute("content")).toBe("#f7f4ee")

    // 4. 纸面 深色
    useThemeStore.getState().setStyle("paper")
    useThemeStore.getState().setMode("dark")
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
    expect(THEME_META_COLORS.natural.light).toBe("#faf6f1")
    expect(THEME_META_COLORS.natural.dark).toBe("#191612")
    expect(THEME_META_COLORS.eink.light).toBe("#f5f3ea")
    expect(THEME_META_COLORS.eink.dark).toBe("#171814")
  })

  it("THEME_STYLES 注册表包含全部 4 套风格", () => {
    const ids = THEME_STYLES.map((s) => s.id)
    expect(ids).toEqual(["nova", "paper", "natural", "eink"])
    expect(isThemeStyle("natural")).toBe(true)
    expect(isThemeStyle("eink")).toBe(true)
    expect(isThemeStyle("paper")).toBe(true)
    expect(isThemeStyle("nova")).toBe(true)
    expect(isThemeStyle("invalid")).toBe(false)
  })

  it("applyTheme 直接调用：准确应用自然与墨纸的 data-theme、data-mode 与 meta[theme-color]，非法风格回退 nova", () => {
    const meta = document.querySelector('meta[name="theme-color"]')!

    // 自然 浅色
    applyTheme("light", "natural")
    expect(document.documentElement.getAttribute("data-theme")).toBe("natural")
    expect(document.documentElement.getAttribute("data-mode")).toBe("light")
    expect(isDark()).toBe(false)
    expect(meta.getAttribute("content")).toBe("#faf6f1")

    // 自然 深色
    applyTheme("dark", "natural")
    expect(document.documentElement.getAttribute("data-theme")).toBe("natural")
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark")
    expect(isDark()).toBe(true)
    expect(meta.getAttribute("content")).toBe("#191612")

    // 墨纸 浅色
    applyTheme("light", "eink")
    expect(document.documentElement.getAttribute("data-theme")).toBe("eink")
    expect(document.documentElement.getAttribute("data-mode")).toBe("light")
    expect(isDark()).toBe(false)
    expect(meta.getAttribute("content")).toBe("#f5f3ea")

    // 墨纸 深色
    applyTheme("dark", "eink")
    expect(document.documentElement.getAttribute("data-theme")).toBe("eink")
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark")
    expect(isDark()).toBe(true)
    expect(meta.getAttribute("content")).toBe("#171814")

    // 非法风格安全回退 nova
    applyTheme("light", "unknown-style" as any)
    expect(document.documentElement.getAttribute("data-theme")).toBe("nova")
    expect(meta.getAttribute("content")).toBe("#ffffff")
  })

  it("纸面与 Nova 阅读版式一致：无正文列宽封顶且清理死令牌", () => {
    const cssContent = fs.readFileSync(
      path.resolve(import.meta.dirname, "../index.css"),
      "utf-8"
    )
    expect(cssContent).not.toContain("--wiki-read-max-width")
    expect(cssContent).not.toMatch(
      /\[data-readview-container\]\s*\{[^}]*max-width/
    )
    // 自然与墨纸令牌块齐全
    expect(cssContent).toContain('html[data-theme="natural"]')
    expect(cssContent).toContain('html[data-theme="natural"].dark')
    expect(cssContent).toContain('html[data-theme="eink"]')
    expect(cssContent).toContain('html[data-theme="eink"].dark')
    expect(cssContent).toContain("--r-card: 0px")
    expect(cssContent).toContain("--shadow-card: none")
  })

  it("存储含非法 mode 值时：rehydrate 校验回退 auto，resolved 正常生效且不崩溃", async () => {
    localStorage.setItem(
      "ciki-theme",
      JSON.stringify({
        state: { mode: "invalid-mode", style: "paper" },
        version: 0
      })
    )
    await useThemeStore.persist.rehydrate()
    expect(useThemeStore.getState().mode).toBe("auto")
    expect(useThemeStore.getState().style).toBe("paper")
    expect(useThemeStore.getState().resolved).toBe("light")
  })

  it("存储含非法 style 值时：rehydrate 校验回退 nova，resolved 正常生效且不崩溃", async () => {
    localStorage.setItem(
      "ciki-theme",
      JSON.stringify({
        state: { mode: "dark", style: "invalid-style" },
        version: 0
      })
    )
    await useThemeStore.persist.rehydrate()
    expect(useThemeStore.getState().mode).toBe("dark")
    expect(useThemeStore.getState().style).toBe("nova")
    expect(useThemeStore.getState().resolved).toBe("dark")
  })

  it("字段互换畸形值（mode=paper, style=light）：rehydrate 分别回退 auto 与 nova，不崩且 DOM 属性正确", async () => {
    localStorage.setItem(
      "ciki-theme",
      JSON.stringify({
        state: { mode: "paper", style: "light" },
        version: 0
      })
    )
    await useThemeStore.persist.rehydrate()
    expect(useThemeStore.getState().mode).toBe("auto")
    expect(useThemeStore.getState().style).toBe("nova")
    expect(document.documentElement.getAttribute("data-theme")).toBe("nova")
    expect(isDark()).toBe(false)
  })

  it("完全非法畸形值（mode=123, style=null 等）：rehydrate 均回退为默认 auto 与 nova", async () => {
    localStorage.setItem(
      "ciki-theme",
      JSON.stringify({
        state: { mode: 123, style: null },
        version: 0
      })
    )
    await useThemeStore.persist.rehydrate()
    expect(useThemeStore.getState().mode).toBe("auto")
    expect(useThemeStore.getState().style).toBe("nova")
    expect(useThemeStore.getState().resolved).toBe("light")
  })

  it("合法 mode 与 style 值：rehydrate 正常还原且不被重置", async () => {
    localStorage.setItem(
      "ciki-theme",
      JSON.stringify({
        state: { mode: "dark", style: "paper" },
        version: 0
      })
    )
    await useThemeStore.persist.rehydrate()
    expect(useThemeStore.getState().mode).toBe("dark")
    expect(useThemeStore.getState().style).toBe("paper")
    expect(useThemeStore.getState().resolved).toBe("dark")
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper")
    expect(isDark()).toBe(true)
  })

  it("setMode 传入非法值防御：归一为 auto", () => {
    useThemeStore.getState().setMode("paper" as any)
    expect(useThemeStore.getState().mode).toBe("auto")
  })

  it("setStyle 传入非法值防御：归一为 nova", () => {
    useThemeStore.getState().setStyle("light" as any)
    expect(useThemeStore.getState().style).toBe("nova")
  })

  it("ThemeCycleButton 防御：当 store 中 mode 为非法值时安全渲染并回退 Monitor 图标，点击可循环切换", () => {
    useThemeStore.setState({ mode: "paper" as any })
    let container: HTMLElement
    expect(() => {
      const rendered = render(React.createElement(ThemeCycleButton))
      container = rendered.container
    }).not.toThrow()
    const button = container!.querySelector("button")
    expect(button).toBeTruthy()
    fireEvent.click(button!)
    expect(useThemeStore.getState().mode).toBe("light")
  })
})

describe("纸面主题按钮覆盖层与令牌契约", () => {
  it("纸面覆盖层包含 default、secondary、outline 与 focus-visible 的完整规则", () => {
    const cssPath = path.resolve(import.meta.dirname, "../index.css")
    const css = fs.readFileSync(cssPath, "utf-8")

    // default variant 边框与阴影
    expect(css).toMatch(
      /html\[data-theme="paper"\]\s+\[data-slot="button"\]\[data-variant="default"\][\s\S]*?border-color:\s*var\(--coral\)/
    )
    expect(css).toMatch(
      /html\[data-theme="paper"\]\s+\[data-slot="button"\]\[data-variant="default"\][\s\S]*?box-shadow:\s*var\(--shadow-coral\)/
    )
    // default variant 悬停与激活态实色 deep
    expect(css).toMatch(
      /html\[data-theme="paper"\]\s+\[data-slot="button"\]\[data-variant="default"\]:hover[\s\S]*?background-color:\s*var\(--coral-deep\)/
    )
    expect(css).toMatch(
      /html\[data-theme="paper"\]\s+\[data-slot="button"\]\[data-variant="default"\]:hover[\s\S]*?border-color:\s*var\(--coral-deep\)/
    )
    // secondary variant 消除透底白边
    expect(css).toMatch(
      /html\[data-theme="paper"\]\s+\[data-slot="button"\]\[data-variant="secondary"\][\s\S]*?border-color:\s*var\(--secondary\)/
    )
    // secondary variant 悬停与激活态边框和填充同步
    expect(css).toMatch(
      /html\[data-theme="paper"\]\s+\[data-slot="button"\]\[data-variant="secondary"\]:hover[\s\S]*?background-color:\s*color-mix\(in oklch,\s*var\(--secondary\),\s*var\(--foreground\)\s*5%\)/
    )
    expect(css).toMatch(
      /html\[data-theme="paper"\]\s+\[data-slot="button"\]\[data-variant="secondary"\]:hover[\s\S]*?border-color:\s*color-mix\(in oklch,\s*var\(--secondary\),\s*var\(--foreground\)\s*5%\)/
    )
    // outline variant 保持 box-shadow: var(--shadow-ctl)
    expect(css).toMatch(
      /html\[data-theme="paper"\]\s+\[data-slot="button"\]\[data-variant="outline"\][\s\S]*?box-shadow:\s*var\(--shadow-ctl\)/
    )
    // focus-visible 焦点环守护限定到 default 与 secondary
    expect(css).toMatch(
      /html\[data-theme="paper"\]\s+\[data-slot="button"\]\[data-variant="default"\]:focus-visible[\s\S]*?border-color:\s*var\(--ring\)/
    )
    expect(css).toMatch(
      /html\[data-theme="paper"\]\s+\[data-slot="button"\]\[data-variant="secondary"\]:focus-visible[\s\S]*?border-color:\s*var\(--ring\)/
    )
  })

  it("纸面浅色与暗色珊瑚令牌完整落定单一真源", () => {
    const cssPath = path.resolve(import.meta.dirname, "../index.css")
    const css = fs.readFileSync(cssPath, "utf-8")

    expect(css).toContain("--coral: #e2705a;")
    expect(css).toContain("--coral-deep: #d6624b;")
    expect(css).toContain("--coral: #e8694e;")
    expect(css).toContain("--coral-deep: #f07a5f;")
  })
})

describe("账号主题同步与一次性迁移 (syncAccountTheme)", () => {
  beforeEach(() => {
    document.documentElement.className = ""
    document.documentElement.removeAttribute("data-mode")
    document.documentElement.removeAttribute("data-theme")
    localStorage.clear()
    vi.mocked(meApi.updateThemeStyle).mockReset()
    _resetThemeMigratingForTest()
    useThemeStore.setState({ mode: "auto", style: "nova", migratedAt: null })
    useAuthStore.setState({ user: null, status: "ready", restricted: false })
  })

  it("首次登录一次性迁移：服务端为默认 nova 且本地镜像为 paper 时，回写服务端一次并更新账号与本地镜像", async () => {
    useThemeStore.setState({ mode: "light", style: "paper", migratedAt: null })
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
    expect(useThemeStore.getState().migratedAt).toBeTruthy()
    expect(localStorage.getItem("ciki-theme")).toContain('"migratedAt":')
  })

  it("项4 场景：本地 paper + 服务端 nova 首次登录仍回写一次，且回写成功后落标记并在下次刷新不再回写", async () => {
    // 升级前老用户：本地为 paper，无 migratedAt 持久化标记
    useThemeStore.setState({ mode: "light", style: "paper", migratedAt: null })
    const userWithNova: Me = { ...baseUser, themeStyle: "nova" }
    const updatedUser: Me = { ...baseUser, themeStyle: "paper" }
    vi.mocked(meApi.updateThemeStyle).mockResolvedValue(updatedUser)

    // 首次登录触发同步：应回写服务端一次
    await syncAccountTheme(userWithNova)
    expect(meApi.updateThemeStyle).toHaveBeenCalledTimes(1)
    expect(meApi.updateThemeStyle).toHaveBeenCalledWith("paper")
    expect(useThemeStore.getState().style).toBe("paper")
    expect(useThemeStore.getState().migratedAt).toBeTruthy()

    // 模拟刷新：此时已有 migratedAt 标记，即使服务端假定为 nova（如他人改回），刷新也不再触发回写
    vi.mocked(meApi.updateThemeStyle).mockClear()
    useThemeStore.setState({ style: "paper" })
    await syncAccountTheme(userWithNova)
    expect(meApi.updateThemeStyle).not.toHaveBeenCalled()
    expect(useThemeStore.getState().style).toBe("nova")
  })

  it("项2 场景：他人改 nova 后本地 paper 设备刷新不再回写，直接以服务端 nova 为准", async () => {
    // 设备已完成过迁移（已落 migratedAt 标记），本地镜像为 paper
    useThemeStore.setState({
      mode: "light",
      style: "paper",
      migratedAt: 1732500000000
    })
    // 他人在另一台设备上把账号风格改回了 nova
    const userWithNova: Me = { ...baseUser, themeStyle: "nova" }

    // 当前设备刷新触发同步
    await syncAccountTheme(userWithNova)

    // 严禁回写 paper 到服务端
    expect(meApi.updateThemeStyle).not.toHaveBeenCalled()
    // 本地镜像直接以服务端 nova 为准应用
    expect(useThemeStore.getState().style).toBe("nova")
    expect(document.documentElement.getAttribute("data-theme")).toBe("nova")
    // 持久化标记保持存在
    expect(useThemeStore.getState().migratedAt).toBe(1732500000000)
  })

  it("设置页保存成功后落持久化标记，此后即使本地为 paper 服务端为 nova 也跳过迁移以服务端为准", async () => {
    useThemeStore.setState({ mode: "light", style: "nova", migratedAt: null })
    // 模拟设置页保存成功落标记
    useThemeStore.getState().markMigrated(1732501111111)
    expect(useThemeStore.getState().migratedAt).toBe(1732501111111)

    // 假设本地之后因某种原因镜像为 paper，但已有标记
    useThemeStore.setState({ style: "paper" })
    const userWithNova: Me = { ...baseUser, themeStyle: "nova" }

    await syncAccountTheme(userWithNova)

    expect(meApi.updateThemeStyle).not.toHaveBeenCalled()
    expect(useThemeStore.getState().style).toBe("nova")
  })

  it("此后以服务端为准：服务端为 paper 时，不回写服务端，直接应用服务端风格", async () => {
    useThemeStore.setState({ mode: "light", style: "nova" })
    const userWithPaper: Me = { ...baseUser, themeStyle: "paper" }

    await syncAccountTheme(userWithPaper)

    // 不回写
    expect(meApi.updateThemeStyle).not.toHaveBeenCalled()

    // 应用服务端 paper 风格
    expect(useThemeStore.getState().style).toBe("paper")
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper")
  })

  it("服务端为默认 nova 且本地镜像为 nova 时，不回写服务端，保持现状", async () => {
    useThemeStore.setState({ mode: "light", style: "nova" })
    const userWithNova: Me = { ...baseUser, themeStyle: "nova" }

    await syncAccountTheme(userWithNova)

    expect(meApi.updateThemeStyle).not.toHaveBeenCalled()
    expect(useThemeStore.getState().style).toBe("nova")
  })

  it("未登录状态（user 为 null）：直接返回，不报错、不等待、保留本地镜像", async () => {
    useThemeStore.setState({ mode: "light", style: "paper" })

    await syncAccountTheme(null)

    expect(meApi.updateThemeStyle).not.toHaveBeenCalled()
    expect(useThemeStore.getState().style).toBe("paper")
  })

  it("迁移回写失败（网络异常）：保留本地 paper 镜像并在后续重试成功", async () => {
    useThemeStore.getState().setStyle("paper")
    const userWithNova: Me = { ...baseUser, themeStyle: "nova" }
    vi.mocked(meApi.updateThemeStyle).mockRejectedValueOnce(
      new Error("Network Error")
    )

    // 首次失败：不抛出异常，保留本地 paper 镜像，不落标记
    await expect(syncAccountTheme(userWithNova)).resolves.toBeUndefined()
    expect(useThemeStore.getState().style).toBe("paper")
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper")
    expect(useThemeStore.getState().migratedAt).toBeNull()

    // 下次调用重试：成功回写并更新，并落标记
    const updatedUser: Me = { ...baseUser, themeStyle: "paper" }
    vi.mocked(meApi.updateThemeStyle).mockResolvedValueOnce(updatedUser)

    await syncAccountTheme(userWithNova)
    expect(meApi.updateThemeStyle).toHaveBeenCalledTimes(2)
    expect(useAuthStore.getState().user?.themeStyle).toBe("paper")
    expect(useThemeStore.getState().style).toBe("paper")
    expect(useThemeStore.getState().migratedAt).toBeTruthy()
  })

  it("并发防重：一次性迁移在进行中时，后续并发调用直接返回，不重复调用接口", async () => {
    useThemeStore.setState({ mode: "light", style: "paper" })
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

describe("持久化数据迁移 (migrateThemeStorage) 三类输入覆盖", () => {
  const fixedTime = 1732509999999

  it("旧结构三种 mode 取值：auto、light、dark 准确搬迁到 mode，写迁移标记并置 migrated: true", () => {
    // 1. theme: auto
    const resAuto = migrateThemeStorage(
      JSON.stringify({
        state: { theme: "auto", style: "nova" },
        version: 0
      }),
      fixedTime
    )
    expect(resAuto.migrated).toBe(true)
    expect(resAuto.state.mode).toBe("auto")
    expect(resAuto.state.style).toBe("nova")
    expect(resAuto.state.migratedAt).toBeNull()
    expect(resAuto.state.modeMigratedAt).toBe(fixedTime)

    // 2. theme: light
    const resLight = migrateThemeStorage(
      JSON.stringify({
        state: { theme: "light", style: "paper" },
        version: 0
      }),
      fixedTime
    )
    expect(resLight.migrated).toBe(true)
    expect(resLight.state.mode).toBe("light")
    expect(resLight.state.style).toBe("paper")
    expect(resLight.state.migratedAt).toBeNull()
    expect(resLight.state.modeMigratedAt).toBe(fixedTime)

    // 3. theme: dark
    const resDark = migrateThemeStorage(
      JSON.stringify({
        state: { theme: "dark", style: "paper" },
        version: 0
      }),
      fixedTime
    )
    expect(resDark.migrated).toBe(true)
    expect(resDark.state.mode).toBe("dark")
    expect(resDark.state.style).toBe("paper")
    expect(resDark.state.migratedAt).toBeNull()
    expect(resDark.state.modeMigratedAt).toBe(fixedTime)

    // 4. 兼容非 state 包装的旧对象与非法值回退 auto
    const resRaw = migrateThemeStorage({ theme: "invalid" }, fixedTime)
    expect(resRaw.migrated).toBe(true)
    expect(resRaw.state.mode).toBe("auto")
    expect(resRaw.state.migratedAt).toBeNull()
    expect(resRaw.state.modeMigratedAt).toBe(fixedTime)

    // 5. 兼容裸字符串
    const resString = migrateThemeStorage("dark", fixedTime)
    expect(resString.migrated).toBe(true)
    expect(resString.state.mode).toBe("dark")
    expect(resString.state.migratedAt).toBeNull()
    expect(resString.state.modeMigratedAt).toBe(fixedTime)

    // 6. 若旧结构已有账号风格迁移标记 migratedAt，迁移 mode 时完整保留其数值
    const resWithAccountMigrated = migrateThemeStorage(
      JSON.stringify({
        state: { theme: "dark", style: "paper", migratedAt: 1732500000000 },
        version: 0
      }),
      fixedTime
    )
    expect(resWithAccountMigrated.migrated).toBe(true)
    expect(resWithAccountMigrated.state.mode).toBe("dark")
    expect(resWithAccountMigrated.state.migratedAt).toBe(1732500000000)
    expect(resWithAccountMigrated.state.modeMigratedAt).toBe(fixedTime)
  })

  it("无旧字段：不搬运，mode 回退 auto，migrated 为 false 且不覆盖原有标记", () => {
    // 仅有 style
    const resOnlyStyle = migrateThemeStorage(
      JSON.stringify({
        state: { style: "paper" },
        version: 0
      }),
      fixedTime
    )
    expect(resOnlyStyle.migrated).toBe(false)
    expect(resOnlyStyle.state.mode).toBe("auto")
    expect(resOnlyStyle.state.style).toBe("paper")
    expect(resOnlyStyle.state.migratedAt).toBeNull()
    expect(resOnlyStyle.state.modeMigratedAt).toBeNull()

    // 空结构
    const resEmpty = migrateThemeStorage({}, fixedTime)
    expect(resEmpty.migrated).toBe(false)
    expect(resEmpty.state.mode).toBe("auto")
    expect(resEmpty.state.style).toBe("nova")
    expect(resEmpty.state.migratedAt).toBeNull()
    expect(resEmpty.state.modeMigratedAt).toBeNull()

    // null / 异常输入
    const resNull = migrateThemeStorage(null, fixedTime)
    expect(resNull.migrated).toBe(false)
    expect(resNull.state.mode).toBe("auto")
    expect(resNull.state.migratedAt).toBeNull()
    expect(resNull.state.modeMigratedAt).toBeNull()
  })

  it("已迁移结构：保持现有 mode 与 style，保留原有 migratedAt，migrated 为 false", () => {
    const resMigrated = migrateThemeStorage(
      JSON.stringify({
        state: {
          mode: "dark",
          style: "paper",
          migratedAt: 1732500000000
        },
        version: 0
      }),
      fixedTime
    )
    expect(resMigrated.migrated).toBe(false)
    expect(resMigrated.state.mode).toBe("dark")
    expect(resMigrated.state.style).toBe("paper")
    expect(resMigrated.state.migratedAt).toBe(1732500000000)
    expect(resMigrated.state.modeMigratedAt).toBeNull()
  })
})

describe("localStorage 水合迁移与回写（Jim 验收项 1）", () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.className = ""
    document.documentElement.removeAttribute("data-mode")
    document.documentElement.removeAttribute("data-theme")
    useThemeStore.setState({ mode: "auto", style: "nova", migratedAt: null })
  })

  it("带旧版 localStorage（旧字段结构）的浏览器打开站点，明暗模式与风格与升级前一致，且刷新后结构已迁新", async () => {
    // 1. 模拟旧版客户端存储
    localStorage.setItem(
      "ciki-theme",
      JSON.stringify({
        state: { theme: "dark", style: "paper" },
        version: 0
      })
    )

    // 2. 模拟应用启动水合
    await useThemeStore.persist.rehydrate()

    // 验证状态正确迁移、设置不丢失
    expect(useThemeStore.getState().mode).toBe("dark")
    expect(useThemeStore.getState().style).toBe("paper")
    expect(useThemeStore.getState().resolved).toBe("dark")
    expect(useThemeStore.getState().modeMigratedAt).toBeTruthy()
    expect(useThemeStore.getState().migratedAt).toBeNull()
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper")
    expect(document.documentElement.classList.contains("dark")).toBe(true)

    // 验证 localStorage 已一次性回写为新结构，且旧 theme 字段已被清除
    const updatedStorage = localStorage.getItem("ciki-theme")
    expect(updatedStorage).toBeTruthy()
    expect(updatedStorage).toContain('"mode":"dark"')
    expect(updatedStorage).toContain('"style":"paper"')
    expect(updatedStorage).toContain('"modeMigratedAt":')
    expect(updatedStorage).toContain('"migratedAt":null')
    expect(updatedStorage).not.toContain('"theme":')

    // 3. 模拟用户刷新页面（再次触发水合）
    await useThemeStore.persist.rehydrate()
    expect(useThemeStore.getState().mode).toBe("dark")
    expect(useThemeStore.getState().style).toBe("paper")
    expect(localStorage.getItem("ciki-theme")).not.toContain('"theme":')
  })

  it("旧结构未同步过账号风格（本地 paper + 无 migratedAt）：水合进行 mode 迁移后，migratedAt 保持为 null，syncAccountTheme 正常触发回写服务端并更新账号与本地标记", async () => {
    // 用户本地之前选了 paper，明暗为 dark，且从未同步过账号风格（migratedAt 缺失或为 null）
    localStorage.setItem(
      "ciki-theme",
      JSON.stringify({
        state: { theme: "dark", style: "paper" },
        version: 0
      })
    )

    // 1. 水合触发 mode 迁移
    await useThemeStore.persist.rehydrate()
    expect(useThemeStore.getState().mode).toBe("dark")
    expect(useThemeStore.getState().style).toBe("paper")
    // 核心断言：modeMigratedAt 已标记，但账号风格的 migratedAt 仍为 null，未被污染
    expect(useThemeStore.getState().modeMigratedAt).toBeTruthy()
    expect(useThemeStore.getState().migratedAt).toBeNull()

    // 2. 用户登录，服务端返回默认 nova 风格
    const userWithNova: Me = { ...baseUser, themeStyle: "nova" }
    const updatedUser: Me = { ...baseUser, themeStyle: "paper" }
    vi.mocked(meApi.updateThemeStyle).mockResolvedValue(updatedUser)

    // 3. 执行账号主题同步
    await syncAccountTheme(userWithNova)

    // 必须正常触发回写，绝不被误判为已迁移而丢失 paper 偏好
    expect(meApi.updateThemeStyle).toHaveBeenCalledTimes(1)
    expect(meApi.updateThemeStyle).toHaveBeenCalledWith("paper")
    expect(useAuthStore.getState().user?.themeStyle).toBe("paper")
    expect(useThemeStore.getState().style).toBe("paper")
    expect(useThemeStore.getState().migratedAt).toBeTruthy()
  })
})

describe("index.html 首屏内联脚本执行（新旧结构均不出错）", () => {
  const runInlineScript = () => {
    const root = document.documentElement
    const meta = document.querySelector('meta[name="theme-color"]')
    let mode = "auto"
    let style = "nova"
    try {
      const stored = localStorage.getItem("ciki-theme")
      if (stored) {
        try {
          const parsed = JSON.parse(stored)
          mode = parsed?.state?.mode ?? parsed?.state?.theme ?? parsed
          style = parsed?.state?.style ?? "nova"
        } catch {
          mode = stored
        }
      }
    } catch {}
    if (mode !== "light" && mode !== "dark") mode = "auto"
    const validStyles = ["nova", "paper", "natural", "eink"]
    if (!validStyles.includes(style)) style = "nova"
    const dark =
      mode === "dark" ||
      (mode === "auto" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches)
    root.setAttribute("data-theme", style)
    root.classList.toggle("dark", dark)
    root.setAttribute("data-mode", dark ? "dark" : "light")
    root.style.colorScheme = dark ? "dark" : "light"
    if (meta) {
      const themeColors = (
        window as unknown as {
          __THEME_META_COLORS__?: Record<
            string,
            { light: string; dark: string }
          >
        }
      ).__THEME_META_COLORS__?.[style] || {
        light: "#ffffff",
        dark: "#0a0a0a"
      }
      meta.setAttribute("content", dark ? themeColors.dark : themeColors.light)
    }
  }

  beforeEach(() => {
    localStorage.clear()
    document.documentElement.className = ""
    document.documentElement.removeAttribute("data-mode")
    document.documentElement.removeAttribute("data-theme")
    setSystemDark(false)
  })

  it("旧结构 theme=dark, style=paper：首屏脚本安全解析，无报错且准确应用属性", () => {
    localStorage.setItem(
      "ciki-theme",
      JSON.stringify({
        state: { theme: "dark", style: "paper" },
        version: 0
      })
    )
    expect(() => runInlineScript()).not.toThrow()
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark")
  })

  it("新结构 mode=light, style=paper：首屏脚本安全解析，无报错且准确应用属性", () => {
    localStorage.setItem(
      "ciki-theme",
      JSON.stringify({
        state: { mode: "light", style: "paper", migratedAt: 1732500000000 },
        version: 0
      })
    )
    expect(() => runInlineScript()).not.toThrow()
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(document.documentElement.getAttribute("data-mode")).toBe("light")
  })

  it("未存储或损坏 JSON：首屏脚本安全回退 auto / nova，无异常抛出", () => {
    localStorage.setItem("ciki-theme", "{broken-json")
    expect(() => runInlineScript()).not.toThrow()
    expect(document.documentElement.getAttribute("data-theme")).toBe("nova")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(document.documentElement.getAttribute("data-mode")).toBe("light")
  })

  it("新结构 style=natural：首屏脚本安全解析，准确应用 natural", () => {
    localStorage.setItem(
      "ciki-theme",
      JSON.stringify({
        state: { mode: "dark", style: "natural" },
        version: 0
      })
    )
    expect(() => runInlineScript()).not.toThrow()
    expect(document.documentElement.getAttribute("data-theme")).toBe("natural")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  it("新结构 style=eink：首屏脚本安全解析，准确应用 eink", () => {
    localStorage.setItem(
      "ciki-theme",
      JSON.stringify({
        state: { mode: "light", style: "eink" },
        version: 0
      })
    )
    expect(() => runInlineScript()).not.toThrow()
    expect(document.documentElement.getAttribute("data-theme")).toBe("eink")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })
})
