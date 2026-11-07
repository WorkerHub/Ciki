import type { ReactNode } from "react"
import { ThemeCycleButton } from "@/components/ThemeToggle"

/** 未登录页面的统一外壳：品牌、主题切换、页脚版本号（规格 §8）。 */
export function AuthShell({
  title,
  subtitle,
  children
}: {
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="relative flex min-h-svh flex-col bg-background">
      <div className="absolute top-3 right-3">
        <ThemeCycleButton />
      </div>
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-2 text-center">
            <h1 className="font-heading text-xl font-semibold tracking-tight">
              {title}
            </h1>
            {subtitle ? (
              <p className="text-sm text-muted-foreground">{subtitle}</p>
            ) : null}
          </div>
          <div className="rounded-xl border border-border bg-card p-5 shadow-xs">
            {children}
          </div>
        </div>
      </main>
      <footer className="px-4 pb-4 text-center text-[11px] text-muted-foreground">
        ciki · {__APP_VERSION__}
      </footer>
    </div>
  )
}
