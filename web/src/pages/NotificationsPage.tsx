import { Empty } from "@cloudflare/kumo/components/empty"
import { Bell, CheckCheck, ChevronLeft, ChevronRight } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import { UserAvatar } from "@/components/UserAvatar"
import { Button } from "@/components/ui/button"
import {
  ApiError,
  commentsApi,
  isNotificationRead,
  type NotificationDto,
  notificationsApi,
  pagesApi
} from "@/lib/api"
import { formatRelative } from "@/lib/format"
import { pagePath } from "@/lib/routes"
import { cn } from "@/lib/utils"
import { useNotificationStore } from "@/stores/notifications"

const PAGE_SIZE = 20

export function NotificationsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<NotificationDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [markingAll, setMarkingAll] = useState(false)

  const unreadCount = useNotificationStore((state) => state.unreadCount)
  const markAllRead = useNotificationStore((state) => state.markAllRead)
  const markRead = useNotificationStore((state) => state.markRead)

  const loadNotifications = useCallback(
    async (pageNumber: number) => {
      setLoading(true)
      setError("")
      try {
        const offset = (pageNumber - 1) * PAGE_SIZE
        const res = await notificationsApi.list({ limit: PAGE_SIZE, offset })
        setItems(res.items)
      } catch {
        setError(t("notifications.loading"))
      } finally {
        setLoading(false)
      }
    },
    [t]
  )

  useEffect(() => {
    void loadNotifications(page)
  }, [page, loadNotifications])

  async function handleItemClick(item: NotificationDto) {
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

      navigate(`${pagePath(item.pageId)}#comment-${item.commentId}`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        toast(t("notifications.pageDeleted"))
        return
      }
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
    } finally {
      setMarkingAll(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {t("notifications.title")}
          </h1>
          {unreadCount > 0 ? (
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              {t("notifications.unreadCount", { count: unreadCount })}
            </p>
          ) : null}
        </div>
        {unreadCount > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={markingAll}
            onClick={() => void handleMarkAllRead()}
          >
            <CheckCheck className="size-4 mr-1.5" aria-hidden="true" />
            {t("notifications.markAllRead")}
          </Button>
        ) : null}
      </div>

      {loading ? (
        <div className="space-y-3" role="status">
          <div className="h-16 animate-pulse rounded-lg bg-muted/60" />
          <div className="h-16 animate-pulse rounded-lg bg-muted/60" />
          <div className="h-16 animate-pulse rounded-lg bg-muted/60" />
        </div>
      ) : error ? (
        <div className="flex items-center justify-between rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
          <span>{error}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void loadNotifications(page)}
          >
            {t("common.retry")}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <Empty
          icon={<Bell className="size-8 text-muted-foreground" />}
          title={t("notifications.empty")}
        />
      ) : (
        <div className="divide-y divide-border/50 rounded-lg border border-border bg-card">
          {items.map((item) => {
            const read = isNotificationRead(item)
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => void handleItemClick(item)}
                className={cn(
                  "flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-muted/40 cursor-pointer",
                  !read && "bg-primary/5 hover:bg-primary/10"
                )}
              >
                <UserAvatar
                  user={{
                    username: item.actorName,
                    email: "",
                    avatarUrl: item.actorAvatarUrl
                  }}
                  className="mt-0.5 size-8 shrink-0 text-xs"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate font-medium text-foreground">
                      {item.actorName}
                    </span>
                    <time className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatRelative(item.createdAt)}
                    </time>
                  </div>
                  <div className="text-sm text-muted-foreground">
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
                    className="mt-2 size-2.5 shrink-0 rounded-full bg-primary"
                    aria-hidden="true"
                  />
                )}
              </button>
            )
          })}
        </div>
      )}

      {!loading && !error && (items.length > 0 || page > 1) ? (
        <div className="flex items-center justify-between pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page === 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="size-4 mr-1" aria-hidden="true" />
            {t("notifications.prevPage")}
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {t("notifications.pageInfo", { page })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={items.length < PAGE_SIZE || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("notifications.nextPage")}
            <ChevronRight className="size-4 ml-1" aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
