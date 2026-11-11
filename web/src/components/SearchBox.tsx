import { Search } from "lucide-react"
import { useEffect, useState } from "react"
import { useNavigate, useSearchParams } from "react-router"
import { Input } from "@/components/ui/input"
import { spaceSearchPath } from "@/lib/routes"
import { useSpacesStore } from "@/stores/spaces"

/** 顶栏搜索框：提交后进结果页（结果页自己读 ?q= 发起请求）。 */
export function SearchBox({ className }: { className?: string }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const spaces = useSpacesStore((state) => state.spaces)
  const currentSpaceId = useSpacesStore((state) => state.currentId)
  const slug = spaces.find((space) => space.id === currentSpaceId)?.slug ?? null
  const [value, setValue] = useState(params.get("q") ?? "")

  useEffect(() => {
    setValue(params.get("q") ?? "")
  }, [params])

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        const query = value.trim()
        // 空间列表还没到（或一个空间都没有）时没有可去的 slug，先不跳转
        if (!slug) return
        navigate(spaceSearchPath(slug, query))
      }}
    >
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          name="q"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="搜索标题与正文…"
          aria-label="搜索页面"
          className="h-8 pl-8"
        />
      </div>
    </form>
  )
}
