import { Empty } from "@cloudflare/kumo/components/empty"
import { SearchX } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useSearchParams } from "react-router"
import { SearchBox } from "@/components/SearchBox"
import { Badge } from "@/components/ui/badge"
import { describeApiError, type SearchResponse, searchApi } from "@/lib/api"
import { formatRelative } from "@/lib/format"
import { pagePath } from "@/lib/routes"

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** 把命中词包成 <mark>（纯文本片段，不注入 HTML）。 */
function highlight(text: string, query: string) {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
  if (!tokens.length) return text
  const pattern = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi")
  return text.split(pattern).map((part, index) =>
    pattern.test(part) ? (
      <mark
        // biome-ignore lint/suspicious/noArrayIndexKey: 片段本身没有稳定 id
        key={index}
        className="rounded bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-400/30"
      >
        {part}
      </mark>
    ) : (
      <span
        // biome-ignore lint/suspicious/noArrayIndexKey: 同上
        key={index}
      >
        {part}
      </span>
    )
  )
}

export function SearchPage() {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const query = (params.get("q") ?? "").trim()
  const [data, setData] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!query) {
      setData(null)
      setError("")
      return
    }
    let alive = true
    setLoading(true)
    setError("")
    searchApi
      .query(query)
      .then((response) => {
        if (alive) setData(response)
      })
      .catch((searchError: unknown) => {
        if (alive) setError(describeApiError(searchError))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [query])

  return (
    <div className="space-y-4">
      <SearchBox className="md:hidden" />
      <header className="space-y-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          {t("search.title")}
        </h1>
        <p className="text-xs text-muted-foreground">
          {query
            ? t("search.subtitleWithQuery", { query })
            : t("search.subtitle")}
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {loading ? (
        <div
          className="space-y-2"
          role="status"
          aria-label={t("search.loadingLabel")}
        >
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="h-16 animate-pulse rounded-lg bg-muted/60"
            />
          ))}
        </div>
      ) : !query ? (
        <Empty
          icon={<SearchX />}
          title={t("search.empty.title")}
          description={t("search.empty.description")}
        />
      ) : data && data.results.length === 0 ? (
        <Empty
          icon={<SearchX />}
          title={t("search.noResults.title")}
          description={t("search.noResults.description")}
        />
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {data?.results.map((result) => (
            <li key={result.pageId}>
              <Link
                to={pagePath(result.pageId)}
                className="block px-4 py-3 transition-colors hover:bg-accent/60"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-1.5 font-medium">
                    {highlight(result.title, query)}
                    {result.spaceName ? (
                      <Badge
                        variant="outline"
                        className="text-[10px] font-normal"
                      >
                        {result.spaceName}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {formatRelative(result.updatedAt)}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {highlight(result.snippet, query)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
