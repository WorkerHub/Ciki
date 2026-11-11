import { useEffect } from "react"
import { Outlet, useParams } from "react-router"
import { Button } from "@/components/ui/button"
import { spaceBySlug } from "@/lib/space"
import { NotFound } from "@/pages/NotFound"
import { useSpacesStore } from "@/stores/spaces"

/** 空间列表还没到 / 正在切空间时的骨架：内容页在此之前一律不渲染。 */
function SpaceSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-label="空间加载中">
      <div className="h-7 w-2/5 animate-pulse rounded bg-muted" />
      <div className="h-48 animate-pulse rounded-xl bg-muted/60" />
    </div>
  )
}

/**
 * `/s/:slug/*` 的网关：URL 里的 slug 是空间上下文的唯一入口形态。
 *
 * 顺序很要紧——先把当前空间切到 slug 对应的那个，再渲染子页。子页（回收站、
 * 搜索、空间设置）都按 store 里的当前空间取数，提前渲染会让它们先拿上一个
 * 空间的数据请求一次、再闪一下换成新空间。所以 currentId 没对齐时只给骨架，
 * 对齐由下面的 effect 完成、下一次渲染才放行。
 */
export function SpaceRoute() {
  const { slug } = useParams<{ slug: string }>()
  const spaces = useSpacesStore((state) => state.spaces)
  const status = useSpacesStore((state) => state.status)
  const error = useSpacesStore((state) => state.error)
  const currentId = useSpacesStore((state) => state.currentId)
  const select = useSpacesStore((state) => state.select)
  const load = useSpacesStore((state) => state.load)

  const space = spaceBySlug(spaces, slug ?? "")

  useEffect(() => {
    if (space && space.id !== currentId) select(space.id)
  }, [space, currentId, select])

  if (spaces.length === 0) {
    if (status === "error") {
      return (
        <div className="space-y-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <p role="alert">{error ?? "空间列表加载失败"}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void load()}
          >
            重试
          </Button>
        </div>
      )
    }
    return <SpaceSkeleton />
  }

  // 列表已到但没有这个 slug：要么空间不存在，要么「我」已不是它的成员——
  // 与后端的过滤口径一致，两者都按不存在处理。
  if (!space) return <NotFound />
  if (space.id !== currentId) return <SpaceSkeleton />

  return <Outlet />
}
