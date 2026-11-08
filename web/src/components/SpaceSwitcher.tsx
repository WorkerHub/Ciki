import { cn } from "cn"
import { Boxes, Check, ChevronsUpDown, Plus, Settings } from "lucide-react"
import { useEffect, useState } from "react"
import { useNavigate } from "react-router"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { describeApiError } from "@/lib/api"
import { canManage, effectiveRole, SPACE_ROLE_LABELS } from "@/lib/space"
import { useAuthStore } from "@/stores/auth"
import { useSpacesStore } from "@/stores/spaces"

/**
 * 侧栏顶部的空间切换器：列出当前用户可见的空间（后端已按成员资格过滤），
 * 底部固定「空间设置」（仅空间管理员 / 站点管理员）与「新建空间」（所有人可建）。
 * 切换空间后回首页，由 AppShell 按新空间重拉页面树。
 */
export function SpaceSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate()
  const spaces = useSpacesStore((state) => state.spaces)
  const status = useSpacesStore((state) => state.status)
  const error = useSpacesStore((state) => state.error)
  const currentId = useSpacesStore((state) => state.currentId)
  const select = useSpacesStore((state) => state.select)
  const load = useSpacesStore((state) => state.load)
  const create = useSpacesStore((state) => state.create)
  const isSiteAdmin = useAuthStore((state) => state.user?.role === "admin")
  const current = spaces.find((space) => space.id === currentId) ?? null
  const currentRole = current ? effectiveRole(current, isSiteAdmin) : null

  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [busy, setBusy] = useState(false)
  const [createError, setCreateError] = useState("")

  useEffect(() => {
    if (createOpen) {
      setName("")
      setDescription("")
      setCreateError("")
    }
  }, [createOpen])

  const switchTo = (id: string) => {
    if (id !== currentId) select(id)
    onNavigate?.()
    // 空间换了，首页会跳到新空间的第一页；不留在旧空间的页面上
    navigate("/")
  }

  const submitCreate = async () => {
    const value = name.trim()
    if (!value) {
      setCreateError("请填写空间名称")
      return
    }
    setBusy(true)
    setCreateError("")
    try {
      await create(value, description.trim())
      setCreateOpen(false)
      onNavigate?.()
      navigate("/")
    } catch (submitError) {
      setCreateError(describeApiError(submitError))
    } finally {
      setBusy(false)
    }
  }

  if (status === "error" && spaces.length === 0) {
    return (
      <div className="mx-2 space-y-1 rounded-md border border-border px-2 py-2">
        <p className="text-[11px] text-muted-foreground">空间列表加载失败</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => void load()}
        >
          重试
        </Button>
      </div>
    )
  }

  return (
    <div className="px-2 pb-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            aria-label="切换空间"
            title={error ?? undefined}
            className="h-auto w-full justify-between gap-1.5 px-2 py-1.5"
          >
            <Boxes
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-left text-[13px] font-medium">
              {current?.name ??
                (status === "loading" ? "加载空间…" : "没有空间")}
            </span>
            {current ? (
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                {SPACE_ROLE_LABELS[currentRole ?? "viewer"]}
              </Badge>
            ) : null}
            <ChevronsUpDown
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-[11px] text-muted-foreground">
            切换空间
          </DropdownMenuLabel>
          {spaces.map((space) => {
            const active = space.id === currentId
            return (
              <DropdownMenuItem
                key={space.id}
                onSelect={() => switchTo(space.id)}
                className="gap-2"
              >
                <Check
                  className={cn(
                    "size-3.5 shrink-0",
                    active ? "opacity-100" : "opacity-0"
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">{space.name}</span>
                {space.isDefault ? (
                  <Badge variant="outline" className="text-[10px]">
                    默认
                  </Badge>
                ) : null}
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {SPACE_ROLE_LABELS[effectiveRole(space, isSiteAdmin)]}
                </span>
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuSeparator />
          {current && canManage(currentRole) ? (
            <DropdownMenuItem
              onSelect={() => {
                onNavigate?.()
                navigate(`/spaces/${current.id}/settings`)
              }}
            >
              <Settings aria-hidden="true" />
              空间设置
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
            <Plus aria-hidden="true" />
            新建空间
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建空间</DialogTitle>
            <DialogDescription>
              空间是一组页面与成员。创建后你是这个空间的管理员。
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              void submitCreate()
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="new-space-name">空间名称</Label>
              <Input
                id="new-space-name"
                name="space-name"
                autoFocus
                maxLength={64}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：支付团队"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-space-description">描述（可选）</Label>
              <Textarea
                id="new-space-description"
                name="space-description"
                maxLength={500}
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="这个空间用来放什么内容"
              />
            </div>
            {createError ? (
              <p role="alert" className="text-xs text-destructive">
                {createError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setCreateOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "创建中…" : "创建空间"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
