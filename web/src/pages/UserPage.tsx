import { Empty } from "@cloudflare/kumo/components/empty"
import {
  FileEdit,
  FilePlus,
  MessageSquare,
  Sparkles,
  UserX
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useParams } from "react-router"
import { toast } from "sonner"
import { UserAvatar } from "@/components/UserAvatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger
} from "@/components/ui/hover-card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ApiError,
  describeApiError,
  usersApi,
  type UserActivityEvent,
  type UserActivityType,
  type UserProfile
} from "@/lib/api"
import { formatDate, formatRelative } from "@/lib/format"
import { pagePath, parseIdParam, userPath } from "@/lib/routes"

const PAGE_SIZE = 10

function getActivityTypeConfig(
  type: UserActivityType,
  t: (key: string) => string
) {
  switch (type) {
    case "page_created":
      return {
        icon: (
          <FilePlus className="size-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
        ),
        label: t("user.types.pageCreated")
      }
    case "page_edited":
      return {
        icon: (
          <FileEdit className="size-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
        ),
        label: t("user.types.pageEdited")
      }
    case "comment":
      return {
        icon: (
          <MessageSquare className="size-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
        ),
        label: t("user.types.comment")
      }
  }
}

export function UserPage() {
  const { t } = useTranslation()
  const params = useParams<{ id: string }>()
  const userId = parseIdParam(params.id)

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [events, setEvents] = useState<UserActivityEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [hoverCardOpen, setHoverCardOpen] = useState(false)

  const fetchData = useCallback(async () => {
    if (userId === null) {
      setNotFound(true)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    setNotFound(false)

    try {
      const [profileData, activityData] = await Promise.all([
        usersApi.getProfile(userId),
        usersApi.getActivity(userId, { page: 1, limit: PAGE_SIZE })
      ])
      setProfile(profileData)
      setEvents(activityData.events)
      setHasMore(activityData.hasMore)
      setPage(1)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true)
      } else {
        setError(describeApiError(err))
      }
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  const handleLoadMore = async () => {
    if (userId === null || loadingMore || !hasMore) return
    setLoadingMore(true)
    setLoadMoreError(null)
    try {
      const nextPage = page + 1
      const activityData = await usersApi.getActivity(userId, {
        page: nextPage,
        limit: PAGE_SIZE
      })
      setEvents((prev) => [...prev, ...activityData.events])
      setPage(nextPage)
      setHasMore(activityData.hasMore)
    } catch (err) {
      const message = describeApiError(err)
      setLoadMoreError(message)
      toast.error(message)
    } finally {
      setLoadingMore(false)
    }
  }

  if (loading) {
    return (
      <div
        className="flex flex-col gap-6 lg:flex-row lg:items-start"
        role="status"
        aria-label={t("user.loading")}
      >
        <div className="min-w-0 flex-1 space-y-4 order-2 lg:order-1">
          <Skeleton className="h-6 w-20" />
          <div className="space-y-3">
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        </div>
        <div className="w-full lg:w-72 shrink-0 order-1 lg:order-2">
          <div className="rounded-xl border border-border p-6 space-y-4">
            <div className="flex flex-col items-center space-y-3">
              <Skeleton className="size-20 rounded-full" />
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-44" />
            </div>
            <div className="grid grid-cols-2 gap-2 border-t border-border pt-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
            <Skeleton className="h-4 w-28 mx-auto" />
          </div>
        </div>
      </div>
    )
  }

  if (notFound) {
    return (
      <Empty
        icon={<UserX />}
        title={t("user.notFound.title")}
        description={t("user.notFound.description")}
        contents={
          <Button asChild size="sm" variant="outline">
            <Link to="/">{t("page.backHome")}</Link>
          </Button>
        }
      />
    )
  }

  if (error || !profile) {
    return (
      <div className="space-y-4">
        <p
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error || t("user.loadFailed")}
        </p>
        <Button variant="outline" size="sm" onClick={fetchData}>
          {t("common.retry")}
        </Button>
      </div>
    )
  }

  const hasOwner = Boolean(profile.ownerName?.trim() && profile.ownerId != null)

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* 左主栏：动态流（Activity） */}
      <section className="min-w-0 flex-1 space-y-4 order-2 lg:order-1">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight">
            {t("user.activityTitle")}
          </h2>
        </div>

        {events.length === 0 ? (
          <Empty
            icon={<Sparkles />}
            title={t("user.empty.title")}
            description={t("user.empty.description")}
          />
        ) : (
          <div className="space-y-4">
            <ul className="divide-y divide-border rounded-xl border border-border">
              {events.map((item) => {
                const targetUrl =
                  item.type === "comment" && item.commentId
                    ? `${pagePath(item.pageId)}#comment-${item.commentId}`
                    : pagePath(item.pageId)

                const typeConfig = getActivityTypeConfig(item.type, t)

                return (
                  <li key={item.id}>
                    <Link
                      to={targetUrl}
                      className="block px-4 py-3.5 transition-colors hover:bg-accent/60"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1 font-medium text-foreground">
                              {typeConfig.icon}
                              <span>{typeConfig.label}</span>
                            </span>
                            {item.spaceName ? (
                              <Badge
                                variant="outline"
                                className="text-[10px] font-normal"
                              >
                                {item.spaceName}
                              </Badge>
                            ) : null}
                          </div>
                          <p className="text-sm font-medium text-foreground break-words line-clamp-1">
                            {item.pageTitle || t("page.untitled")}
                          </p>
                          {item.type === "comment" && item.excerpt ? (
                            <p className="text-xs text-muted-foreground line-clamp-2 break-words bg-muted/40 rounded px-2.5 py-1 mt-1 border border-border/50">
                              {item.excerpt}
                            </p>
                          ) : null}
                        </div>
                        <time
                          dateTime={item.createdAt}
                          className="shrink-0 text-xs text-muted-foreground tabular-nums pt-0.5"
                        >
                          {formatRelative(item.createdAt)}
                        </time>
                      </div>
                    </Link>
                  </li>
                )
              })}
            </ul>

            {hasMore ? (
              <div className="flex flex-col items-center gap-2 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? t("user.loading") : t("user.loadMore")}
                </Button>
                {loadMoreError ? (
                  <p className="text-xs text-destructive">{loadMoreError}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </section>

      {/* 右栏：个人卡 */}
      <aside className="w-full lg:w-72 shrink-0 order-1 lg:order-2">
        <Card className="w-full">
          <CardContent className="pt-6 space-y-4">
            <div className="flex flex-col items-center text-center space-y-3">
              <UserAvatar
                user={{
                  username: profile.username,
                  email: "",
                  avatarUrl: profile.avatarUrl
                }}
                className="size-20 text-2xl"
              />
              <div className="space-y-1 w-full min-w-0">
                {profile.isAgent ? (
                  <HoverCard
                    open={hoverCardOpen}
                    onOpenChange={setHoverCardOpen}
                  >
                    <HoverCardTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex cursor-pointer flex-wrap items-center justify-center gap-1.5 focus-visible:outline-hidden"
                        onClick={() => setHoverCardOpen((prev) => !prev)}
                        onTouchEnd={(e) => {
                          e.preventDefault()
                          setHoverCardOpen((prev) => !prev)
                        }}
                      >
                        <h1 className="font-heading text-lg font-semibold tracking-tight break-words">
                          {profile.username}
                        </h1>
                        <Badge variant="secondary" className="text-xs">
                          Agent
                        </Badge>
                      </button>
                    </HoverCardTrigger>
                    <HoverCardContent
                      align="center"
                      sideOffset={6}
                      className="w-auto max-w-xs text-center text-sm"
                    >
                      {hasOwner ? (
                        <p className="text-sm text-foreground">
                          <Link
                            to={userPath(profile.ownerId!)}
                            className="font-medium text-foreground underline underline-offset-4 hover:text-primary"
                          >
                            {profile.ownerName?.trim()}
                          </Link>
                          <span>{t("user.agentOf")}</span>
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {t("user.deletedUserAgent")}
                        </p>
                      )}
                    </HoverCardContent>
                  </HoverCard>
                ) : (
                  <div className="flex flex-wrap items-center justify-center gap-1.5">
                    <h1 className="font-heading text-lg font-semibold tracking-tight break-words">
                      {profile.username}
                    </h1>
                  </div>
                )}
                {profile.bio ? (
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words pt-1">
                    {profile.bio}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 border-t border-border pt-4 text-center">
              <div className="space-y-0.5">
                <div className="text-xl font-semibold tracking-tight tabular-nums">
                  {profile.docCount}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t("user.stats.docs")}
                </div>
              </div>
              <div className="space-y-0.5 border-l border-border">
                <div className="text-xl font-semibold tracking-tight tabular-nums">
                  {profile.commentCount}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t("user.stats.comments")}
                </div>
              </div>
            </div>

            <div className="border-t border-border pt-3 text-center">
              <p className="text-xs text-muted-foreground tabular-nums">
                {t("user.joinedAt", {
                  time: formatDate(profile.createdAt)
                })}
              </p>
            </div>
          </CardContent>
        </Card>
      </aside>
    </div>
  )
}
