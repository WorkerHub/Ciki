import { Empty } from "@cloudflare/kumo/components/empty"
import {
  ArrowRightLeft,
  History,
  Pencil,
  Plus,
  RefreshCw,
  Trash2
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useLocation, useNavigate, useParams } from "react-router"
import { ArticleToc } from "@/components/ArticleToc"
import { CreatePageDialog } from "@/components/CreatePageDialog"
import { MovePageDialog } from "@/components/MovePageDialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { ReadView } from "@/editor/ReadView"
import {
  ApiError,
  describeApiError,
  type PageDetail,
  pagesApi
} from "@/lib/api"
import { formatRelative } from "@/lib/format"
import { canEdit, editableSpaces } from "@/lib/space"
import { extractToc } from "@/lib/toc"
import { findPath } from "@/lib/tree"
import { cn } from "@/lib/utils"
import { RevisionsDialog } from "@/pages/RevisionsDialog"
import { useSpaceRole } from "@/hooks/useSpaceRole"
import { useAuthStore } from "@/stores/auth"
import { usePagesStore } from "@/stores/pages"
import { useSpacesStore } from "@/stores/spaces"

/** 切回标签页自动刷新的节流窗口：短时间内反复切回不重复打接口。 */
const AUTO_REFRESH_THROTTLE_MS = 10_000

