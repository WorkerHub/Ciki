import { Empty } from "@cloudflare/kumo/components/empty"
import {
  ArrowLeft,
  Settings2,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users
} from "lucide-react"
import type { FormEvent } from "react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useNavigate } from "react-router"
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
import { canManage, effectiveRole } from "@/lib/space"
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
  // 路由是 /s/:slug/settings：SpaceRoute 已把当前空间切到 slug 对应的那个，
  // 这里直接用当前空间 id 取数（slug 只在路由层解析一次）。
  const spaceId = useSpacesStore((state) => state.currentId)
  const navigate = useNavigate()
  const isSiteAdmin = useAuthStore((state) => state.user?.role === "admin")
  const upsertSpace = useSpacesStore((state) => state.upsert)
  const removeSpace = useSpacesStore((state) => state.remove)
  const { t } = useTranslation()

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
  const [busyMemberId, setBusyMemberId] = useState<number | null>(null)
  const [removeTarget, setRemoveTarget] = useState<SpaceMember | null>(null)

  const [candidateQuery, setCandidateQuery] = useState("")
  const [candidateRole, setCandidateRole] = useState<SpaceRole>("editor")
  const [candidates, setCandidates] = useState<SpaceCandidate[]>([])
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  const [candidateError, setCandidateError] = useState("")
  const [addingId, setAddingId] = useState<number | null>(null)

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
      setInfoError(t("shell.spaces.create.nameRequired"))
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
      setInfoMessage(t("space.settings.info.saved"))
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
      <div
        className="space-y-4"
        role="status"
        aria-label={t("space.settings.loadingLabel")}
      >
        <div className="h-7 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-40 animate-pulse rounded-xl bg-muted/60" />
      </div>
    )
  }

  if (notFound) {
    return (
      <Empty
        title={t("space.settings.notFound.title")}
        description={t("space.settings.notFound.description")}
        contents={
          <Button asChild size="sm" variant="outline">
            <Link to="/">{t("space.settings.back")}</Link>
          </Button>
        }
      />
    )
  }

  if (loadError || !space) {
    return (
      <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
        <p role="alert" className="text-sm text-destructive">
          {loadError || t("space.settings.loadFailed")}
        </p>
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          onClick={() => void loadSpace()}
        >
          {t("space.settings.reload")}
        </Button>
      </div>
    )
  }

  if (!manageable) {
    return (
      <Empty
        title={t("space.settings.forbidden.title")}
        description={t("space.settings.forbidden.description")}
        contents={
          <Button asChild size="sm" variant="outline">
            <Link to="/">{t("space.settings.back")}</Link>
          </Button>
        }
      />
    )
  }

  const adminCount = members.filter((member) => member.role === "admin").length
  const hasPages = pageCount + trashedCount > 0
  // 统计没拿到时一律不给删除：宁可多一次刷新，也不能在统计失败时放行
  const canDeleteSpace =
    !space.isDefault && !countsLoading && !countsError && !hasPages

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
            {t("space.settings.back")}
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            {space.name}
          </h1>
          <Badge variant="secondary">
            {t(`common.roles.${effectiveRole(space, isSiteAdmin)}`)}
          </Badge>
          {space.isDefault ? (
            <Badge variant="outline">{t("space.settings.defaultBadge")}</Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("space.settings.subtitle")}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Settings2
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            {t("space.settings.info.title")}
          </CardTitle>
          <CardDescription>
            {t("space.settings.info.description")}
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
              <Label htmlFor="space-name">
                {t("space.settings.info.name")}
              </Label>
              <Input
                id="space-name"
                name="space-name"
                maxLength={64}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="space-description">
                {t("space.settings.info.descriptionLabel")}
              </Label>
              <Textarea
                id="space-description"
                name="space-description"
                maxLength={500}
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t("shell.spaces.create.descriptionPlaceholder")}
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
              {savingInfo ? t("space.settings.saving") : t("common.save")}
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
            {t("space.settings.members.title")}
          </CardTitle>
          <CardDescription>
            {t("space.settings.members.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {membersError ? (
            <p role="alert" className="text-xs text-destructive">
              {membersError}
            </p>
          ) : null}

          {membersLoading && members.length === 0 ? (
            <div
              className="space-y-2"
              role="status"
              aria-label={t("space.settings.members.loadingLabel")}
            >
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
                  <TableHead>{t("space.settings.members.column")}</TableHead>
                  <TableHead className="w-32">
                    {t("space.settings.members.roleColumn")}
                  </TableHead>
                  <TableHead className="w-28">
                    {t("space.settings.members.joinedAt")}
                  </TableHead>
                  <TableHead className="w-20 text-right">
                    {t("common.table.actions")}
                  </TableHead>
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
                          {member.email}
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
                            aria-label={t("space.settings.members.roleLabel", {
                              name: member.username || member.email
                            })}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLE_OPTIONS.map((role) => (
                              <SelectItem key={role} value={role}>
                                {t(`common.roles.${role}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {lastAdmin ? (
                          <span className="mt-1 block text-[11px] text-muted-foreground">
                            {t("space.settings.members.lastAdmin")}
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
                          {t("space.settings.members.remove")}
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
            <Label htmlFor="member-candidate">
              {t("space.settings.members.add")}
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="member-candidate"
                name="member-candidate"
                className="min-w-[12rem] flex-1"
                value={candidateQuery}
                onChange={(event) => setCandidateQuery(event.target.value)}
                placeholder={t("space.settings.members.searchPlaceholder")}
              />
              <Select
                value={candidateRole}
                onValueChange={(value) => setCandidateRole(value as SpaceRole)}
              >
                <SelectTrigger
                  className="w-28"
                  aria-label={t("space.settings.members.newRoleLabel")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((role) => (
                    <SelectItem key={role} value={role}>
                      {t(`common.roles.${role}`)}
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
                {candidatesLoading
                  ? t("space.settings.members.searching")
                  : t("space.settings.members.search")}
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
                        {candidate.email}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      disabled={addingId === candidate.userId}
                      onClick={() => void addCandidate(candidate)}
                    >
                      {addingId === candidate.userId
                        ? t("space.settings.members.adding")
                        : t("space.settings.members.addSubmit")}
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
            {t("space.settings.danger.title")}
          </CardTitle>
          <CardDescription>
            {t("space.settings.danger.description")}
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
              ? t("space.settings.danger.default")
              : countsError
                ? t("space.settings.danger.countsFailed")
                : countsLoading
                  ? t("space.settings.danger.counting")
                  : hasPages
                    ? t("space.settings.danger.hasPages", {
                        count: pageCount,
                        trash:
                          trashedCount > 0
                            ? t("space.settings.danger.trashSuffix", {
                                count: trashedCount
                              })
                            : ""
                      })
                    : t("space.settings.danger.empty")}
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
            {t("space.settings.danger.delete")}
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
              {t("space.settings.members.removeTitle", {
                name: removeTarget?.username || removeTarget?.email
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("space.settings.members.removeDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {membersError ? (
            <p role="alert" className="text-xs text-destructive">
              {membersError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                void confirmRemove()
              }}
              disabled={busyMemberId !== null}
            >
              {t("space.settings.members.removeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("space.settings.danger.deleteTitle", { name: space.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("space.settings.danger.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p role="alert" className="text-xs text-destructive">
              {deleteError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault()
                void deleteSpace()
              }}
              disabled={deleting}
            >
              {deleting
                ? t("space.settings.danger.deleting")
                : t("space.settings.danger.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
