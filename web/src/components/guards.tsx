import { type ReactNode, Suspense, useEffect } from "react"
import { Navigate, Outlet, useLocation } from "react-router"
import { setUnauthorizedHandler } from "@/lib/api"
import { watchSystemTheme } from "@/lib/theme"
import { useAuthStore } from "@/stores/auth"
import { useSetupGateStore } from "@/stores/setup"
import { useSiteStore } from "@/stores/site"
import { useThemeStore } from "@/stores/theme"

export function FullPageLoader({ label = "加载中…" }: { label?: string }) {
  const siteName = useSiteStore((state) => state.name)
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-2 bg-background">
      <p className="font-heading text-lg font-semibold tracking-tight">
        {siteName}
      </p>
      <p className="text-xs text-muted-foreground" role="status">
        {label}
      </p>
    </div>
  )
}

/**
 * 全站根门：先确认 setup 状态（未初始化一律去 /setup，规格 §9.7），
 * 同时加载当前用户、挂上 401 兜底与系统主题监听。
 * setup 状态放在共享 store 里，SetupPage 初始化成功后会重拉，
 * 根门随即放行，不需要整页刷新。
 */
export function RootGate() {
  const location = useLocation()
  const load = useAuthStore((state) => state.load)
  const setup = useSetupGateStore((state) => state.state)
  const loadSetup = useSetupGateStore((state) => state.load)
  const loadSite = useSiteStore((state) => state.load)
  const siteName = useSiteStore((state) => state.name)

  useEffect(() => {
    setUnauthorizedHandler(() => useAuthStore.getState().setUser(null))
    void load()
    void loadSite()
    const stopTheme = watchSystemTheme(() =>
      useThemeStore.getState().syncSystem()
    )
    if (useSetupGateStore.getState().state === null) void loadSetup()
    return () => {
      stopTheme()
      setUnauthorizedHandler(null)
    }
  }, [load, loadSetup, loadSite])

  // 站点改名后页签标题立即跟着变，不需要重新构建或刷新。
  useEffect(() => {
    document.title = siteName
  }, [siteName])

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

/**
 * 需要登录；受限会话（被要求配置 2FA）只能进设置页。
 * 配置成功时设置页会调用 setRestricted(false)，此后正常放行。
 */
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
