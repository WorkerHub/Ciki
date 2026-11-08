import type { FormEvent } from "react"
import { Empty } from "@cloudflare/kumo/components/empty"
import {
  ArrowLeft,
  Settings2,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import {
  ApiError,
  describeApiError,
  pagesApi,
  type Space,
  type SpaceCandidate,
  type SpaceMember,
  type SpaceRole,
  spacesApi
} from "@/lib/api"
import { formatDate } from "@/lib/format"
import { canManage, effectiveRole, SPACE_ROLE_LABELS } from "@/lib/space"
import { countNodes } from "@/lib/tree"
import { useAuthStore } from "@/stores/auth"
import { useSpacesStore } from "@/stores/spaces"

const ROLE_OPTIONS: SpaceRole[] = ["admin", "editor", "viewer"]

/**
 * 空间设置：名称 / 描述、成员管理、删除空间。
 * 只有空间 admin（含站点管理员）能打开；editor 与 viewer 直接给无权空状态。
 * 页面数量由前端用页面树 + 回收站现算（Space DTO 不含统计字段）。
 */
export function SpaceSettingsPage() {
  const { spaceId } = useParams<{ spaceId: string }>()
  const navigate = useNavigate()
  const isSiteAdmin = useAuthStore((state) => state.user?.role === "admin")
  const upsertSpace = useSpacesStore((state) => state.upsert)
  const removeSpace = useSpacesStore((state) => state.remove)

  const [space, setSpace] = useState<Space | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [notFound, setNotFound] = useState(false)

  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [savingInfo, setSavingInfo] = useState(false)
  const [infoError, setInfoError] = useState("")
  const [infoMessage, setInfoMessage] = useState("")

  const [members, setMembers] = useState<SpaceMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [membersError, setMembersError] = useState("")
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<SpaceMember | null>(null)

  const [candidateQuery, setCandidateQuery] = useState("")
  const [candidateRole, setCandidateRole] = useState<SpaceRole>("editor")
  const [candidates, setCandidates] = useState<SpaceCandidate[]>([])
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  const [candidateError, setCandidateError] = useState("")
  const [addingId, setAddingId] = useState<string | null>(null)

  const [pageCount, setPageCount] = useState(0)
  const [trashedCount, setTrashedCount] = useState(0)
  const [countsLoading, setCountsLoading] = useState(false)
  const [countsError, setCountsError] = useState("")

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState("")

  const loadSpace = useCallback(async () => {
    if (!spaceId) return
    setLoading(true)
    setLoadError("")
    setNotFound(false)
    try {
      const detail = await spacesApi.get(spaceId)
      setSpace(detail)
      setName(detail.name)
      setDescription(detail.description)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) setNotFound(true)
      else setLoadError(describeApiError(error))
    } finally {
      setLoading(false)
    }
  }, [spaceId])

  const loadMembers = useCallback(async () => {
    if (!spaceId) return
    setMembersLoading(true)
    setMembersError("")
    try {
      setMembers(await spacesApi.members(spaceId))
    } catch (error) {
      setMembersError(describeApiError(error))
    } finally {
      setMembersLoading(false)
    }
  }, [spaceId])

  const loadCounts = useCallback(async () => {
    if (!spaceId) return
    setCountsLoading(true)
    setCountsError("")
    try {
      const [tree, trash] = await Promise.all([
        pagesApi.tree(spaceId),
        pagesApi.trash(spaceId)
      ])
      setPageCount(countNodes(tree))
      setTrashedCount(trash.length)
    } catch (error) {
      setCountsError(describeApiError(error))
    } finally {
      setCountsLoading(false)
    }
  }, [spaceId])

  useEffect(() => {
    void loadSpace()
  }, [loadSpace])

  const manageable = space
    ? canManage(effectiveRole(space, isSiteAdmin))
    : false

  useEffect(() => {
    if (!space || !canManage(effectiveRole(space, isSiteAdmin))) return
    void loadMembers()
    void loadCounts()
  }, [space, isSiteAdmin, loadMembers, loadCounts])

  const saveInfo = async () => {
    if (!spaceId) return
    const value = name.trim()
    if (!value) {
      setInfoError("请填写空间名称")
      return
    }
    setSavingInfo(true)
    setInfoError("")
    setInfoMessage("")
    try {
      const updated = await spacesApi.update(spaceId, {
        name: value,
        description: description.trim()
      })
      setSpace(updated)
      setName(updated.name)
      setDescription(updated.description)
      upsertSpace(updated)
      setInfoMessage("已保存，切换器里的名称同步更新。")
    } catch (error) {
      setInfoError(describeApiError(error))
    } finally {
      setSavingInfo(false)
    }
  }

  const changeRole = async (member: SpaceMember, role: SpaceRole) => {
    if (!spaceId || member.role === role) return
    setBusyMemberId(member.userId)
    setMembersError("")
    try {
      await spacesApi.updateMember(spaceId, member.userId, role)
      await loadMembers()
    } catch (error) {
      setMembersError(describeApiError(error))
    } finally {
      setBusyMemberId(null)
    }
  }

  const confirmRemove = async () => {
    if (!spaceId || !removeTarget) return
    setBusyMemberId(removeTarget.userId)
    setMembersError("")
    try {
      await spacesApi.removeMember(spaceId, removeTarget.userId)
      setRemoveTarget(null)
      await loadMembers()
    } catch (error) {
      setMembersError(describeApiError(error))
    } finally {
      setBusyMemberId(null)
    }
  }

  const searchCandidates = async (event: FormEvent) => {
    event.preventDefault()
    if (!spaceId) return
    const query = candidateQuery.trim()
    if (!query) return
    setCandidatesLoading(true)
    setCandidateError("")
    try {
      setCandidates(await spacesApi.candidates(spaceId, query))
    } catch (error) {
      setCandidateError(describeApiError(error))
    } finally {
      setCandidatesLoading(false)
    }
  }

  const addCandidate = async (candidate: SpaceCandidate) => {
    if (!spaceId) return
    setAddingId(candidate.userId)
    setCandidateError("")
    try {
      await spacesApi.addMember(spaceId, {
        userId: candidate.userId,
        role: candidateRole
      })
      setCandidates((prev) =>
        prev.filter((item) => item.userId !== candidate.userId)
      )
      await loadMembers()
    } catch (error) {
      setCandidateError(describeApiError(error))
    } finally {
      setAddingId(null)
    }
  }

  const deleteSpace = async () => {
    if (!spaceId) return
    setDeleting(true)
    setDeleteError("")
    try {
      await removeSpace(spaceId)
      setDeleteOpen(false)
      navigate("/")
    } catch (error) {
      setDeleteError(describeApiError(error))
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4" role="status" aria-label="空间设置加载中">
        <div className="h-7 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-40 animate-pulse rounded-xl bg-muted/60" />
      </div>
    )
  }

  if (notFound) {
    return (
      <Empty
        title="空间不存在或你已不是它的成员"
        description="它可能已被删除，或者成员资格被移除。"
        contents={
          <Button asChild size="sm" variant="outline">
            <Link to="/">回到页面</Link>
          </Button>
        }
      />
    )
  }

  if (loadError || !space) {
    return (
      <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
        <p role="alert" className="text-sm text-destructive">
          {loadError || "空间设置加载失败"}
        </p>
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          onClick={() => void loadSpace()}
        >
          重新加载
        </Button>
      </div>
    )
  }

  if (!manageable) {
    return (
      <Empty
        title="仅空间管理员可以打开空间设置"
        description="你在这个空间是编辑或只读成员；改名称、成员与删除空间需要空间管理员权限。"
        contents={
          <Button asChild size="sm" variant="outline">
            <Link to="/">回到页面</Link>
          </Button>
        }
      />
    )
  }

  const adminCount = members.filter((member) => member.role === "admin").length
  const hasPages = pageCount + trashedCount > 0
  const canDeleteSpace =
    !space.isDefault && (countsError ? true : !hasPages) && !countsLoading

  return (
    <div className="max-w-[900px] space-y-4">
      <header className="space-y-2">
        <Button
          asChild
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
        >
          <Link to="/">
            <ArrowLeft aria-hidden="true" />
            回到页面
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            {space.name}
          </h1>
          <Badge variant="secondary">
            {SPACE_ROLE_LABELS[effectiveRole(space, isSiteAdmin)]}
          </Badge>
          {space.isDefault ? <Badge variant="outline">默认空间</Badge> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          空间设置只对空间管理员可见。名称与描述会即时出现在侧栏切换器里。
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Settings2
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            空间信息
          </CardTitle>
          <CardDescription>
            名称 1–64 个字符，描述最多 500 个字符。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              void saveInfo()
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="space-name">名称</Label>
              <Input
                id="space-name"
                name="space-name"
                maxLength={64}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="space-description">描述</Label>
              <Textarea
                id="space-description"
                name="space-description"
                maxLength={500}
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="这个空间用来放什么内容"
              />
            </div>
            {infoError ? (
              <p role="alert" className="text-xs text-destructive">
                {infoError}
              </p>
            ) : null}
            {infoMessage ? (
              <p
                role="status"
                className="text-xs text-emerald-600 dark:text-emerald-400"
              >
                {infoMessage}
              </p>
            ) : null}
            <Button type="submit" size="sm" disabled={savingInfo}>
              {savingInfo ? "保存中…" : "保存"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            成员
          </CardTitle>
          <CardDescription>
            成员从已注册用户里选；每个空间至少要保留一名管理员。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {membersError ? (
            <p role="alert" className="text-xs text-destructive">
              {membersError}
            </p>
          ) : null}

          {membersLoading && members.length === 0 ? (
            <div className="space-y-2" role="status" aria-label="成员加载中">
              {[0, 1].map((index) => (
                <div
                  key={index}
                  className="h-9 animate-pulse rounded bg-muted"
                />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>成员</TableHead>
                  <TableHead className="w-32">角色</TableHead>
                  <TableHead className="w-28">加入时间</TableHead>
                  <TableHead className="w-20 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => {
                  const lastAdmin = member.role === "admin" && adminCount <= 1
                  return (
                    <TableRow key={member.userId}>
                      <TableCell>
                        <span className="block truncate font-medium">
                          {member.username || member.email}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {member.email} · {member.publicId}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={member.role}
                          onValueChange={(value) =>
                            void changeRole(member, value as SpaceRole)
                          }
                          disabled={busyMemberId === member.userId || lastAdmin}
                        >
                          <SelectTrigger
                            className="w-full"
                            aria-label={`${member.username || member.email} 的角色`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLE_OPTIONS.map((role) => (
                              <SelectItem key={role} value={role}>
                                {SPACE_ROLE_LABELS[role]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {lastAdmin ? (
                          <span className="mt-1 block text-[11px] text-muted-foreground">
                            最后一名管理员
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDate(member.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          disabled={busyMemberId === member.userId || lastAdmin}
                          onClick={() => setRemoveTarget(member)}
                        >
                          移除
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}

          <Separator />

          <form
            className="space-y-2"
            onSubmit={(event) => void searchCandidates(event)}
          >
            <Label htmlFor="member-candidate">添加成员</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="member-candidate"
                name="member-candidate"
                className="min-w-[12rem] flex-1"
                value={candidateQuery}
                onChange={(event) => setCandidateQuery(event.target.value)}
                placeholder="按用户名、邮箱或用户 ID 搜索"
              />
              <Select
                value={candidateRole}
                onValueChange={(value) => setCandidateRole(value as SpaceRole)}
              >
                <SelectTrigger className="w-28" aria-label="新成员角色">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((role) => (
                    <SelectItem key={role} value={role}>
                      {SPACE_ROLE_LABELS[role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={candidatesLoading}
              >
                <UserPlus aria-hidden="true" />
                {candidatesLoading ? "搜索中…" : "搜索"}
              </Button>
            </div>
            {candidateError ? (
              <p role="alert" className="text-xs text-destructive">
                {candidateError}
              </p>
            ) : null}
            {candidates.length > 0 ? (
              <ul className="divide-y divide-border rounded-md border border-border">
                {candidates.map((candidate) => (
                  <li
                    key={candidate.userId}
                    className="flex flex-wrap items-center gap-2 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {candidate.username || candidate.email}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {candidate.email} · {candidate.publicId}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      disabled={addingId === candidate.userId}
                      onClick={() => void addCandidate(candidate)}
                    >
                      {addingId === candidate.userId ? "添加中…" : "添加"}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </form>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            危险区
          </CardTitle>
          <CardDescription>
            删除空间不可恢复；默认空间与还有页面的空间不能删除。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {countsError ? (
            <p role="alert" className="text-xs text-destructive">
              {countsError}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {space.isDefault
              ? "默认空间不能删除。"
              : countsLoading
                ? "正在统计空间内的页面…"
                : hasPages
                  ? `空间里还有 ${pageCount} 个页面${trashedCount > 0 ? `，回收站里另有 ${trashedCount} 个` : ""}。请先在页面里用「移动到空间」把页面迁到别的空间，或彻底删除回收站里的页面，再回来删除空间。`
                  : "空间里没有页面，可以删除。"}
          </p>
          {deleteError ? (
            <p role="alert" className="text-xs text-destructive">
              {deleteError}
            </p>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={!canDeleteSpace || deleting}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 aria-hidden="true" />
            删除空间
          </Button>
        </CardContent>
      </Card>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              把「{removeTarget?.username || removeTarget?.email}」移出空间？
            </AlertDialogTitle>
            <AlertDialogDescription>
              移除后对方会立即失去这个空间的页面访问权限，可以再加回来。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                void confirmRemove()
              }}
              disabled={busyMemberId !== null}
            >
              移除成员
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除空间「{space.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              空间本身与成员关系会被删除。页面必须先迁走或彻底删除，这个操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p role="alert" className="text-xs text-destructive">
              {deleteError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault()
                void deleteSpace()
              }}
              disabled={deleting}
            >
              {deleting ? "删除中…" : "删除空间"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
