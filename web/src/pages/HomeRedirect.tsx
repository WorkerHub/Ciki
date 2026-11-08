import { Empty } from "@cloudflare/kumo/components/empty"
import { FilePlus2 } from "lucide-react"
import { useState } from "react"
import { Navigate, useNavigate } from "react-router"
import { CreatePageDialog } from "@/components/CreatePageDialog"
import { Button } from "@/components/ui/button"
import { firstPageId } from "@/lib/tree"
import { canEdit } from "@/lib/space"
import { useSpaceRole } from "@/hooks/useSpaceRole"
import { usePagesStore } from "@/stores/pages"
import { useSpacesStore } from "@/stores/spaces"

/** 首页：跳到页面树里的第一页；一页都没有时给「新建页面」空状态。 */
export function HomeRedirect() {
  const tree = usePagesStore((state) => state.tree)
  const loading = usePagesStore((state) => state.loading)
  const currentSpaceId = useSpacesStore((state) => state.currentId)
  const canWrite = canEdit(useSpaceRole(currentSpaceId))
  const [createOpen, setCreateOpen] = useState(false)
  const navigate = useNavigate()
  const first = firstPageId(tree)

  if (loading) {
    return (
      <div className="space-y-3" role="status" aria-label="页面加载中">
        <div className="h-7 w-2/5 animate-pulse rounded bg-muted" />
        <div className="h-48 animate-pulse rounded-xl bg-muted/60" />
      </div>
    )
  }

  if (first) return <Navigate to={`/p/${first}`} replace />

  return (
    <div className="space-y-4">
      <Empty
        icon={<FilePlus2 />}
        title="还没有页面"
        description={
          canWrite
            ? "新建一个页面，或者直接把 Confluence 里的内容粘贴进编辑器。"
            : "你在这个空间是只读成员，可以让空间管理员添加页面。"
        }
        contents={
          canWrite ? (
            <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
              <FilePlus2 aria-hidden="true" />
              新建页面
            </Button>
          ) : undefined
        }
      />
      {canWrite ? (
        <CreatePageDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          parentId={null}
          onCreated={(page) => navigate(`/p/${page.id}/edit`)}
        />
      ) : null}
    </div>
  )
}
