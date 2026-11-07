import { cn } from "cn"
import {
  CircleHelp,
  Info,
  LogOut,
  Menu,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Trash2
} from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { Suspense, useEffect, useState } from "react"
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout
} from "react-resizable-panels"
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router"
import { CreatePageDialog } from "@/components/CreatePageDialog"
import { HelpButton } from "@/components/HelpDialog"
import { PageTree } from "@/components/PageTree"
import { SearchBox } from "@/components/SearchBox"
import { ThemeCycleButton } from "@/components/ThemeToggle"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger
} from "@/components/ui/sheet"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { formatDate } from "@/lib/format"
import { useAuthStore } from "@/stores/auth"
import { usePagesStore } from "@/stores/pages"

const NAV_ITEMS = [
  { to: "/trash", label: "回收站", icon: Trash2 },
  { to: "/settings", label: "设置", icon: Settings },
  { to: "/about", label: "关于", icon: Info }
] as const

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate()
  const user = useAuthStore((state) => state.user)
  const [createOpen, setCreateOpen] = useState(false)

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <span className="text-xs font-medium tracking-wide text-muted-foreground">
          页面
        </span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="新建页面"
          title="新建页面"
          onClick={() => setCreateOpen(true)}
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-4">
        <PageTree onNavigate={onNavigate} />
      </div>
      <nav className="border-t border-sidebar-border p-1.5" aria-label="站点">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                isActive && "bg-accent text-accent-foreground"
              )
            }
          >
            <item.icon className="size-3.5" aria-hidden="true" />
            {item.label}
          </NavLink>
        ))}
        <HelpButton label="帮助" />
        {user?.role === "admin" ? (
          <NavLink
            to="/admin"
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                isActive && "bg-accent text-accent-foreground"
              )
            }
          >
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            系统管理
          </NavLink>
        ) : null}
      </nav>
      <p className="border-t border-sidebar-border px-3 py-2 text-[11px] text-muted-foreground">
        ciki · {__APP_VERSION__}
      </p>

      <CreatePageDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        parentId={null}
        onCreated={(page) => {
          onNavigate?.()
          navigate(`/p/${page.id}/edit`)
        }}
      />
    </div>
  )
}

function UserMenu() {
  const user = useAuthStore((state) => state.user)
  const logout = useAuthStore((state) => state.logout)
  const navigate = useNavigate()
  if (!user) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="max-w-[12rem] gap-1.5"
          aria-label="账号菜单"
        >
          <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
            {user.email.slice(0, 1).toUpperCase()}
          </span>
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
            {user.email}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate">{user.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/settings")}>
          设置
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/trash")}>
          回收站
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/about")}>
          关于
        </DropdownMenuItem>
        {user.role === "admin" ? (
          <DropdownMenuItem onSelect={() => navigate("/admin")}>
            系统管理
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            void logout().then(() => navigate("/login"))
          }}
        >
          <LogOut aria-hidden="true" />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AppShell() {
  const isMobile = useIsMobile()
  const loadTree = usePagesStore((state) => state.load)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const reduceMotion = useReducedMotion()
  const layout = useDefaultLayout({
    id: "ciki-shell",
    panelIds: ["sidebar", "main"]
  })

  useEffect(() => {
    void loadTree()
  }, [loadTree])

  // 移动端抽屉在点击树节点/导航项时由 onNavigate 关闭，不需要额外的路由副作用。

  const main = (
    <div className="mx-auto w-full max-w-[1140px] px-4 py-5 sm:px-6 sm:py-6">
      <Suspense
        fallback={
          <div className="space-y-3" role="status" aria-label="页面加载中">
            <div className="h-7 w-2/5 animate-pulse rounded bg-muted" />
            <div className="h-48 animate-pulse rounded-xl bg-muted/60" />
          </div>
        }
      >
        <Outlet />
      </Suspense>
    </div>
  )

  return (
    <div className="flex h-svh flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2 sm:px-3">
        {isMobile ? (
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="打开页面树"
              >
                <Menu aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[85vw] max-w-xs p-0">
              <SheetTitle className="sr-only">页面树</SheetTitle>
              <SidebarContent onNavigate={() => setSheetOpen(false)} />
            </SheetContent>
          </Sheet>
        ) : null}

        <Link
          to="/"
          className="font-heading text-sm font-semibold tracking-tight"
        >
          ciki
        </Link>

        {isMobile ? (
          <div className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="搜索"
              onClick={() => navigate("/search")}
            >
              <Search aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="新建页面"
              onClick={() => setCreateOpen(true)}
            >
              <Plus aria-hidden="true" />
            </Button>
            <ThemeCycleButton />
            <UserMenu />
          </div>
        ) : (
          <>
            <SearchBox className="mx-3 max-w-md flex-1" />
            <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden="true" />
              新建页面
            </Button>
            <div className="ml-auto flex items-center gap-0.5">
              <HelpButton />
              <ThemeCycleButton />
              <UserMenu />
            </div>
          </>
        )}
      </header>

      {isMobile ? (
        <div className="min-h-0 flex-1 overflow-y-auto">{main}</div>
      ) : (
        <Group
          orientation="horizontal"
          className="min-h-0 flex-1"
          defaultLayout={layout.defaultLayout}
          onLayoutChanged={layout.onLayoutChanged}
        >
          <Panel
            id="sidebar"
            defaultSize="18%"
            minSize={200}
            maxSize={420}
            className="h-full"
          >
            <div className="h-full overflow-hidden border-r border-border">
              <SidebarContent />
            </div>
          </Panel>
          <Separator
            className="w-px bg-border transition-colors hover:bg-primary/40 data-[separator=active]:bg-primary/60"
            aria-label="调整侧边栏宽度"
          />
          <Panel id="main" minSize={360} className="h-full">
            <div className="h-full overflow-y-auto">
              <motion.div
                key={location.pathname}
                initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                {main}
              </motion.div>
            </div>
          </Panel>
        </Group>
      )}

      <CreatePageDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        parentId={null}
        onCreated={(page) => navigate(`/p/${page.id}/edit`)}
      />

      <footer className="hidden shrink-0 items-center gap-2 border-t border-border px-3 py-1 text-[11px] text-muted-foreground sm:flex">
        <CircleHelp className="size-3" aria-hidden="true" />
        <span>Ctrl/⌘ + S 保存 · 支持从 Confluence 直接粘贴</span>
        <span className="ml-auto truncate">
          {__APP_VERSION__} · 构建于 {formatDate(__APP_BUILD_TIME__)}
        </span>
      </footer>
    </div>
  )
}
