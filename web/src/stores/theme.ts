import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import { type Me, meApi } from "@/lib/api"
import {
  applyTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  DEFAULT_THEME_STYLE,
  type ThemeMode,
  type ThemeStyle
} from "@/lib/theme"
import { useAuthStore } from "@/stores/auth"

export interface ThemeState {
  theme: ThemeMode
  style: ThemeStyle
  resolved: "light" | "dark"
  setTheme: (theme: ThemeMode) => void
  setStyle: (style: ThemeStyle) => void
  /** 系统明暗变化时调用；只有 auto 档需要重算。 */
  syncSystem: () => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: "auto",
      style: DEFAULT_THEME_STYLE,
      resolved: resolveTheme("auto"),
      setTheme: (theme) => {
        const style = get().style
        set({ theme, resolved: applyTheme(theme, style) })
      },
      setStyle: (style) => {
        const theme = get().theme
        set({ style, resolved: applyTheme(theme, style) })
      },
      syncSystem: () => {
        if (get().theme !== "auto") return
        const style = get().style
        set({ resolved: applyTheme("auto", style) })
      }
    }),
    {
      name: THEME_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ theme: state.theme, style: state.style }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        if (!state.style || (state.style !== "nova" && state.style !== "paper"))
          state.style = DEFAULT_THEME_STYLE
        state.resolved = applyTheme(state.theme, state.style)
      }
    }
  )
)

let migrating = false

export function _resetThemeMigratingForTest() {
  migrating = false
}

/**
 * 账号主题同步与一次性迁移（规格 §5/§6）：
 * - 登录态下以服务端返回的 themeStyle 为真源应用风格；
 * - 本地 localStorage ciki-theme 中的 style 字段降级为首屏镜像（由 setStyle 同步维护）；
 * - 上线后首次登录加载时，若服务端 themeStyle 仍为默认 nova 且本地镜像 style 为 paper，
 *   把本地值回写服务端一次；此后一律以服务端为准；
 * - 未登录状态（user 为 null）：保持本地镜像 / 默认 nova，不报错、不等待。
 */
export async function syncAccountTheme(user: Me | null): Promise<void> {
  if (!user || migrating) return
  const serverStyle: ThemeStyle = user.themeStyle === "paper" ? "paper" : "nova"
  const localStyle: ThemeStyle = useThemeStore.getState().style

  // 一次性迁移条件：服务端默认 nova && 本地镜像 paper
  if (serverStyle === "nova" && localStyle === "paper") {
    migrating = true
    try {
      const updated = await meApi.updateThemeStyle("paper")
      useAuthStore.getState().setUser(updated)
      useThemeStore.getState().setStyle("paper")
    } catch {
      // 迁移回写失败（如网络抖动或后端端点未就绪）：保留本地 paper 镜像，允许后续重试，不静默覆盖丢弃偏好
    } finally {
      migrating = false
    }
  } else {
    // 此后一律以服务端为准
    if (localStyle !== serverStyle) {
      useThemeStore.getState().setStyle(serverStyle)
    }
  }
}
