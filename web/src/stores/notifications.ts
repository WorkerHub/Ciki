import { useEffect } from "react"
import { create } from "zustand"
import { notificationsApi } from "@/lib/api"

interface NotificationsState {
  unreadCount: number
  loading: boolean
  fetchUnreadCount: () => Promise<number>
  setUnreadCount: (count: number) => void
  decrementUnreadCount: (amount?: number) => void
  markAllRead: () => Promise<void>
  markRead: (id: number) => Promise<void>
}

export const useNotificationStore = create<NotificationsState>((set, get) => ({
  unreadCount: 0,
  loading: false,

  fetchUnreadCount: async () => {
    try {
      set({ loading: true })
      const { count } = await notificationsApi.unreadCount()
      const safeCount = Math.max(0, count)
      set({ unreadCount: safeCount, loading: false })
      return safeCount
    } catch {
      set({ loading: false })
      return get().unreadCount
    }
  },

  setUnreadCount: (count: number) => {
    set({ unreadCount: Math.max(0, count) })
  },

  decrementUnreadCount: (amount = 1) => {
    set((state) => ({ unreadCount: Math.max(0, state.unreadCount - amount) }))
  },

  markAllRead: async () => {
    await notificationsApi.markAllRead()
    set({ unreadCount: 0 })
  },

  markRead: async (id: number) => {
    await notificationsApi.markRead(id)
    get().decrementUnreadCount(1)
  }
}))

/**
 * 角标刷新策略：
 * - 登录后拉一次
 * - 窗口重新聚焦时拉
 * - 页面可见时每 60 秒轮询 unread-count（隐藏时暂停）
 */
export function useNotificationPolling(enabled: boolean = true) {
  const fetchUnreadCount = useNotificationStore(
    (state) => state.fetchUnreadCount
  )

  useEffect(() => {
    if (!enabled) return

    // 1. 登录后拉一次
    void fetchUnreadCount()

    // 2. 窗口重新聚焦时拉
    const handleFocus = () => {
      void fetchUnreadCount()
    }

    // 3. 页面可见时拉
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchUnreadCount()
      }
    }

    window.addEventListener("focus", handleFocus)
    document.addEventListener("visibilitychange", handleVisibilityChange)

    // 4. 页面可见时每 60 秒轮询 unread-count（隐藏时暂停）
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        void fetchUnreadCount()
      }
    }, 60_000)

    return () => {
      window.removeEventListener("focus", handleFocus)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      clearInterval(interval)
    }
  }, [enabled, fetchUnreadCount])
}
