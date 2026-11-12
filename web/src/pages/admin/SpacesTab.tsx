import { Empty } from "@cloudflare/kumo/components/empty"
import { Boxes, ExternalLink } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"
import { type AdminSpace, adminApi, describeApiError } from "@/lib/api"
import { formatDate } from "@/lib/format"
import { spaceSettingsPath } from "@/lib/routes"

/** 系统管理 · 空间总览：站点管理员看全部空间的成员与页面统计。 */
export function SpacesTab() {
  const [spaces, setSpaces] = useState<AdminSpace[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const { t } = useTranslation()

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      setSpaces(await adminApi.spaces())
    } catch (loadError) {
      setError(describeApiError(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">{t("admin.spaces.title")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("admin.spaces.description")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void load()}
          disabled={loading}
        >
          {t("admin.common.refresh")}
        </Button>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {loading && spaces.length === 0 ? (
        <div
          className="space-y-2"
          role="status"
          aria-label={t("admin.spaces.loadingLabel")}
        >
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-11 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : spaces.length === 0 ? (
        <Empty
          icon={<Boxes />}
          title={t("admin.spaces.emptyTitle")}
          description={t("admin.spaces.emptyDescription")}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin.spaces.table.space")}</TableHead>
                <TableHead className="w-40">
                  {t("admin.spaces.table.description")}
                </TableHead>
                <TableHead className="w-20 text-right">
                  {t("admin.spaces.table.members")}
                </TableHead>
                <TableHead className="w-20 text-right">
                  {t("admin.spaces.table.pages")}
                </TableHead>
                <TableHead className="w-24 text-right">
                  {t("admin.spaces.table.trashed")}
                </TableHead>
                <TableHead className="w-28">
                  {t("admin.spaces.table.createdAt")}
                </TableHead>
                <TableHead className="w-24 text-right">
                  {t("common.table.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {spaces.map((space) => (
                <TableRow key={space.id}>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-1.5 font-medium">
                      {space.name}
                      {space.isDefault ? (
                        <Badge variant="outline" className="text-[10px]">
                          {t("admin.spaces.default")}
                        </Badge>
                      ) : null}
                    </span>
                    {space.slug ? (
                      <span className="block font-mono text-[11px] text-muted-foreground">
                        /s/{space.slug}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-[12rem] truncate text-xs text-muted-foreground">
                    {space.description || "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {space.memberCount}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {space.pageCount}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {space.trashedPageCount}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(space.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {/* 空间设置按 slug 寻址；后端没给 slug 时不给死链 */}
                    {space.slug ? (
                      <Button asChild size="sm" variant="ghost">
                        <Link to={spaceSettingsPath(space.slug)}>
                          <ExternalLink aria-hidden="true" />
                          {t("shell.spaces.settings")}
                        </Link>
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}
