import { lazy } from "react"
import {
  createBrowserRouter,
  type RouteObject,
  RouterProvider
} from "react-router"
import { AppShell } from "@/components/AppShell"
import {
  GuestOnly,
  RequireAdmin,
  RequireAuth,
  RootGate
} from "@/components/guards"
import { SpaceRoute } from "@/components/SpaceRoute"
import { Toaster } from "@/components/ui/sonner"
import { NotFound } from "@/pages/NotFound"

// 页面按路由懒加载：编辑器（TipTap + lowlight）与二维码库只在对应页面才下载。
const AdminPage = lazy(() =>
  import("@/pages/AdminPage").then((module) => ({ default: module.AdminPage }))
)
const AboutPage = lazy(() =>
  import("@/pages/AboutPage").then((module) => ({ default: module.AboutPage }))
)
const HomeRedirect = lazy(() =>
  import("@/pages/HomeRedirect").then((module) => ({
    default: module.HomeRedirect
  }))
)
const RootRedirect = lazy(() =>
  import("@/pages/HomeRedirect").then((module) => ({
    default: module.RootRedirect
  }))
)
const PageEdit = lazy(() =>
  import("@/pages/PageEdit").then((module) => ({ default: module.PageEdit }))
)
const PageView = lazy(() =>
  import("@/pages/PageView").then((module) => ({ default: module.PageView }))
)
const ProfilePage = lazy(() =>
  import("@/pages/ProfilePage").then((module) => ({
    default: module.ProfilePage
  }))
)
const SearchPage = lazy(() =>
  import("@/pages/SearchPage").then((module) => ({
    default: module.SearchPage
  }))
)
const SettingsPage = lazy(() =>
  import("@/pages/SettingsPage").then((module) => ({
    default: module.SettingsPage
  }))
)
const SpaceSettingsPage = lazy(() =>
  import("@/pages/SpaceSettingsPage").then((module) => ({
    default: module.SpaceSettingsPage
  }))
)
const TrashPage = lazy(() =>
  import("@/pages/TrashPage").then((module) => ({ default: module.TrashPage }))
)
const LoginPage = lazy(() =>
  import("@/pages/auth/LoginPage").then((module) => ({
    default: module.LoginPage
  }))
)
const ForgotPasswordPage = lazy(() =>
  import("@/pages/auth/ForgotPasswordPage").then((module) => ({
    default: module.ForgotPasswordPage
  }))
)
const RegisterPage = lazy(() =>
  import("@/pages/auth/RegisterPage").then((module) => ({
    default: module.RegisterPage
  }))
)
const VerifyEmailPage = lazy(() =>
  import("@/pages/auth/VerifyEmailPage").then((module) => ({
    default: module.VerifyEmailPage
  }))
)
const SetupPage = lazy(() =>
  import("@/pages/auth/SetupPage").then((module) => ({
    default: module.SetupPage
  }))
)

/**
 * 路由表单独导出，测试用 createMemoryRouter(routes) 拿到同一份定义。
 * 用数据路由（createBrowserRouter）是因为编辑页的「未保存离开」靠 useBlocker。
 */
export const routes: RouteObject[] = [
  {
    element: <RootGate />,
    children: [
      { path: "/setup", element: <SetupPage /> },
      {
        path: "/login",
        element: (
          <GuestOnly>
            <LoginPage />
          </GuestOnly>
        )
      },
      {
        path: "/register",
        element: (
          <GuestOnly>
            <RegisterPage />
          </GuestOnly>
        )
      },
      {
        path: "/forgot-password",
        element: (
          <GuestOnly>
            <ForgotPasswordPage />
          </GuestOnly>
        )
      },
      {
        // 注册邮箱验证：未登录可访问（只认邮箱 + 验证码），成功后回登录页
        path: "/verify-email",
        element: (
          <GuestOnly>
            <VerifyEmailPage />
          </GuestOnly>
        )
      },
      {
        element: (
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <RootRedirect /> },
          {
            // 空间上下文一律以 slug 进路径；`/s/:slug` 本身是空间首页（页面树根）
            path: "s/:slug",
            element: <SpaceRoute />,
            children: [
              { index: true, element: <HomeRedirect /> },
              { path: "trash", element: <TrashPage /> },
              { path: "search", element: <SearchPage /> },
              { path: "settings", element: <SpaceSettingsPage /> }
            ]
          },
          { path: "p/:pageId", element: <PageView /> },
          { path: "p/:pageId/edit", element: <PageEdit /> },
          { path: "profile", element: <ProfilePage /> },
          { path: "settings", element: <SettingsPage /> },
          { path: "about", element: <AboutPage /> },
          {
            path: "admin",
            element: (
              <RequireAdmin>
                <AdminPage />
              </RequireAdmin>
            )
          },
          { path: "*", element: <NotFound /> }
        ]
      }
    ]
  }
]

export const router = createBrowserRouter(routes)

export function App() {
  return (
    <>
      <RouterProvider router={router} />
      {/* 全局轻提示：浮在所有弹层之上，供删除成功这类瞬时反馈使用。 */}
      <Toaster />
    </>
  )
}
