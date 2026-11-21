import { cn } from "cn"
import {
  ArrowLeft,
  CircleHelp,
  Info,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  UserRound
} from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { Suspense, useEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { useTranslation } from "react-i18next"
import {
  Group,
  Panel,
  type PanelImperativeHandle,
  Separator,
  useDefaultLayout
} from "react-resizable-panels"
import { Link, Outlet, useLocation, useNavigate } from "react-router"
import { CikiLogo } from "@/components/CikiLogo"
import { CreatePageDialog } from "@/components/CreatePageDialog"
import { HelpDialog } from "@/components/HelpDialog"
import { PageCanvas } from "@/components/PageCanvas"
import { PageTree } from "@/components/PageTree"
import { SearchBox } from "@/components/SearchBox"
import { SpaceSwitcher } from "@/components/SpaceSwitcher"
import { ThemeCycleButton } from "@/components/ThemeToggle"
import { displayUsername, UserAvatar } from "@/components/UserAvatar"
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useSpaceRole } from "@/hooks/useSpaceRole"
import { buildVersionLabel } from "@/lib/build-info"
import { pageEditPath, spaceSearchPath, spaceTrashPath } from "@/lib/routes"
import {
  readSidebarOpen,
  SIDEBAR_DEFAULT_SIZE,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_ICON,
  writeSidebarOpen
} from "@/lib/sidebar"
import { canEdit } from "@/lib/space"
import { useAuthStore } from "@/stores/auth"
import { usePagesStore } from "@/stores/pages"
import { useSiteStore } from "@/stores/site"
import { useSpacesStore } from "@/stores/spaces"

/**
 * 这些页面不显示页面树侧栏：内容区全宽，移动端也不给抽屉入口。
 * 空间上下文里的回收站/设置在 `/s/:slug/` 下面，不能按前缀判；搜索页沿用原来的
 * 「带侧栏的分类页」口径（改路径不改版式），`/s/:slug` 本身是空间首页，也带侧栏。
 */
const SYSTEM_ROUTE_PREFIXES = ["/settings", "/about", "/admin", "/profile"]

const SPACE_SYSTEM_SEGMENTS = new Set(["trash", "settings"])

function isSystemPath(pathname: string): boolean {
  if (
    SYSTEM_ROUTE_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    )
  )
    return true
  const segments = pathname.split("/").filter(Boolean)
  return (
    segments.length === 3 &&
    segments[0] === "s" &&
    SPACE_SYSTEM_SEGMENTS.has(segments[2])
  )
}

/**
 * 文章页（阅读 /p/:id 与编辑 /p/:id/edit）：正文宽度交给 PageCanvas，
 * 壳层不再套 1140px 上限，否则正文到不了 1600px 封顶。
 */
function isArticlePath(pathname: string): boolean {
  return pathname.startsWith("/p/")
}

