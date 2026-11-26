import { create } from "zustand"
import { persist, type StorageValue } from "zustand/middleware"
import { type Me, meApi } from "@/lib/api"
import {
  applyTheme,
  DEFAULT_THEME_STYLE,
  isThemeStyle,
  resolveMode,
  THEME_STORAGE_KEY,
  type ThemeMode,
  type ThemeStyle
} from "@/lib/theme"
import { useAuthStore } from "@/stores/auth"

export interface ThemeState {
  mode: ThemeMode
  style: ThemeStyle
  resolved: "light" | "dark"
  migratedAt: number | null
  modeMigratedAt: number | null
  setMode: (mode: ThemeMode) => void
  setStyle: (style: ThemeStyle) => void
  markMigrated: (timestamp?: number) => void
  /** 系统明暗变化时调用；只有 auto 档需要重算。 */
  syncSystem: () => void
}

export interface PersistedThemeState {
  mode: ThemeMode
  style: ThemeStyle
  migratedAt: number | null
  modeMigratedAt: number | null
}

export interface ThemeMigrationResult {
  migrated: boolean
  state: PersistedThemeState
}

/**
 * 持久化数据迁移：
 * 将旧结构中的 `theme`（明暗模式）搬移到 `mode` 字段，并落迁移时间戳标记。
 * 支持三类输入：
 * 1. 旧结构三种 mode 取值（auto / light / dark / 非法值回退 auto） -> migrated: true
 * 2. 无旧字段（仅 style 或空结构） -> mode 默认 auto，migrated: false
 * 3. 已迁移结构（已有 mode 字段） -> 保持现状，migrated: false
 */
