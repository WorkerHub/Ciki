import { create } from "zustand"
import { type Me, meApi } from "@/lib/api"

/**
 * 会话与当前用户。受限会话（登录响应里的 needs2faSetup）只能在 2FA 设置里活动，
 * 这个标记只在本标签页有效（刷新后由后端继续拒绝受限会话的其它接口）。
 */
const RESTRICTED_KEY = "ciki-restricted-session"

function readRestricted(): boolean {
  try {
    return sessionStorage.getItem(RESTRICTED_KEY) === "1"
  } catch {
    return false
  }
}

interface AuthState {
  user: Me | null
  /** loading = 还没问过 /api/me，ready = 已有结论（可能未登录）。 */
  status: "loading" | "ready"
  restricted: boolean
  load: () => Promise<Me | null>
  setUser: (user: Me | null) => void
  refreshMe: () => Promise<Me | null>
  setRestricted: (restricted: boolean) => void
  logout: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  status: "loading",
  restricted: readRestricted(),

  load: async () => {
    try {
      const user = await meApi.get()
      set({ user, status: "ready" })
      return user
    } catch {
      set({ user: null, status: "ready" })
      return null
    }
  },

  setUser: (user) => {
    set({ user, status: "ready" })
  },

  refreshMe: async () => {
    try {
      const user = await meApi.get()
      set({ user, status: "ready" })
      return user
    } catch {
      return get().user
    }
  },

  setRestricted: (restricted) => {
    try {
      if (restricted) sessionStorage.setItem(RESTRICTED_KEY, "1")
      else sessionStorage.removeItem(RESTRICTED_KEY)
    } catch {
      /* sessionStorage 不可用时只保留内存态 */
    }
    set({ restricted })
  },

  logout: async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include"
      })
    } catch {
      /* 网络断了也把本地状态清掉，避免卡在登录态 */
    }
    try {
      sessionStorage.removeItem(RESTRICTED_KEY)
    } catch {
      /* ignore */
    }
    set({ user: null, status: "ready", restricted: false })
  }
}))
