import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import {
  applyTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  type Theme
} from "@/lib/theme"

interface ThemeState {
  theme: Theme
  resolved: "light" | "dark"
  setTheme: (theme: Theme) => void
  /** 系统明暗变化时调用；只有 auto 档需要重算。 */
  syncSystem: () => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: "auto",
      resolved: resolveTheme("auto"),
      setTheme: (theme) => {
        set({ theme, resolved: applyTheme(theme) })
      },
      syncSystem: () => {
        if (get().theme !== "auto") return
        set({ resolved: applyTheme("auto") })
      }
    }),
    {
      name: THEME_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ theme: state.theme }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        state.resolved = applyTheme(state.theme)
      }
    }
  )
)
