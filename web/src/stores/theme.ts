import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import {
  applyTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  DEFAULT_THEME_STYLE,
  type ThemeMode,
  type ThemeStyle
} from "@/lib/theme"

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