export function migrateThemeStorage(
  raw: unknown,
  now: number = Date.now()
): ThemeMigrationResult {
  let parsed: unknown = raw
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = raw
    }
  }

  // 兼容裸字符串输入（"light" | "dark" | "auto"）
  if (typeof parsed === "string") {
    const mode: ThemeMode =
      parsed === "light" || parsed === "dark" ? parsed : "auto"
    return {
      migrated: true,
      state: {
        mode,
        style: DEFAULT_THEME_STYLE,
        migratedAt: null,
        modeMigratedAt: now
      }
    }
  }

  const container = (
    parsed && typeof parsed === "object" ? parsed : {}
  ) as Record<string, unknown>
  const stateObj = (
    container.state && typeof container.state === "object"
      ? container.state
      : container
  ) as Record<string, unknown>

  const hasLegacyTheme = "theme" in stateObj
  const hasMode = "mode" in stateObj

  // 类 3: 已迁移结构
  if (hasMode) {
    const rawMode = stateObj.mode
    const mode: ThemeMode =
      rawMode === "light" || rawMode === "dark" ? rawMode : "auto"
    const style: ThemeStyle = isThemeStyle(stateObj.style)
      ? stateObj.style
      : DEFAULT_THEME_STYLE
    const migratedAt =
      typeof stateObj.migratedAt === "number" ? stateObj.migratedAt : null
    const modeMigratedAt =
      typeof stateObj.modeMigratedAt === "number"
        ? stateObj.modeMigratedAt
        : null
    return {
      migrated: false,
      state: {
        mode,
        style,
        migratedAt,
        modeMigratedAt
      }
    }
  }

  // 类 1: 旧结构（含 theme 字段）
  if (hasLegacyTheme) {
    const rawTheme = stateObj.theme
    const mode: ThemeMode =
      rawTheme === "light" || rawTheme === "dark" ? rawTheme : "auto"
    const style: ThemeStyle = isThemeStyle(stateObj.style)
      ? stateObj.style
      : DEFAULT_THEME_STYLE
    // 严格保留既有账号风格迁移标记 migratedAt（若原为 null 则保持 null，严禁破坏 syncAccountTheme）
    const migratedAt =
      typeof stateObj.migratedAt === "number" ? stateObj.migratedAt : null
    return {
      migrated: true,
      state: {
        mode,
        style,
        migratedAt,
        modeMigratedAt: now
      }
    }
  }

  // 类 2: 无旧字段（未设置过明暗，或无 theme 也无 mode）
  const style: ThemeStyle = isThemeStyle(stateObj.style)
    ? stateObj.style
    : DEFAULT_THEME_STYLE
  const migratedAt =
    typeof stateObj.migratedAt === "number" ? stateObj.migratedAt : null
  const modeMigratedAt =
    typeof stateObj.modeMigratedAt === "number" ? stateObj.modeMigratedAt : null
  return {
    migrated: false,
    state: {
      mode: "auto",
      style,
      migratedAt,
      modeMigratedAt
    }
  }
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: "auto",
      style: DEFAULT_THEME_STYLE,
      resolved: resolveMode("auto"),
      migratedAt: null,
      modeMigratedAt: null,
      setMode: (mode) => {
        const safeMode: ThemeMode =
          mode === "light" || mode === "dark" ? mode : "auto"
        const style = get().style
        set({ mode: safeMode, resolved: applyTheme(safeMode, style) })
      },
      setStyle: (style) => {
        const safeStyle: ThemeStyle = isThemeStyle(style)
          ? style
          : DEFAULT_THEME_STYLE
        const mode = get().mode
        set({ style: safeStyle, resolved: applyTheme(mode, safeStyle) })
      },
      markMigrated: (timestamp = Date.now()) => {
        set({ migratedAt: timestamp })
      },
      syncSystem: () => {
        if (get().mode !== "auto") return
        const style = get().style
        set({ resolved: applyTheme("auto", style) })
      }
    }),
    {
      name: THEME_STORAGE_KEY,
      storage: {
        getItem: (name: string): StorageValue<PersistedThemeState> | null => {
          if (typeof window === "undefined" || !window.localStorage) return null
          try {
            const raw = localStorage.getItem(name)
            if (!raw) return null
            const migration = migrateThemeStorage(raw)
            if (migration.migrated) {
              try {
                localStorage.setItem(
                  name,
                  JSON.stringify({
                    state: migration.state,
                    version: 0
                  })
                )
              } catch {}
            }
            return {
              state: migration.state,
              version: 0
            }
          } catch {
            return null
          }
        },
        setItem: (name: string, value: StorageValue<PersistedThemeState>) => {
          if (typeof window === "undefined" || !window.localStorage) return
          try {
            localStorage.setItem(name, JSON.stringify(value))
          } catch {}
        },
        removeItem: (name: string) => {
          if (typeof window === "undefined" || !window.localStorage) return
          try {
            localStorage.removeItem(name)
          } catch {}
        }
      },
      partialize: (state) => ({
        mode: state.mode,
        style: state.style,
        migratedAt: state.migratedAt,
        modeMigratedAt: state.modeMigratedAt
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        if (state.mode !== "light" && state.mode !== "dark") {
          state.mode = "auto"
        }
        if (!state.style || !isThemeStyle(state.style))
          state.style = DEFAULT_THEME_STYLE
        if (state.migratedAt === undefined) state.migratedAt = null
        if (state.modeMigratedAt === undefined) state.modeMigratedAt = null
        state.resolved = applyTheme(state.mode, state.style)
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
  const serverStyle: ThemeStyle = isThemeStyle(user.themeStyle)
    ? user.themeStyle
    : DEFAULT_THEME_STYLE
  const themeStore = useThemeStore.getState()
  const localStyle: ThemeStyle = themeStore.style
  const hasMigrated = Boolean(themeStore.migratedAt)

  // 一次性迁移条件：未曾同步过 && 服务端默认 nova && 本地镜像 paper
  if (!hasMigrated && serverStyle === "nova" && localStyle === "paper") {
    migrating = true
    try {
      const updated = await meApi.updateThemeStyle("paper")
      useAuthStore.getState().setUser(updated)
      useThemeStore.getState().setStyle("paper")
      useThemeStore.getState().markMigrated()
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