export function PageView() {
  const { pageId } = useParams<{ pageId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const isSiteAdmin = useAuthStore((state) => state.user?.role === "admin")
  const tree = usePagesStore((state) => state.tree)
  const removePage = usePagesStore((state) => state.removePage)
  const expandTo = usePagesStore((state) => state.expandTo)
  const loadTree = usePagesStore((state) => state.load)
  const spaces = useSpacesStore((state) => state.spaces)
  const spacesStatus = useSpacesStore((state) => state.status)
  const currentSpaceId = useSpacesStore((state) => state.currentId)
  const selectSpace = useSpacesStore((state) => state.select)
  const [page, setPage] = useState<PageDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [notFound, setNotFound] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [createChildOpen, setCreateChildOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState("")
  // 每个页面只跟随一次空间：切空间后本页还没卸载时不能把选择抢回去
  const syncedPage = useRef<string | null>(null)
  // 刷新中的旗标（防并发）与上次尝试时刻（自动刷新的节流基准）
  const refreshingRef = useRef(false)
  const lastRefreshAt = useRef(Date.now())
  // 每次渲染写入当前页 id：刷新途中切了页就丢弃这次结果
  const pageIdRef = useRef(pageId)
  pageIdRef.current = pageId
  const role = useSpaceRole(page?.spaceId)
  const canWrite = canEdit(role)

  // 索引从详情已下发的 contentJson 同步提取：与正文同一次渲染出现，没有第二次请求，
  // 正文宽度不会在轨插入时跳变；标题不足 2 条的页面返回空，整轨不渲染。
  const toc = useMemo(
    () => extractToc(page?.contentJson ?? ""),
    [page?.contentJson]
  )
  const headingIds = useMemo(() => toc.map((item) => item.id), [toc])
  const [contentRoot, setContentRoot] = useState<HTMLElement | null>(null)
  const handleContentReady = useCallback((root: HTMLElement) => {
    setContentRoot(root)
  }, [])
  // 每页只恢复一次 hash：浏览器首屏时标题元素还不存在，要等锚点补齐后再跳。
  // 只有目标真在当前正文根元素里才记帐——切页瞬间 contentRoot 可能还是上一页的，
  // 先记帐会让新页的就绪回调直接 return，滚动就永远丢了。
  const hashRestored = useRef<string | null>(null)
  useEffect(() => {
    if (!contentRoot || !page) return
    if (hashRestored.current === page.id) return
    if (!location.hash) return
    let id = location.hash.slice(1)
    try {
      id = decodeURIComponent(id)
    } catch {
      return
    }
    const target = document.getElementById(id)
    if (!target || !contentRoot.contains(target)) return
    hashRestored.current = page.id
    target.scrollIntoView()
  }, [contentRoot, page, location.hash])

  useEffect(() => {
    if (!pageId) return
    let alive = true
    setLoading(true)
    setError("")
    setNotFound(false)
    // 换页同样是一次「刚拿到最新数据」：清掉上一页的刷新报错，节流基准也跟着重置，
    // 否则新页刚加载完就可能被上一页的旧时间戳判定为「早该刷新」
    setRefreshError("")
    lastRefreshAt.current = Date.now()
    // 切页先丢掉上一页的正文根元素，索引轨的观察器与 hash 恢复都只认当前页
    setContentRoot(null)
    pagesApi
      .get(pageId)
      .then((detail) => {
        if (!alive) return
        setPage(detail)
      })
      .catch((loadError: unknown) => {
        if (!alive) return
        if (loadError instanceof ApiError && loadError.status === 404)
          setNotFound(true)
        else setError(describeApiError(loadError))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [pageId])

  /**
   * 原地刷新：重新拉当前文章详情 + 当前空间的页面树，正文与侧栏就地更新。
   * 手动按钮与「切回标签页」共用这一条路径；不复用初载的 loading ——
   * 那会把整页换成骨架屏，刷新只在按钮与提示上体现，正文一直是旧数据。
   */
  const refresh = useCallback(async () => {
    if (!pageId || refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    setRefreshError("")
    lastRefreshAt.current = Date.now()
    try {
      const [detail] = await Promise.all([pagesApi.get(pageId), loadTree()])
      // 刷新途中已经切到别的页面：这次结果作废，别把上一页的正文盖到新页上
      if (pageIdRef.current !== pageId) return
      setPage(detail)
      setNotFound(false)
      // 首屏加载失败留下的 error 会把整页卡在错误段：刷新成功就必须放行正文
      setError("")
    } catch (refreshFailure: unknown) {
      if (pageIdRef.current !== pageId) return
      // 已被别处删除：走现有「页面不存在」处理
      if (refreshFailure instanceof ApiError && refreshFailure.status === 404)
        setNotFound(true)
      // 其余失败只提示：page 保持旧值，正文不会被清空
      else setRefreshError(describeApiError(refreshFailure))
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
  }, [pageId, loadTree])

  // 切回标签页（visibilitychange / focus）刷新一次，与按钮走同一条路径。
  // 编辑态是独立路由页，这里的监听根本不存在，未保存内容不会被冲掉。
  useEffect(() => {
    const maybeRefresh = () => {
      if (document.visibilityState === "hidden") return
      if (Date.now() - lastRefreshAt.current < AUTO_REFRESH_THROTTLE_MS) return
      void refresh()
    }
    document.addEventListener("visibilitychange", maybeRefresh)
    window.addEventListener("focus", maybeRefresh)
    return () => {
      document.removeEventListener("visibilitychange", maybeRefresh)
      window.removeEventListener("focus", maybeRefresh)
    }
  }, [refresh])

  // 深链进来时把侧边栏展开到当前页，树里能直接看到自己在哪
  useEffect(() => {
    if (page) expandTo(page.id)
  }, [page, expandTo])

  // 搜索是全空间范围：点进别的空间的页面时，当前空间跟着切过去，树才对得上。
  // 只在页面首次载入时同步一次，否则用户切换空间会立刻被这页拉回旧空间。
  useEffect(() => {
    if (!page || spacesStatus !== "ready") return
    if (!spaces.some((space) => space.id === page.spaceId)) return
    if (syncedPage.current === page.id) return
    syncedPage.current = page.id
    if (page.spaceId !== currentSpaceId) selectSpace(page.spaceId)
  }, [page, spaces, spacesStatus, currentSpaceId, selectSpace])

  const path = pageId ? findPath(tree, pageId) : []
  const canMoveToSpace =
    canWrite &&
    Boolean(page) &&
    editableSpaces(spaces, isSiteAdmin, page?.spaceId ?? null).length > 0

  if (loading) {
    return (
      <div className="space-y-4" role="status" aria-label="页面加载中">
        <div className="h-7 w-2/5 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/4 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded-xl bg-muted/60" />
      </div>
    )
  }

  if (notFound) {
    return (
      <Empty
        title="页面不存在或已删除"
        description="它可能被移进了回收站，或者链接里的页面 id 不对。"
        contents={
          <Button asChild size="sm" variant="outline">
            <Link to="/">回到首页</Link>
          </Button>
        }
      />
    )
  }

  if (error || !page) {
    return (
      <p
        role="alert"
        className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {error || "页面加载失败"}
      </p>
    )
  }

  return (
    <article className="space-y-4">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/">首页</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {path.map((node, index) => (
            <BreadcrumbItem key={node.id}>
              <BreadcrumbSeparator />
              {index === path.length - 1 ? (
                <BreadcrumbPage className="max-w-[40ch] truncate">
                  {node.title}
                </BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link to={`/p/${node.id}`} className="max-w-[24ch] truncate">
                    {node.title}
                  </Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          ))}
        </BreadcrumbList>
      </Breadcrumb>

      <header className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="font-heading text-[1.75rem] leading-tight font-semibold tracking-tight text-balance break-words">
              {page.title}
            </h1>
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
              更新于 {formatRelative(page.updatedAt)}
              {role === "viewer" ? (
                <Badge variant="secondary" className="text-[10px]">
                  只读成员
                </Badge>
              ) : null}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    aria-label="刷新"
                    aria-busy={refreshing}
                    disabled={refreshing}
                    onClick={() => void refresh()}
                  >
                    <RefreshCw
                      aria-hidden="true"
                      className={cn("size-3.5", refreshing && "animate-spin")}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>刷新</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {canWrite ? (
              <>
                <Button asChild size="sm">
                  <Link to={`/p/${page.id}/edit`}>
                    <Pencil aria-hidden="true" />
                    编辑
                  </Link>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setCreateChildOpen(true)}
                >
                  <Plus aria-hidden="true" />
                  子页面
                </Button>
                {canMoveToSpace ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setMoveOpen(true)}
                  >
                    <ArrowRightLeft aria-hidden="true" />
                    移动到空间
                  </Button>
                ) : null}
              </>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setHistoryOpen(true)}
            >
              <History aria-hidden="true" />
              历史
            </Button>
            {canWrite ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 aria-hidden="true" />
                删除
              </Button>
            ) : null}
          </div>
        </div>
        <Separator />
      </header>

      {refreshError ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {refreshError}
        </p>
      ) : null}

      {page.contentHtml.trim() ? (
        <div className="flex">
          <div className="min-w-0 flex-1">
            <ReadView
              html={page.contentHtml}
              headingIds={headingIds}
              onReady={handleContentReady}
              updateInPlace
            />
          </div>
          <ArticleToc items={toc} contentRoot={contentRoot} />
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            这个页面还是空的。点「编辑」，把 Confluence 里的内容直接粘进来。
          </p>
          <Button asChild size="sm" variant="outline" className="mt-3">
            <Link to={`/p/${page.id}/edit`}>开始编辑</Link>
          </Button>
        </div>
      )}

      <RevisionsDialog
        pageId={page.id}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        readOnly={!canWrite}
        onRestored={(restored) => setPage(restored)}
      />

      <MovePageDialog
        pageId={page.id}
        pageTitle={page.title}
        sourceSpaceId={page.spaceId}
        open={moveOpen}
        onOpenChange={setMoveOpen}
        onMoved={(targetSpaceId) => {
          // 同一 URL 不会触发重新加载：就地改本地详情的空间，再切换当前空间
          setPage((prev) => (prev ? { ...prev, spaceId: targetSpaceId } : prev))
          selectSpace(targetSpaceId)
        }}
      />

      <CreatePageDialog
        open={createChildOpen}
        onOpenChange={setCreateChildOpen}
        parentId={page.id}
        parentTitle={page.title}
        onCreated={() => setCreateChildOpen(false)}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{page.title}」？</AlertDialogTitle>
            <AlertDialogDescription>
              页面与全部子页面会移入回收站，之后可以在回收站里恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                setBusy(true)
                try {
                  await removePage(page.id)
                  navigate("/")
                } catch (deleteError) {
                  setError(describeApiError(deleteError))
                } finally {
                  setBusy(false)
                }
              }}
              disabled={busy}
            >
              移入回收站
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  )
}
