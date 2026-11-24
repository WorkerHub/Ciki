import { Empty } from "@cloudflare/kumo/components/empty"
import { FileText, UserX } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useParams } from "react-router"
import { UserAvatar } from "@/components/UserAvatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { formatAgentAuthor } from "@/lib/agent-display"
import {
  ApiError,
  describeApiError,
  usersApi,
  type UserPageItem,
  type UserProfile
} from "@/lib/api"
import { formatDate } from "@/lib/format"
import { pagePath, parseIdParam } from "@/lib/routes"

const PAGE_SIZE = 20

export function UserPage() {
  const { t } = useTranslation()
  const params = useParams<{ id: string }>()
  const userId = parseIdParam(params.id)

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [pages, setPages] = useState<UserPageItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)

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
      const [profileData, pagesData] = await Promise.all([
        usersApi.getProfile(userId),
        usersApi.getPages(userId, { page: 1, limit: PAGE_SIZE })
      ])
      setProfile(profileData)
      setPages(pagesData.pages)
      setHasMore(pagesData.hasMore)
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
    try {
      const nextPage = page + 1
      const pagesData = await usersApi.getPages(userId, {
        page: nextPage,
        limit: PAGE_SIZE
      })
      setPages((prev) => [...prev, ...pagesData.pages])
      setPage(nextPage)
      setHasMore(pagesData.hasMore)
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setLoadingMore(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-6" role="status" aria-label={t("user.loading")}>
        <div className="flex flex-col sm:flex-row items-center sm:items-start gap-4">
          <Skeleton className="size-16 rounded-full" />
          <div className="space-y-2 text-center sm:text-left">
            <Skeleton className="h-6 w-36" />
            <Skeleton className="h-4 w-28" />
          </div>
        </div>
        <div className="space-y-3 pt-2">
          <Skeleton className="h-4 w-16" />
          <div className="space-y-2">
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
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

  const author = formatAgentAuthor({
    name: profile.username,
    isAgent: profile.isAgent,
    ownerName: profile.ownerName
  })

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row items-center sm:items-start gap-4">
        <UserAvatar
          user={{
            username: profile.username,
            email: "",
            avatarUrl: profile.avatarUrl
          }}
          className="size-16 text-xl"
        />
        <div className="min-w-0 space-y-1 text-center sm:text-left">
          <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
            <h1 className="font-heading text-xl sm:text-2xl font-semibold tracking-tight text-balance break-words">
              {author.displayName}
            </h1>
            {author.showAgentBadge ? (
              <Badge variant="secondary" className="text-xs">
                Agent
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            {t("user.joinedAt", {
              time: formatDate(profile.createdAt)
            })}
          </p>
        </div>
      </header>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">
            {t("user.pagesTitle")}
          </h2>
        </div>

        {pages.length === 0 ? (
          <Empty
            icon={<FileText />}
            title={t("user.empty.title")}
            description={t("user.empty.description")}
          />
        ) : (
          <div className="space-y-4">
            <ul className="divide-y divide-border rounded-xl border border-border">
              {pages.map((item) => (
                <li key={item.id}>
                  <Link
                    to={pagePath(item.id)}
                    className="block px-4 py-3 transition-colors hover:bg-accent/60"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="flex flex-wrap items-center gap-1.5 font-medium break-words">
                        {item.title || t("page.untitled")}
                        {item.spaceName ? (
                          <Badge
                            variant="outline"
                            className="text-[10px] font-normal"
                          >
                            {item.spaceName}
                          </Badge>
                        ) : null}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatDate(item.updatedAt)}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>

            {hasMore ? (
              <div className="flex justify-center pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? t("user.loading") : t("user.loadMore")}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  )
}
