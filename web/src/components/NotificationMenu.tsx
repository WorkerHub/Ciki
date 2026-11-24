import { Bell, CheckCheck } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import { UserAvatar } from "@/components/UserAvatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import {
  ApiError,
  commentsApi,
  isNotificationRead,
  type NotificationDto,
  notificationsApi,
  pagesApi
} from "@/lib/api"
import { formatRelative } from "@/lib/format"
import { notificationsPath, pagePath } from "@/lib/routes"
import { cn } from "@/lib/utils"
import {
  useNotificationPolling,
  useNotificationStore
} from "@/stores/notifications"

export function NotificationMenu() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationDto[]>([])
  const [loading, setLoading] = useState(false)
  const [markingAll, setMarkingAll] = useState(false)

  const unreadCount = useNotificationStore((state) => state.unreadCount)
  const markAllRead = useNotificationStore((state) => state.markAllRead)
  const markRead = useNotificationStore((state) => state.markRead)

  // 启动后台轮询策略
  useNotificationPolling(true)

  const loadRecent = useCallback(async () => {
    setLoading(true)
    try {
      const res = await notificationsApi.list({ limit: 10, offset: 0 })
      setItems(res.items)
    } catch {
      // 静默失败，保持原有列表
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      void loadRecent()
    }
  }, [open, loadRecent])

  async function handleItemClick(item: NotificationDto) {
    // 1. 立即标记已读并更新本地状态
    if (!isNotificationRead(item)) {
      setItems((prev) =>
        prev.map((n) =>
          n.id === item.id
            ? { ...n, read: true, readAt: new Date().toISOString() }
            : n
        )
      )
      void markRead(item.id).catch(() => {})
    }

    // 2. 检查目标文档及评论是否存在
    try {
      const [_, commentList] = await Promise.all([
        pagesApi.get(item.pageId),
        commentsApi.list(item.pageId)
      ])

      let exists = false
      for (const thread of commentList.threads) {
        if (thread.id === item.commentId && !thread.deletedAt) {
          exists = true
          break
        }
        for (const reply of thread.replies) {
          if (reply.id === item.commentId && !reply.deletedAt) {
            exists = true
            break
          }
        }
        if (exists) break
      }

      if (!exists) {
        toast(t("notifications.commentDeleted"))
        return
      }

      setOpen(false)
      navigate(`${pagePath(item.pageId)}#comment-${item.commentId}`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        toast(t("notifications.pageDeleted"))
        return
      }
      setOpen(false)
      navigate(`${pagePath(item.pageId)}#comment-${item.commentId}`)
    }
  }

  async function handleMarkAllRead() {
    if (unreadCount === 0 || markingAll) return
    setMarkingAll(true)
    try {
      await markAllRead()
      setItems((prev) =>
        prev.map((n) => ({
          ...n,
          read: true,
          readAt: new Date().toISOString()
        }))
      )
    } catch {
      // 失败留给用户重试
    } finally {
      setMarkingAll(false)
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="relative text-muted-foreground hover:text-foreground"
          aria-label={t("notifications.bell")}
        >
          <Bell className="size-4" aria-hidden="true" />
          {unreadCount > 0 && (
            <span
              data-testid="unread-badge"
              className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground tabular-nums leading-none"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="w-[calc(100vw-2rem)] max-w-sm p-0 sm:w-96 shadow-lg border border-border"
      >
        <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
          <span className="text-sm font-semibold text-foreground">
            {t("notifications.title")}
          </span>
          {unreadCount > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {t("notifications.unreadCount", { count: unreadCount })}
            </span>
          )}
        </div>

        <div className="max-h-80 overflow-y-auto divide-y divide-border/40">
          {loading && items.length === 0 ? (
            <div className="space-y-2 p-3">
              <div className="h-12 animate-pulse rounded bg-muted/60" />
              <div className="h-12 animate-pulse rounded bg-muted/60" />
            </div>
          ) : items.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              {t("notifications.empty")}
            </div>
          ) : (
            items.map((item) => {
              const read = isNotificationRead(item)
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void handleItemClick(item)}
                  className={cn(
                    "flex w-full items-start gap-2.5 p-3 text-left transition-colors hover:bg-muted/50 cursor-pointer",
                    !read && "bg-primary/5 hover:bg-primary/10"
                  )}
                >
                  <UserAvatar
                    user={{
                      username: item.actorName,
                      email: "",
                      avatarUrl: item.actorAvatarUrl
                    }}
                    className="mt-0.5 size-7 shrink-0 text-xs"
                  />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center justify-between gap-1 text-xs">
                      <span className="truncate font-medium text-foreground">
                        {item.actorName}
                      </span>
                      <time className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                        {formatRelative(item.createdAt)}
                      </time>
                    </div>
                    <div className="text-xs text-muted-foreground line-clamp-1">
                      {item.type === "reply"
                        ? t("notifications.replied")
                        : t("notifications.commented")}{" "}
                      <span className="font-medium text-foreground">
                        {item.pageTitle}
                      </span>
                    </div>
                    {item.excerpt ? (
                      <p className="line-clamp-2 text-xs text-muted-foreground/80 break-words">
                        {item.excerpt}
                      </p>
                    ) : null}
                  </div>
                  {!read && (
                    <span
                      className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
                      aria-hidden="true"
                    />
                  )}
                </button>
              )
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border bg-muted/20 px-2 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            disabled={unreadCount === 0 || markingAll}
            onClick={() => void handleMarkAllRead()}
          >
            <CheckCheck className="size-3.5 mr-1" aria-hidden="true" />
            {t("notifications.markAllRead")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              setOpen(false)
              navigate(notificationsPath())
            }}
          >
            {t("notifications.viewAll")}
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