function SidebarContent({
  onNavigate,
  onCollapse
}: {
  onNavigate?: () => void
  onCollapse?: () => void
}) {
  const { t } = useTranslation()
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
          {t("shell.sidebar.pages")}
        </span>
        {canWrite ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={t("shell.newPage")}
            title={t("shell.newPage")}
            onClick={() => setCreateOpen(true)}
          >
            <Plus aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-4">
        <PageTree onNavigate={onNavigate} />
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-sidebar-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <p className="truncate">{buildVersionLabel(siteName)}</p>
        {onCollapse ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            data-sidebar-collapse
            aria-label={t("shell.sidebar.collapse")}
            title={t("shell.sidebar.collapse")}
            onClick={onCollapse}
            className="shrink-0"
          >
            <PanelLeftClose aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      <CreatePageDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        parentId={null}
        onCreated={(page) => {
          onNavigate?.()
          navigate(pageEditPath(page.id))
        }}
      />
    </div>
  )
}

function IconColumn({
  siteName,
  onExpand
}: {
  siteName: string
  onExpand: () => void
}) {
  const { t } = useTranslation()
  const versionLabel = buildVersionLabel(siteName)

  return (
    <TooltipProvider delayDuration={0}>
      <div
        data-sidebar-collapsed
        className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground"
      >
        <div className="flex h-12 shrink-0 items-center justify-center border-b border-border">
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to="/"
                className="flex size-8 items-center justify-center rounded-lg text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                aria-label={siteName}
              >
                <CikiLogo />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right" align="center">
              {siteName}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex justify-center border-b border-sidebar-border py-2">
          <SpaceSwitcher compact />
        </div>
        <div className="min-h-0 flex-1" />
        {/* 收起态（48px 图标列）页脚：
            对齐模板/Cbox 规格，48px 列宽仅能容纳单列图标，物理上无法并排横向放置文字版本号；
            展开态在 SidebarContent 严格保持「左版本号、右收起按钮」；
            收起态展开按钮位于图标列页脚（视口左下角），并通过 sr-only 与 title 保留版本号文本可访问性。 */}
        <div
          title={versionLabel}
          className="flex h-10 shrink-0 items-center justify-center border-t border-sidebar-border px-1.5 py-1"
        >
          <span className="sr-only">{versionLabel}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                data-sidebar-expand
                aria-label={t("shell.sidebar.expand")}
                title={t("shell.sidebar.expand")}
                onClick={onExpand}
                className="size-8 text-muted-foreground hover:text-sidebar-foreground"
              >
                <PanelLeftOpen aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" align="center">
              {t("shell.sidebar.expand")}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  )
}

function UserMenu() {
  const { t } = useTranslation()
  const user = useAuthStore((state) => state.user)
  const logout = useAuthStore((state) => state.logout)
  const spaces = useSpacesStore((state) => state.spaces)
  const currentSpaceId = useSpacesStore((state) => state.currentId)
  const currentSlug =
    spaces.find((space) => space.id === currentSpaceId)?.slug ?? null
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
            aria-label={t("shell.userMenu.trigger")}
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
          {/* 顺序：个人资料 → 系统管理（仅管理员）→ 回收站 → 设置 → 关于 → 帮助 */}
          <DropdownMenuItem onSelect={() => navigate("/profile")}>
            <UserRound aria-hidden="true" />
            {t("shell.userMenu.profile")}
          </DropdownMenuItem>
          {user.role === "admin" ? (
            <DropdownMenuItem onSelect={() => navigate("/admin")}>
              <ShieldCheck aria-hidden="true" />
              {t("shell.userMenu.admin")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onSelect={() =>
              navigate(currentSlug ? spaceTrashPath(currentSlug) : "/")
            }
          >
            <Trash2 aria-hidden="true" />
            {t("shell.userMenu.trash")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate("/settings")}>
            <Settings aria-hidden="true" />
            {t("shell.userMenu.settings")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate("/about")}>
            <Info aria-hidden="true" />
            {t("shell.userMenu.about")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setHelpOpen(true)}>
            <CircleHelp aria-hidden="true" />
            {t("shell.userMenu.help")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => {
              void logout().then(() => navigate("/login"))
            }}
          >
            <LogOut aria-hidden="true" />
            {t("shell.userMenu.logout")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </>
  )
}

export function AppShell() {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const siteName = useSiteStore((state) => state.name)
  const loadTree = usePagesStore((state) => state.load)
  const loadSpaces = useSpacesStore((state) => state.load)
  const spacesStatus = useSpacesStore((state) => state.status)
  const spaces = useSpacesStore((state) => state.spaces)
  const currentSpaceId = useSpacesStore((state) => state.currentId)
  const currentSlug =
    spaces.find((space) => space.id === currentSpaceId)?.slug ?? null
  const role = useSpaceRole(currentSpaceId)
  const canWrite = canEdit(role)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const reduceMotion = useReducedMotion()
  const isSystemRoute = isSystemPath(location.pathname)
  const isArticleRoute = isArticlePath(location.pathname)
  const layout = useDefaultLayout({
    id: "ciki-shell",
    panelIds: ["sidebar", "main"],
    onlySaveAfterUserInteractions: true
  })
  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null)
  const [collapsible, setCollapsible] = useState(() => !readSidebarOpen())
  const [isCollapsed, setIsCollapsed] = useState(() => !readSidebarOpen())
  // 记住进入系统页之前最近访问的文档路由（仅内存，不落盘）：
  // 顶栏「返回文档」回这里；系统页之间互跳（设置 ↔ 系统管理）不覆盖它；
  // 刷新 / 直接打开系统页时为 null，回退首页「/」。

  const handleCollapse = () => {
    flushSync(() => {
      setCollapsible(true)
    })
    sidebarPanelRef.current?.collapse()
    setIsCollapsed(true)
    writeSidebarOpen(false)
  }

  const handleExpand = () => {
    sidebarPanelRef.current?.expand()
    setIsCollapsed(false)
    writeSidebarOpen(true)
    setCollapsible(false)
  }

  // 收起态与 Panel 挂载状态的同步：从系统页返回普通页时，顶层的 Group/Panel
  // 会整树重新挂载并回到 defaultSize（展开宽度），而收起与否只存在 React state
  // 里，初始化 effect 只跑一次、帮不上重挂载。这里按依赖持续同步：只要
  // 「state 认为收起、新挂载的 Panel 却是展开的」，就立即 collapse 回 48px
  // 图标列，避免出现图标列被撑成 260px 的布局错乱。展开态或移动端不介入。
  useEffect(() => {
    if (isMobile || isSystemRoute || !isCollapsed) return
    if (!sidebarPanelRef.current?.isCollapsed()) {
      sidebarPanelRef.current?.collapse()
    }
  }, [isMobile, isSystemRoute, isCollapsed])

  // 文档路由跟踪：只在非系统页时更新（系统页之间互跳不覆盖来源）；
  // 全页刷新 / 直接落在系统页时保持 null，返回按钮回退「/」。
  const lastDocRouteRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isSystemRoute) lastDocRouteRef.current = location.pathname
  }, [location.pathname, isSystemRoute])

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

  const content = (
    <Suspense
      fallback={
        <div
          className="space-y-3"
          role="status"
          aria-label={t("shell.loadingPage")}
        >
          <div className="h-7 w-2/5 animate-pulse rounded bg-muted" />
          <div className="h-48 animate-pulse rounded-xl bg-muted/60" />
        </div>
      }
    >
      <Outlet />
    </Suspense>
  )

  // 文章页读、写两态走同一条分支：宽度只由 PageCanvas 决定，两处不会各写一份。
  const main = isArticleRoute ? (
    <PageCanvas>{content}</PageCanvas>
  ) : (
    // 分类页（搜索等）与文章页共用同一条左缘：贴着分割线 16px/24px 起排，
    // 不再用 1140px 居中容器把内容推得比正文更靠右；宽度上限保留，只去掉居中。
    // 系统页正文列：正文列左缘 = max(居中位置, logo 区右缘)。
    // 宽屏（≥1920px）正文列居中、左右留白对称、视觉与改前一致；
    // 窄屏（<1920px，如 1440/1728px）居中位置会撞上 logo 区，左缘让到 logo 区右缘（260px）。
    <div
      className={cn(
        "px-4 py-5 sm:px-6 sm:py-6",
        isSystemRoute
          ? cn(
              "max-w-[1400px]",
              isMobile ? "mx-auto" : "ml-[260px] min-[1920px]:mx-auto"
            )
          : "w-full max-w-[1140px]"
      )}
    >
      {content}
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

  const siteLink = (
    <Link
      to="/"
      className="flex min-w-0 items-center gap-1.5 font-heading text-sm font-semibold tracking-tight"
    >
      <CikiLogo />
      <span className="max-w-[8rem] truncate sm:max-w-[14rem]">{siteName}</span>
    </Link>
  )

  const backToDocButton = (
    <Button asChild variant="ghost" size="sm" className="gap-1.5">
      <Link to={lastDocRouteRef.current ?? "/"}>
        <ArrowLeft aria-hidden="true" />
        {t("shell.backToDocument")}
      </Link>
    </Button>
  )

  const createButton = canWrite ? (
    <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
      <Plus aria-hidden="true" />
      {t("shell.newPage")}
    </Button>
  ) : null

  const accountActions = (
    <div className="ml-auto flex items-center gap-0.5">
      <ThemeCycleButton />
      <UserMenu />
    </div>
  )

  const mobileActions = (
    <div className="ml-auto flex items-center gap-1">
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t("shell.search.action")}
        onClick={() =>
          navigate(currentSlug ? spaceSearchPath(currentSlug) : "/")
        }
      >
        <Search aria-hidden="true" />
      </Button>
      {canWrite ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={t("shell.newPage")}
          onClick={() => setCreateOpen(true)}
        >
          <Plus aria-hidden="true" />
        </Button>
      ) : null}
      <ThemeCycleButton />
      <UserMenu />
    </div>
  )

  const mobileMenu =
    isMobile && !isSystemRoute ? (
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t("shell.openTree")}
          >
            <Menu aria-hidden="true" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-[85vw] max-w-xs p-0">
          <SheetTitle className="sr-only">{t("shell.pageTree")}</SheetTitle>
          <SidebarContent onNavigate={() => setSheetOpen(false)} />
        </SheetContent>
      </Sheet>
    ) : null

  return (
    <div className="flex h-svh flex-col bg-background">
      {isMobile || isSystemRoute ? (
        <>
          <header className="relative flex h-12 shrink-0 items-center border-b border-border">
            {/* 系统页：顶栏为 logo 预留固定宽度左侧区（260px），
                logo+标题置于其内左上角；正文内容列（含「返回文档」）位于该区右侧，
                与正文标题列左边缘对齐。
                宽屏（≥1920px）正文列居中、左右留白对称、视觉与改前一致；
                窄屏（<1920px，如 1440/1728px）居中位置会撞上 logo 区，左缘让到 logo 区右缘（260px）。 */}
            {isSystemRoute ? (
              isMobile ? (
                <div className="flex h-12 w-full items-center gap-2 px-2 sm:px-3">
                  {backToDocButton}
                  {siteLink}
                  {accountActions}
                </div>
              ) : (
                <div className="relative flex h-12 w-full items-center">
                  <div className="absolute inset-y-0 left-0 flex h-12 w-[260px] items-center gap-2 px-2 sm:px-3">
                    {siteLink}
                  </div>
                  <div className="flex h-12 w-full max-w-[1400px] items-center gap-2 px-4 sm:px-6 ml-[260px] min-[1920px]:mx-auto">
                    {backToDocButton}
                    {accountActions}
                  </div>
                </div>
              )
            ) : (
              <div className="flex h-12 w-full items-center gap-2 px-2 sm:px-3">
                {mobileMenu}
                {siteLink}
                {mobileActions}
              </div>
            )}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">{animatedMain}</div>
        </>
      ) : (
        // 桌面普通页：顶栏按两栏拆开——站点名落在侧栏那一栏，搜索框落在正文那一栏、
        // 左缘与正文左缘同一条基线（贴着分割线 24px）。顶栏跟着可拖拽的栏宽走，
        // 所以这里不写死宽度、不用 JS 同步栏宽，交给布局本身定位。
        <Group
          orientation="horizontal"
          className="min-h-0 flex-1"
          defaultLayout={layout.defaultLayout}
          onLayoutChanged={layout.onLayoutChanged}
        >
          <Panel
            id="sidebar"
            panelRef={sidebarPanelRef}
            defaultSize={SIDEBAR_DEFAULT_SIZE}
            minSize={SIDEBAR_MIN_WIDTH}
            maxSize={SIDEBAR_MAX_WIDTH}
            collapsible={collapsible}
            collapsedSize={SIDEBAR_WIDTH_ICON}
            className="h-full"
          >
            {isCollapsed ? (
              <IconColumn siteName={siteName} onExpand={handleExpand} />
            ) : (
              <div className="flex h-full flex-col overflow-hidden">
                <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2 sm:px-3">
                  {siteLink}
                </div>
                <div className="min-h-0 flex-1">
                  <SidebarContent onCollapse={handleCollapse} />
                </div>
              </div>
            )}
          </Panel>
          <Separator
            disabled={isCollapsed}
            className={cn(
              "relative w-px bg-border transition-colors",
              !isCollapsed &&
                "hover:bg-primary/40 data-[separator=active]:bg-primary/60 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2"
            )}
            aria-label={t("shell.sidebar.resize")}
          />
          <Panel id="main" minSize={360} className="h-full">
            <div className="relative flex h-full flex-col">
              {/* 对齐正文内容列实际渲染左边缘：
                  文章页与 PageCanvas 同口径（px-4 sm:px-6 + max-w-[1600px] 居中容器）；
                  分类/搜索页与分类容器同口径（px-4 sm:px-6 左对齐，不居中）；
                  收起与展开两态下，搜索框左边缘与正文（面包屑/标题列）左边缘在像素级完全一致。 */}
              <header className="flex h-12 shrink-0 items-center border-b border-border px-4 sm:px-6">
                <div
                  className={cn(
                    "flex w-full items-center gap-2",
                    isArticleRoute && "mx-auto max-w-[1600px]"
                  )}
                >
                  <SearchBox className="max-w-md flex-1" />
                  {createButton}
                  {accountActions}
                </div>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {animatedMain}
              </div>
            </div>
          </Panel>
        </Group>
      )}

      <CreatePageDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        parentId={null}
        onCreated={(page) => navigate(pageEditPath(page.id))}
      />
    </div>
  )
}
