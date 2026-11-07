import {
  KeyRound,
  Laptop,
  Lock,
  LogOut,
  MonitorSmartphone,
  ShieldCheck
} from "lucide-react"
import QRCode from "qrcode"
import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router"
import { ThemeSegmented } from "@/components/ThemeToggle"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  ApiError,
  authApi,
  describeApiError,
  meApi,
  type SessionInfo,
  type TotpSetup
} from "@/lib/api"
import { formatDateTime, formatRelative } from "@/lib/format"
import { needsReauthToAddFactor } from "@/lib/two-factor"
import {
  describeWebAuthnError,
  registrationCredential,
  webauthnSupported
} from "@/lib/webauthn"
import { useAuthStore } from "@/stores/auth"

function PasswordConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  busy,
  error,
  onConfirm
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  busy: boolean
  error: string
  onConfirm: (password: string) => void
}) {
  const [password, setPassword] = useState("")
  useEffect(() => {
    if (open) setPassword("")
  }, [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            onConfirm(password)
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">账号密码</Label>
            <Input
              id="confirm-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "处理中…" : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function SettingsPage() {
  const user = useAuthStore((state) => state.user)
  const refreshMe = useAuthStore((state) => state.refreshMe)
  const setRestricted = useAuthStore((state) => state.setRestricted)
  const logout = useAuthStore((state) => state.logout)
  const navigate = useNavigate()

  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  // 修改密码
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [repeatPassword, setRepeatPassword] = useState("")
  const [changingPassword, setChangingPassword] = useState(false)

  // TOTP
  const [totp, setTotp] = useState<TotpSetup | null>(null)
  const [totpQr, setTotpQr] = useState("")
  const [totpCode, setTotpCode] = useState("")
  const [totpBusy, setTotpBusy] = useState(false)
  const [disableTotpOpen, setDisableTotpOpen] = useState(false)

  // 新增因子前的密码重认证（已有因子时后端要求 body.password）
  const [pendingReauth, setPendingReauth] = useState<null | "totp" | "passkey">(
    null
  )
  const [reauthPassword, setReauthPassword] = useState("")
  const [reauthError, setReauthError] = useState("")

  // Passkey
  const [passkeyBusy, setPasskeyBusy] = useState(false)
  const [removePasskeyOpen, setRemovePasskeyOpen] = useState(false)

  // 会话
  const [sessions, setSessions] = useState<SessionInfo[]>([])

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await meApi.sessions())
    } catch (sessionError) {
      setError(describeApiError(sessionError))
    }
  }, [])

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  useEffect(() => {
    if (!totp) {
      setTotpQr("")
      return
    }
    let alive = true
    QRCode.toDataURL(totp.uri, { margin: 1, width: 220 })
      .then((url) => {
        if (alive) setTotpQr(url)
      })
      .catch(() => {
        if (alive) setTotpQr("")
      })
    return () => {
      alive = false
    }
  }, [totp])

  const changePassword = async () => {
    setError("")
    setNotice("")
    if (newPassword.length < 8) {
      setError("新密码至少 8 位")
      return
    }
    if (newPassword !== repeatPassword) {
      setError("两次输入的新密码不一致")
      return
    }
    setChangingPassword(true)
    try {
      await meApi.changePassword(currentPassword, newPassword)
      setCurrentPassword("")
      setNewPassword("")
      setRepeatPassword("")
      setNotice("密码已更新，其它设备上的登录会话已失效。")
    } catch (passwordError) {
      setError(describeApiError(passwordError))
    } finally {
      setChangingPassword(false)
    }
  }

  const startTotp = async (password?: string) => {
    setError("")
    setNotice("")
    if (!password && needsReauthToAddFactor(user?.twofa)) {
      setReauthError("")
      setPendingReauth("totp")
      return
    }
    setTotpBusy(true)
    try {
      setTotp(await authApi.totpSetup(password))
      setReauthPassword(password ?? "")
      setPendingReauth(null)
    } catch (setupError) {
      const message = describeApiError(setupError)
      if (password) {
        setPendingReauth("totp")
        setReauthError(message)
      } else {
        setError(message)
      }
    } finally {
      setTotpBusy(false)
    }
  }

  const enableTotp = async () => {
    setError("")
    setTotpBusy(true)
    try {
      await authApi.totpEnable(totpCode.trim(), reauthPassword || undefined)
      setTotp(null)
      setTotpCode("")
      setReauthPassword("")
      // 后端在启用成功后已经清掉 needs_2fa_setup，本地受限标记也要跟着清，
      // 否则用户会一直被 RequireAuth 拉回设置页
      setRestricted(false)
      setNotice("两步验证已开启，下次登录需要输入动态验证码。")
      await refreshMe()
    } catch (enableError) {
      setError(describeApiError(enableError))
    } finally {
      setTotpBusy(false)
    }
  }

  const registerPasskey = async (password?: string) => {
    setError("")
    setNotice("")
    if (!password && needsReauthToAddFactor(user?.twofa)) {
      setReauthError("")
      setPendingReauth("passkey")
      return
    }
    setPasskeyBusy(true)
    try {
      const options = await authApi.passkeyRegisterOptions(password)
      const credential = await registrationCredential(options)
      await authApi.passkeyRegisterVerify(
        credential as unknown as Record<string, unknown>,
        password
      )
      setReauthPassword("")
      setPendingReauth(null)
      setRestricted(false)
      setNotice("Passkey 已添加。")
      await refreshMe()
    } catch (passkeyError) {
      const isApiError = passkeyError instanceof ApiError
      const message = isApiError
        ? describeApiError(passkeyError)
        : describeWebAuthnError(passkeyError)
      if (password && isApiError) {
        setPendingReauth("passkey")
        setReauthError(message)
      } else {
        setError(message)
      }
    } finally {
      setPasskeyBusy(false)
    }
  }

  const totpEnabled = user?.twofa.totpEnabled ?? false
  const passkeyCount = user?.twofa.passkeyCount ?? 0

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          设置
        </h1>
        <p className="text-xs text-muted-foreground">
          个人偏好与账号安全。主题只影响这台设备的显示。
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
        >
          {notice}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MonitorSmartphone
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            外观
          </CardTitle>
          <CardDescription>
            默认跟随系统；选择会保存在本机，首屏不会闪烁。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <ThemeSegmented />
          <p className="text-xs text-muted-foreground">
            当前账号：{user?.email}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="size-4 text-muted-foreground" aria-hidden="true" />
            修改密码
          </CardTitle>
          <CardDescription>修改后其它设备上的会话会被吊销。</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault()
              void changePassword()
            }}
          >
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="current-password">当前密码</Label>
              <Input
                id="current-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-password">新密码（至少 8 位）</Label>
              <Input
                id="new-password"
                name="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="repeat-password">再次输入新密码</Label>
              <Input
                id="repeat-password"
                name="repeat-password"
                type="password"
                autoComplete="new-password"
                value={repeatPassword}
                onChange={(event) => setRepeatPassword(event.target.value)}
                required
              />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" size="sm" disabled={changingPassword}>
                {changingPassword ? "更新中…" : "更新密码"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card id="security">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            两步验证
          </CardTitle>
          <CardDescription>
            站点开启强制 2FA 时，登录后需要在这里完成配置。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">验证器 App（TOTP）</p>
                <p className="text-xs text-muted-foreground">
                  {totpEnabled
                    ? "已开启：登录第二步输入 6 位动态码。"
                    : "未开启。"}
                </p>
              </div>
              {totpEnabled ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setDisableTotpOpen(true)}
                >
                  关闭
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void startTotp()}
                  disabled={totpBusy}
                >
                  {totpBusy ? "准备中…" : "开始配置"}
                </Button>
              )}
            </div>

            {totp && !totpEnabled ? (
              <div className="rounded-lg border border-border p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                  {totpQr ? (
                    <img
                      src={totpQr}
                      alt="TOTP 配置二维码"
                      width={160}
                      height={160}
                      className="size-40 rounded bg-white p-1"
                    />
                  ) : null}
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      用 Bitwarden / 1Password
                      等验证器扫描二维码，或手动输入密钥：
                    </p>
                    <code className="block rounded bg-muted px-2 py-1 font-mono text-xs break-all">
                      {totp.secret}
                    </code>
                    <div className="flex items-end gap-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="totp-enable-code">6 位验证码</Label>
                        <Input
                          id="totp-enable-code"
                          name="otp-code"
                          type="text"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          maxLength={6}
                          value={totpCode}
                          onChange={(event) =>
                            setTotpCode(
                              event.target.value.replace(/\D/g, "").slice(0, 6)
                            )
                          }
                          className="w-32 tracking-[0.3em]"
                        />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        disabled={totpBusy || totpCode.length !== 6}
                        onClick={() => void enableTotp()}
                      >
                        启用
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </section>

          <Separator />

          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <KeyRound className="size-3.5" aria-hidden="true" />
                  Passkey
                </p>
                <p className="text-xs text-muted-foreground">
                  {passkeyCount > 0
                    ? `已登记 ${passkeyCount} 个 Passkey（指纹 / 面容 / 安全钥匙）。`
                    : "未登记。登录第二步可以用 Passkey 代替动态码。"}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void registerPasskey()}
                  disabled={passkeyBusy || !webauthnSupported()}
                  title={
                    webauthnSupported()
                      ? undefined
                      : "当前浏览器不支持 WebAuthn"
                  }
                >
                  {passkeyBusy ? "等待验证…" : "添加 Passkey"}
                </Button>
                {passkeyCount > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setRemovePasskeyOpen(true)}
                  >
                    全部移除
                  </Button>
                ) : null}
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              受契约限制，服务端只回 Passkey
              数量、不提供逐个凭据列表，所以这里只能整体移除。
            </p>
          </section>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Laptop
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            登录设备
          </CardTitle>
          <CardDescription>吊销后该设备需要重新登录。</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {sessions.length === 0 ? (
              <li className="py-2 text-sm text-muted-foreground">
                没有其它会话。
              </li>
            ) : (
              sessions.map((session) => (
                <li
                  key={session.id}
                  className="flex flex-wrap items-center gap-2 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {session.userAgent || "未知设备"}
                      {session.current ? (
                        <span className="ml-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
                          当前
                        </span>
                      ) : null}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {session.ip || "—"} · 最近活动{" "}
                      {formatRelative(session.lastSeenAt)} · 创建于{" "}
                      {formatDateTime(session.createdAt)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={session.current}
                    onClick={async () => {
                      try {
                        await meApi.revokeSession(session.id)
                        await loadSessions()
                      } catch (revokeError) {
                        setError(describeApiError(revokeError))
                      }
                    }}
                  >
                    吊销
                  </Button>
                </li>
              ))
            )}
          </ul>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void logout().then(() => navigate("/login"))
          }}
        >
          <LogOut aria-hidden="true" />
          退出登录
        </Button>
      </div>

      <PasswordConfirmDialog
        open={disableTotpOpen}
        onOpenChange={setDisableTotpOpen}
        title="关闭两步验证"
        description="关闭后登录只需要密码。"
        confirmLabel="关闭"
        busy={totpBusy}
        error={error}
        onConfirm={async (password) => {
          setTotpBusy(true)
          setError("")
          try {
            await authApi.totpDisable(password)
            setDisableTotpOpen(false)
            setNotice("两步验证已关闭。")
            await refreshMe()
          } catch (disableError) {
            setError(describeApiError(disableError))
          } finally {
            setTotpBusy(false)
          }
        }}
      />

      <PasswordConfirmDialog
        open={pendingReauth !== null}
        onOpenChange={(open) => {
          if (open) return
          setPendingReauth(null)
          setReauthPassword("")
          setReauthError("")
        }}
        title="验证身份"
        description="账号已有可用的两步验证方式，新增前需要输入当前密码确认身份。"
        confirmLabel="继续"
        busy={totpBusy || passkeyBusy}
        error={reauthError}
        onConfirm={(password) => {
          const flow = pendingReauth
          setPendingReauth(null)
          setReauthError("")
          if (flow === "totp") void startTotp(password)
          if (flow === "passkey") void registerPasskey(password)
        }}
      />

      <PasswordConfirmDialog
        open={removePasskeyOpen}
        onOpenChange={setRemovePasskeyOpen}
        title="移除全部 Passkey"
        description="移除后只能使用动态验证码或密码登录。"
        confirmLabel="全部移除"
        busy={passkeyBusy}
        error={error}
        onConfirm={async (password) => {
          setPasskeyBusy(true)
          setError("")
          try {
            await authApi.passkeyDisableAll(password)
            setRemovePasskeyOpen(false)
            setNotice("Passkey 已全部移除。")
            await refreshMe()
          } catch (removeError) {
            setError(describeApiError(removeError))
          } finally {
            setPasskeyBusy(false)
          }
        }}
      />
    </div>
  )
}
