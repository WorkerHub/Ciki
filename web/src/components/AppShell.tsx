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
  Trash2,
  UserRound
} from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { Suspense, useEffect, useState } from "react"
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout
} from "react-resizable-panels"
import { Link, Outlet, useLocation, useNavigate } from "react-router"
import { CikiLogo } from "@/components/CikiLogo"
import { CreatePageDialog } from "@/components/CreatePageDialog"
import { HelpDialog } from "@/components/HelpDialog"
import { PageTree } from "@/components/PageTree"
import { SearchBox } from "@/components/SearchBox"
import { SpaceSwitcher } from "@/components/SpaceSwitcher"
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
import { displayUsername, UserAvatar } from "@/components/UserAvatar"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useSpaceRole } from "@/hooks/useSpaceRole"
import { canEdit } from "@/lib/space"
import { useAuthStore } from "@/stores/auth"
import { usePagesStore } from "@/stores/pages"
import { useSiteStore } from "@/stores/site"
import { useSpacesStore } from "@/stores/spaces"

/**
 * 这些页面不显示页面树侧栏：内容区全宽，移动端也不给抽屉入口。
 * 与路由表一一对应（/profile、/spaces 在 App.tsx 里新增）。
 */
const SYSTEM_ROUTE_PREFIXES = [
  "/settings",
  "/trash",
  "/about",
  "/admin",
  "/profile",
  "/spaces"
] as const

function isSystemPath(pathname: string): boolean {
  return SYSTEM_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate()
  const siteName = useSiteStore((state) => state.name)
  const currentSpaceId = useSpacesStore((state) => state.currentId)
  const role = useSpaceRole(currentSpaceId)
  const canWrite = canEdit(role)
  const [createOpen, setCreateOpen] = useState(false)

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="border-b border-sidebar-border pt-2">
        <SpaceSwitcher onNavigate={onNavigate} />
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground">
          页面
        </span>
        {canWrite ? (
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
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-4">
        <PageTree onNavigate={onNavigate} />
      </div>
      <p className="truncate border-t border-sidebar-border px-3 py-2 text-[11px] text-muted-foreground">
        {siteName} · {__APP_VERSION__}
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
  const [helpOpen, setHelpOpen] = useState(false)

  if (!user) return null
  const username = displayUsername(user)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="max-w-[12rem] gap-1.5"
            aria-label="账号菜单"
          >
            <UserAvatar user={user} className="size-6 text-[11px]" />
            <span className="max-w-[6rem] truncate text-xs text-muted-foreground sm:max-w-[10rem]">
              {username}
            </span>
          </Button>
        </DropdownMenuTrigger>
        {/* 宽度按内容自适应，上限 12.5rem（200px） */}
        <DropdownMenuContent
          align="end"
          className="w-auto min-w-[11rem] max-w-[12.5rem]"
        >
          <DropdownMenuLabel className="flex items-center gap-2 px-1.5 py-1.5">
            <UserAvatar user={user} className="size-8 shrink-0 text-xs" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-foreground">
                {username}
              </span>
              <span className="block truncate text-[11px] font-normal text-muted-foreground">
                {user.email}
              </span>
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate("/profile")}>
            <UserRound aria-hidden="true" />
            个人资料
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate("/settings")}>
            <Settings aria-hidden="true" />
            设置
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate("/trash")}>
            <Trash2 aria-hidden="true" />
            回收站
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate("/about")}>
            <Info aria-hidden="true" />
            关于
          </DropdownMenuItem>
          {user.role === "admin" ? (
            <DropdownMenuItem onSelect={() => navigate("/admin")}>
              <ShieldCheck aria-hidden="true" />
              系统管理
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => setHelpOpen(true)}>
            <CircleHelp aria-hidden="true" />
            帮助
          </DropdownMenuItem>
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
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </>
  )
}

export function AppShell() {
  const isMobile = useIsMobile()
  const siteName = useSiteStore((state) => state.name)
  const loadTree = usePagesStore((state) => state.load)
  const loadSpaces = useSpacesStore((state) => state.load)
  const spacesStatus = useSpacesStore((state) => state.status)
  const currentSpaceId = useSpacesStore((state) => state.currentId)
  const role = useSpaceRole(currentSpaceId)
  const canWrite = canEdit(role)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const reduceMotion = useReducedMotion()
  const isSystemRoute = isSystemPath(location.pathname)
  const layout = useDefaultLayout({
    id: "ciki-shell",
    panelIds: ["sidebar", "main"]
  })

  useEffect(() => {
    void loadSpaces()
  }, [loadSpaces])

  // 空间列表到手后再拉树：默认空间用 null（不带 spaceId 交给后端缺省）；
  // 列表失败时也退回默认空间的树，应用不白屏。
  useEffect(() => {
    if (spacesStatus === "ready") void loadTree(currentSpaceId)
    else if (spacesStatus === "error") void loadTree(null)
  }, [loadTree, spacesStatus, currentSpaceId])

  // 移动端抽屉在点击树节点/导航项时由 onNavigate 关闭，不需要额外的路由副作用。

  const main = (
    <div
      className={cn(
        "mx-auto w-full px-4 py-5 sm:px-6 sm:py-6",
        isSystemRoute ? "max-w-[1400px]" : "max-w-[1140px]"
      )}
    >
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

  const animatedMain = (
    <motion.div
      key={location.pathname}
      initial={reduceMotion ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      {main}
    </motion.div>
  )

  return (
    <div className="flex h-svh flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2 sm:px-3">
        {isMobile && !isSystemRoute ? (
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
          className="flex min-w-0 items-center gap-1.5 font-heading text-sm font-semibold tracking-tight"
        >
          <CikiLogo />
          <span className="max-w-[8rem] truncate sm:max-w-[14rem]">
            {siteName}
          </span>
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
            {canWrite ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="新建页面"
                onClick={() => setCreateOpen(true)}
              >
                <Plus aria-hidden="true" />
              </Button>
            ) : null}
            <ThemeCycleButton />
            <UserMenu />
          </div>
        ) : (
          <>
            <SearchBox className="mx-3 max-w-md flex-1" />
            {canWrite ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setCreateOpen(true)}
              >
                <Plus aria-hidden="true" />
                新建页面
              </Button>
            ) : null}
            <div className="ml-auto flex items-center gap-0.5">
              <ThemeCycleButton />
              <UserMenu />
            </div>
          </>
        )}
      </header>

      {isMobile || isSystemRoute ? (
        <div className="min-h-0 flex-1 overflow-y-auto">{animatedMain}</div>
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
            <div className="h-full overflow-y-auto">{animatedMain}</div>
          </Panel>
        </Group>
      )}

      <CreatePageDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        parentId={null}
        onCreated={(page) => navigate(`/p/${page.id}/edit`)}
      />
    </div>
  )
}
