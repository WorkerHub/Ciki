import { ShieldCheck } from "lucide-react"
import { useTranslation } from "react-i18next"
import { NavLink, Outlet } from "react-router"
import { cn } from "cn"
import {
  adminEmailPath,
  adminOthersPath,
  adminSecurityPath,
  adminSitePath,
  adminSpacesPath,
  adminUsersPath
} from "@/lib/routes"

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "relative inline-flex h-[calc(100%-1px)] items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground",
    isActive
      ? "bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30 dark:text-foreground"
      : "text-foreground/60 hover:text-foreground"
  )

const TABS = [
  { to: adminUsersPath(), labelKey: "admin.tabs.users" },
  { to: adminSpacesPath(), labelKey: "admin.tabs.spaces" },
  { to: adminSitePath(), labelKey: "admin.tabs.settings" },
  { to: adminSecurityPath(), labelKey: "admin.tabs.security" },
  { to: adminEmailPath(), labelKey: "admin.tabs.email" },
  { to: adminOthersPath(), labelKey: "admin.tabs.others" }
] as const

/**
 * 系统管理：用户管理 / 空间总览 / 应用设置 / 访问与安全 / 邮件配置 / 其他。
 * 采用嵌套路由 + NavLink 子导航驱动，各分区由 Outlet 装载。
 */
export function AdminPage() {
  const { t } = useTranslation()

  return (
    <div className="space-y-4">
      <header>
        <h1 className="flex items-center gap-2 font-heading text-xl font-semibold tracking-tight">
          <ShieldCheck
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          {t("admin.title")}
        </h1>
      </header>

      <nav
        aria-label={t("admin.title")}
        className="inline-flex h-8 items-center rounded-lg bg-muted p-[3px] text-muted-foreground w-full justify-start overflow-x-auto sm:w-auto"
      >
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className={navLinkClass}>
            {t(tab.labelKey)}
          </NavLink>
        ))}
      </nav>

      <div className="mt-3">
        <Outlet />
      </div>
    </div>
  )
}
