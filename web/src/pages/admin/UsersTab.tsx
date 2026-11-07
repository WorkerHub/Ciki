import {
  CircleCheck,
  CircleX,
  MoreHorizontal,
  Plus,
  UserCog,
  UserX
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"
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
  return (
    <div className="flex flex-wrap items-center gap-1">
      {user.approvalStatus === "pending" ? (
        <Badge
          variant="outline"
          className="border-amber-500/60 text-amber-700 dark:text-amber-300"
        >
          待批准
        </Badge>
      ) : null}
      {user.approvalStatus === "rejected" ? (
        <Badge variant="secondary">已拒绝</Badge>
      ) : null}
      {!user.isActive ? <Badge variant="destructive">已停用</Badge> : null}
      {user.isActive && user.approvalStatus === "approved" ? (
        <Badge variant="secondary">正常</Badge>
      ) : null}
    </div>
  )
}

export function UsersTab() {
  const me = useAuthStore((state) => state.user)
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
          aria-label="用户筛选"
        >
          <ToggleGroupItem value="all">全部用户</ToggleGroupItem>
          <ToggleGroupItem value="pending">待批准</ToggleGroupItem>
        </ToggleGroup>
        <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden="true" />
          新建用户
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
              <TableHead>邮箱</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>注册于</TableHead>
              <TableHead className="w-12 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-6 text-center text-sm text-muted-foreground"
                >
                  加载中…
                </TableCell>
              </TableRow>
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-6 text-center text-sm text-muted-foreground"
                >
                  {filter === "pending"
                    ? "没有待批准的注册申请。"
                    : "还没有用户。"}
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
                          （你）
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {user.role === "admin" ? (
                        <Badge variant="secondary">管理员</Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          普通用户
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
                            aria-label={`${user.email} 的操作`}
                          >
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuLabel>账号操作</DropdownMenuLabel>
                          {user.approvalStatus === "pending" ? (
                            <>
                              <DropdownMenuItem
                                disabled={busy}
                                onSelect={() =>
                                  void act(() => adminApi.approve(user.id))
                                }
                              >
                                <CircleCheck aria-hidden="true" />
                                批准并激活
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                disabled={busy}
                                onSelect={() =>
                                  void act(() => adminApi.reject(user.id))
                                }
                              >
                                <CircleX aria-hidden="true" />
                                拒绝申请
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
                              ? "设为普通用户"
                              : "设为管理员"}
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
                            {user.isActive ? "停用账号" : "启用账号"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => setPasswordTarget(user)}
                          >
                            重置密码
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={busy || isSelf}
                            onSelect={() => setDeleteTarget(user)}
                          >
                            删除用户
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
            <DialogTitle>新建用户</DialogTitle>
            <DialogDescription>
              新建的账号直接批准并激活，无需再走审批。
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
              <Label htmlFor="admin-new-email">邮箱</Label>
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
              <Label htmlFor="admin-new-password">初始密码（至少 8 位）</Label>
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
              <Label htmlFor="admin-new-role">角色</Label>
              <Select
                value={newRole}
                onValueChange={(value) => setNewRole(value as Role)}
              >
                <SelectTrigger id="admin-new-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">普通用户</SelectItem>
                  <SelectItem value="admin">管理员</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? "创建中…" : "创建用户"}
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
            <DialogTitle>重置密码</DialogTitle>
            <DialogDescription>
              {passwordTarget?.email} · 重置后该用户的全部会话会被吊销。
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
              <Label htmlFor="admin-reset-password">新密码（至少 8 位）</Label>
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
                保存
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
              删除用户「{deleteTarget?.email}」？
            </AlertDialogTitle>
            <AlertDialogDescription>
              该账号、它的两步验证与全部会话都会被删除。这个操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleteTarget) return
                void act(() => adminApi.deleteUser(deleteTarget.id)).then(() =>
                  setDeleteTarget(null)
                )
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
