import {
  CircleCheck,
  CircleX,
  MoreHorizontal,
  Plus,
  UserCog,
  UserX
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  type AdminUser,
  adminApi,
  describeApiError,
  type Role
} from "@/lib/api"
import { formatDate } from "@/lib/format"
import { useAuthStore } from "@/stores/auth"

type Filter = "all" | "pending"

function StatusBadges({ user }: { user: AdminUser }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-1">
      {user.approvalStatus === "pending" ? (
        <Badge
          variant="outline"
          className="border-amber-500/60 text-amber-700 dark:text-amber-300"
        >
          {t("admin.users.status.pending")}
        </Badge>
      ) : null}
      {user.approvalStatus === "rejected" ? (
        <Badge variant="secondary">{t("admin.users.status.rejected")}</Badge>
      ) : null}
      {!user.isActive ? (
        <Badge variant="destructive">{t("admin.users.status.inactive")}</Badge>
      ) : null}
      {user.isActive && user.approvalStatus === "approved" ? (
        <Badge variant="secondary">{t("admin.users.status.active")}</Badge>
      ) : null}
    </div>
  )
}

export function UsersTab() {
  const me = useAuthStore((state) => state.user)
  const { t } = useTranslation()
  const [filter, setFilter] = useState<Filter>("all")
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [newEmail, setNewEmail] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [newRole, setNewRole] = useState<Role>("user")
  const [passwordTarget, setPasswordTarget] = useState<AdminUser | null>(null)
  const [passwordValue, setPasswordValue] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null)

  const load = useCallback(async (nextFilter: Filter) => {
    setLoading(true)
    setError("")
    try {
      setUsers(await adminApi.users(nextFilter))
    } catch (loadError) {
      setError(describeApiError(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(filter)
  }, [filter, load])

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError("")
    try {
      await action()
      await load(filter)
    } catch (actionError) {
      setError(describeApiError(actionError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={filter}
          onValueChange={(value) => {
            if (value) setFilter(value as Filter)
          }}
          aria-label={t("admin.users.filterLabel")}
        >
          <ToggleGroupItem value="all">
            {t("admin.users.filterAll")}
          </ToggleGroupItem>
          <ToggleGroupItem value="pending">
            {t("admin.users.status.pending")}
          </ToggleGroupItem>
        </ToggleGroup>
        <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden="true" />
          {t("admin.users.create")}
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

      <div className="rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("admin.users.table.email")}</TableHead>
              <TableHead>{t("admin.users.table.role")}</TableHead>
              <TableHead>{t("admin.users.table.status")}</TableHead>
              <TableHead>{t("admin.users.table.createdAt")}</TableHead>
              <TableHead className="w-12 text-right">
                {t("common.table.actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-6 text-center text-sm text-muted-foreground"
                >
                  {t("admin.common.loading")}
                </TableCell>
              </TableRow>
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-6 text-center text-sm text-muted-foreground"
                >
                  {filter === "pending"
                    ? t("admin.users.emptyPending")
                    : t("admin.users.empty")}
                </TableCell>
              </TableRow>
            ) : (
              users.map((user) => {
                const isSelf = user.id === me?.id
                return (
                  <TableRow key={user.id}>
                    <TableCell className="max-w-[18rem] truncate font-medium">
                      {user.email}
                      {isSelf ? (
                        <span className="ml-1.5 text-[11px] text-muted-foreground">
                          {t("admin.users.you")}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {user.role === "admin" ? (
                        <Badge variant="secondary">
                          {t("admin.roles.admin")}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          {t("admin.roles.user")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadges user={user} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(user.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-label={t("admin.users.actionsLabel", {
                              email: user.email
                            })}
                          >
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuLabel>
                            {t("admin.users.menuLabel")}
                          </DropdownMenuLabel>
                          {user.approvalStatus === "pending" ? (
                            <>
                              <DropdownMenuItem
                                disabled={busy}
                                onSelect={() =>
                                  void act(() => adminApi.approve(user.id))
                                }
                              >
                                <CircleCheck aria-hidden="true" />
                                {t("admin.users.approve")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                disabled={busy}
                                onSelect={() =>
                                  void act(() => adminApi.reject(user.id))
                                }
                              >
                                <CircleX aria-hidden="true" />
                                {t("admin.users.reject")}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                            </>
                          ) : null}
                          <DropdownMenuItem
                            disabled={busy || isSelf}
                            onSelect={() =>
                              void act(() =>
                                adminApi.updateUser(user.id, {
                                  role: user.role === "admin" ? "user" : "admin"
                                })
                              )
                            }
                          >
                            <UserCog aria-hidden="true" />
                            {user.role === "admin"
                              ? t("admin.users.setUser")
                              : t("admin.users.setAdmin")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={busy || isSelf}
                            onSelect={() =>
                              void act(() =>
                                adminApi.updateUser(user.id, {
                                  isActive: !user.isActive
                                })
                              )
                            }
                          >
                            <UserX aria-hidden="true" />
                            {user.isActive
                              ? t("admin.users.deactivate")
                              : t("admin.users.activate")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => setPasswordTarget(user)}
                          >
                            {t("admin.users.resetPassword")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={busy || isSelf}
                            onSelect={() => setDeleteTarget(user)}
                          >
                            {t("admin.users.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("admin.users.create")}</DialogTitle>
            <DialogDescription>
              {t("admin.users.createDescription")}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault()
              setBusy(true)
              setError("")
              try {
                await adminApi.createUser(newEmail.trim(), newPassword, newRole)
                setCreateOpen(false)
                setNewEmail("")
                setNewPassword("")
                setNewRole("user")
                await load(filter)
              } catch (createError) {
                setError(describeApiError(createError))
              } finally {
                setBusy(false)
              }
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="admin-new-email">
                {t("admin.users.table.email")}
              </Label>
              <Input
                id="admin-new-email"
                name="email"
                type="email"
                autoComplete="off"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-new-password">
                {t("admin.users.initialPassword")}
              </Label>
              <Input
                id="admin-new-password"
                name="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-new-role">
                {t("admin.users.table.role")}
              </Label>
              <Select
                value={newRole}
                onValueChange={(value) => setNewRole(value as Role)}
              >
                <SelectTrigger id="admin-new-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{t("admin.roles.user")}</SelectItem>
                  <SelectItem value="admin">
                    {t("admin.roles.admin")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="submit" size="sm" disabled={busy}>
                {busy
                  ? t("admin.users.creating")
                  : t("admin.users.createSubmit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={passwordTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPasswordTarget(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("admin.users.resetPassword")}</DialogTitle>
            <DialogDescription>
              {t("admin.users.resetDescription", {
                email: passwordTarget?.email
              })}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault()
              if (!passwordTarget) return
              setBusy(true)
              setError("")
              try {
                await adminApi.updateUser(passwordTarget.id, {
                  password: passwordValue
                })
                setPasswordTarget(null)
                setPasswordValue("")
                await load(filter)
              } catch (resetError) {
                setError(describeApiError(resetError))
              } finally {
                setBusy(false)
              }
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="admin-reset-password">
                {t("admin.users.resetPasswordLabel")}
              </Label>
              <Input
                id="admin-reset-password"
                name="new-password"
                type="password"
                autoComplete="new-password"
                value={passwordValue}
                onChange={(event) => setPasswordValue(event.target.value)}
                required
              />
            </div>
            <DialogFooter>
              <Button type="submit" size="sm" disabled={busy}>
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("admin.users.deleteTitle", { email: deleteTarget?.email })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin.users.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleteTarget) return
                void act(() => adminApi.deleteUser(deleteTarget.id)).then(() =>
                  setDeleteTarget(null)
                )
              }}
            >
              {t("admin.users.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
