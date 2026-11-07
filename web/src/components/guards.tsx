import { type ReactNode, Suspense, useEffect, useState } from "react"
import { Navigate, Outlet, useLocation } from "react-router"
import { type SetupState, setUnauthorizedHandler, setupApi } from "@/lib/api"
import { watchSystemTheme } from "@/lib/theme"
import { useAuthStore } from "@/stores/auth"
import { useThemeStore } from "@/stores/theme"

export function FullPageLoader({ label = "加载中…" }: { label?: string }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-2 bg-background">
      <p className="font-heading text-lg font-semibold tracking-tight">ciki</p>
      <p className="text-xs text-muted-foreground" role="status">
        {label}
      </p>
    </div>
  )
}

/**
 * 全站根门：先确认 setup 状态（未初始化一律去 /setup，规格 §9.7），
 * 同时加载当前用户、挂上 401 兜底与系统主题监听。
 */
export function RootGate() {
  const location = useLocation()
  const load = useAuthStore((state) => state.load)
  const [setup, setSetup] = useState<SetupState | "error" | null>(null)

  useEffect(() => {
    setUnauthorizedHandler(() => useAuthStore.getState().setUser(null))
    void load()
    const stopTheme = watchSystemTheme(() =>
      useThemeStore.getState().syncSystem()
    )
    setupApi
      .state()
      .then(setSetup)
      .catch(() => setSetup("error"))
    return () => {
      stopTheme()
      setUnauthorizedHandler(null)
    }
  }, [load])

  if (setup === null) return <FullPageLoader />

  if (
    setup !== "error" &&
    !setup.initialized &&
    location.pathname !== "/setup"
  ) {
    return <Navigate to="/setup" replace />
  }

  return (
    <Suspense fallback={<FullPageLoader />}>
      <Outlet />
    </Suspense>
  )
}

/** 需要登录；受限会话（被要求配置 2FA）只能进设置页。 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const user = useAuthStore((state) => state.user)
  const status = useAuthStore((state) => state.status)
  const restricted = useAuthStore((state) => state.restricted)
  const location = useLocation()

  if (status === "loading") return <FullPageLoader />
  if (!user) return <Navigate to="/login" replace />
  if (restricted && !location.pathname.startsWith("/settings")) {
    return <Navigate to="/settings#security" replace />
  }
  return <>{children}</>
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const user = useAuthStore((state) => state.user)
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== "admin") return <Navigate to="/" replace />
  return <>{children}</>
}

export function GuestOnly({ children }: { children: ReactNode }) {
  const user = useAuthStore((state) => state.user)
  const status = useAuthStore((state) => state.status)
  if (status === "loading") return <FullPageLoader />
  if (user) return <Navigate to="/" replace />
  return <>{children}</>
}
