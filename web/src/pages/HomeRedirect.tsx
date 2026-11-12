import { Empty } from "@cloudflare/kumo/components/empty"
import { FilePlus2 } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Navigate, useNavigate } from "react-router"
import { CreatePageDialog } from "@/components/CreatePageDialog"
import { Button } from "@/components/ui/button"
import { useSpaceRole } from "@/hooks/useSpaceRole"
import { pageEditPath, pagePath, spacePath } from "@/lib/routes"
import { canEdit } from "@/lib/space"
import { firstPageId } from "@/lib/tree"
import { usePagesStore } from "@/stores/pages"
import { useSpacesStore } from "@/stores/spaces"

/**
 * `/` 的唯一职责：把入口指到当前空间的 slug 地址（`/s/<slug>`）。
 * 空间列表还没到 / 加载失败 / 一个空间都没有时，沿用首页的骨架与空态，
 * 不在这里另造一套提示。
 */
export function RootRedirect() {
  const spaces = useSpacesStore((state) => state.spaces)
  const currentId = useSpacesStore((state) => state.currentId)
  const current = spaces.find((space) => space.id === currentId) ?? null

  if (current) return <Navigate to={spacePath(current.slug)} replace />
  return <HomeRedirect />
}

/** 空间首页（`/s/:slug`）：跳到页面树里的第一页；一页都没有时给「新建页面」空状态。 */
export function HomeRedirect() {
  const { t } = useTranslation()
  const tree = usePagesStore((state) => state.tree)
  const loading = usePagesStore((state) => state.loading)
  const currentSpaceId = useSpacesStore((state) => state.currentId)
  const canWrite = canEdit(useSpaceRole(currentSpaceId))
  const [createOpen, setCreateOpen] = useState(false)
  const navigate = useNavigate()
  const first = firstPageId(tree)

  if (loading) {
    return (
      <div className="space-y-3" role="status" aria-label={t("page.loading")}>
        <div className="h-7 w-2/5 animate-pulse rounded bg-muted" />
        <div className="h-48 animate-pulse rounded-xl bg-muted/60" />
      </div>
    )
  }

  if (first !== null) return <Navigate to={pagePath(first)} replace />

  return (
    <div className="space-y-4">
      <Empty
        icon={<FilePlus2 />}
        title={t("home.empty.title")}
        description={
          canWrite ? t("home.empty.write") : t("home.empty.readOnly")
        }
        contents={
          canWrite ? (
            <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
              <FilePlus2 aria-hidden="true" />
              {t("shell.newPage")}
            </Button>
          ) : undefined
        }
      />
      {canWrite ? (
        <CreatePageDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          parentId={null}
          onCreated={(page) => navigate(pageEditPath(page.id))}
        />
      ) : null}
    </div>
  )
}
