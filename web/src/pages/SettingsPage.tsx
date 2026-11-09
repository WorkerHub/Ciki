import {
  KeyRound,
  Laptop,
  Lock,
  LogOut,
  Mail,
  MonitorSmartphone,
  ShieldCheck
} from "lucide-react"
import QRCode from "qrcode"
import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router"
import { ImportTokenCard } from "@/components/ImportTokenCard"
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
import { useSiteStore } from "@/stores/site"

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
  const [pendingReauth, setPendingReauth] = useState<
    null | "totp" | "passkey" | "email"
  >(null)
  const [reauthPassword, setReauthPassword] = useState("")
  const [reauthError, setReauthError] = useState("")

  // Passkey
  const [passkeyBusy, setPasskeyBusy] = useState(false)
  const [removePasskeyOpen, setRemovePasskeyOpen] = useState(false)

  // 邮箱验证码（第三种因子）：send-verify 发码 → enable 拿码开启，验过往返才真正开启
  const emailConfigured = useSiteStore((state) => state.emailConfigured)
  const setEmailConfigured = useSiteStore((state) => state.setEmailConfigured)
  const [emailVerifySent, setEmailVerifySent] = useState(false)
  const [emailCode, setEmailCode] = useState("")
  const [emailBusy, setEmailBusy] = useState(false)
  const [emailCooldown, setEmailCooldown] = useState(0)
  /** 本次验证码有效期（秒），按服务端回执显示，默认对齐契约的 600s。 */
  const [emailExpiresIn, setEmailExpiresIn] = useState(600)
  const [disableEmailOtpOpen, setDisableEmailOtpOpen] = useState(false)

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

  // 重发冷却：秒级倒计时，到点自动恢复按钮
  useEffect(() => {
    if (emailCooldown <= 0) return
    const timer = setTimeout(
      () => setEmailCooldown((left) => Math.max(0, left - 1)),
      1000
    )
    return () => clearTimeout(timer)
  }, [emailCooldown])

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

  const sendEmailVerify = async (password?: string) => {
    setError("")
    setNotice("")
    if (!password && needsReauthToAddFactor(user?.twofa)) {
      setReauthError("")
      setPendingReauth("email")
      return
    }
    setEmailBusy(true)
    try {
      const sent = await authApi.emailOtpSendVerify(password)
      setReauthPassword(password ?? "")
      setPendingReauth(null)
      setEmailVerifySent(true)
      setEmailCode("")
      setEmailCooldown(sent.cooldownSeconds)
      setEmailExpiresIn(sent.expiresInSeconds)
    } catch (sendError) {
      // 服务端回「站点没配发信」就是权威结论：立刻把入口切成不可用态（带去向提示），
      // 不必等用户刷新页面才发现自己一直在点一个注定失败的按钮。
      if (
        sendError instanceof ApiError &&
        sendError.code === "EMAIL_NOT_CONFIGURED"
      ) {
        setEmailConfigured(false)
      }
      // 429 带 retryAfter：按服务端给的剩余秒数起步，别让用户拿着一个能点但必错的按钮
      if (sendError instanceof ApiError && sendError.retryAfter) {
        setEmailCooldown(sendError.retryAfter)
      }
      const message = describeApiError(sendError)
      if (password) {
        setPendingReauth("email")
        setReauthError(message)
      } else {
        setError(message)
      }
    } finally {
      setEmailBusy(false)
    }
  }

  const enableEmailOtp = async () => {
    setError("")
    setEmailBusy(true)
    try {
      await authApi.emailOtpEnable(
        emailCode.trim(),
        reauthPassword || undefined
      )
      setEmailVerifySent(false)
      setEmailCode("")
      setReauthPassword("")
      // 与 TOTP 启用一致：后端已清掉 needs_2fa_setup，受限标记要跟着清
      setRestricted(false)
      setNotice("邮箱验证码已开启，下次登录可以改用邮箱收码。")
      await refreshMe()
    } catch (enableError) {
      setError(describeApiError(enableError))
    } finally {
      setEmailBusy(false)
    }
  }

  const totpEnabled = user?.twofa.totpEnabled ?? false
  const passkeyCount = user?.twofa.passkeyCount ?? 0
  const emailOtpEnabled = user?.twofa.emailOtpEnabled === true
  /** 发信没配好时「开启邮箱验证码」直接不可点，并在同一句里说清去哪里配。 */
  const emailUnavailable = !emailConfigured && !emailOtpEnabled
  const emailSentHint = `验证码已发送到 ${user?.email ?? "账号邮箱"}，${Math.round(
    emailExpiresIn / 60
  )} 分钟内有效。`
  const emailHint = emailOtpEnabled
    ? emailConfigured
      ? `已开启：登录第二步可以向 ${user?.email ?? "账号邮箱"} 发送 6 位验证码。`
      : "已开启，但站点没有配置发信，登录时不会出现这个方式；可随时关闭。"
    : emailConfigured
      ? "未开启：需要先收一封验证码邮件确认邮箱可达。"
      : "站点未配置发信，邮箱验证码不可用；请联系管理员在「系统管理」中配置 SMTP。"

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          设置
        </h1>
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
                    : "未登记。"}
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
          </section>

          <Separator />

          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <Mail className="size-3.5" aria-hidden="true" />
                  邮箱验证码
                </p>
                <p className="text-xs text-muted-foreground">{emailHint}</p>
              </div>
              {emailOtpEnabled ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label="关闭邮箱验证码"
                  onClick={() => setDisableEmailOtpOpen(true)}
                >
                  关闭
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={emailBusy || emailUnavailable || emailCooldown > 0}
                  onClick={() =>
                    // 重发沿用上次通过的重认证密码；首次发码走密码弹窗判断
                    void sendEmailVerify(
                      emailVerifySent ? reauthPassword || undefined : undefined
                    )
                  }
                >
                  {emailBusy
                    ? "发送中…"
                    : // 冷却期间不论是刚发完还是刚取消，都别留一个点了必定 429 的按钮
                      emailCooldown > 0
                      ? `重新发送（${emailCooldown}s）`
                      : emailVerifySent
                        ? "重新发送"
                        : "开启邮箱验证码"}
                </Button>
              )}
            </div>

            {emailVerifySent && !emailOtpEnabled ? (
              <div className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="email-otp-enable-code">邮箱验证码</Label>
                    <Input
                      id="email-otp-enable-code"
                      name="email-otp-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={emailCode}
                      onChange={(event) =>
                        setEmailCode(
                          event.target.value.replace(/\D/g, "").slice(0, 6)
                        )
                      }
                      className="w-32 tracking-[0.3em]"
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={emailBusy || emailCode.length !== 6}
                    onClick={() => void enableEmailOtp()}
                  >
                    启用
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEmailVerifySent(false)
                      setEmailCode("")
                      setReauthPassword("")
                    }}
                  >
                    取消
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {emailSentHint}
                </p>
              </div>
            ) : null}
          </section>
        </CardContent>
      </Card>

      <ImportTokenCard />

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
        busy={totpBusy || passkeyBusy || emailBusy}
        error={reauthError}
        onConfirm={(password) => {
          const flow = pendingReauth
          setPendingReauth(null)
          setReauthError("")
          if (flow === "totp") void startTotp(password)
          if (flow === "passkey") void registerPasskey(password)
          if (flow === "email") void sendEmailVerify(password)
        }}
      />

      <PasswordConfirmDialog
        open={disableEmailOtpOpen}
        onOpenChange={setDisableEmailOtpOpen}
        title="关闭邮箱验证码"
        description="关闭后登录第二步不再发送邮件验证码，其它方式不受影响。"
        confirmLabel="确认关闭"
        busy={emailBusy}
        error={error}
        onConfirm={async (password) => {
          setEmailBusy(true)
          setError("")
          try {
            await authApi.emailOtpDisable(password)
            setDisableEmailOtpOpen(false)
            setNotice("邮箱验证码已关闭。")
            await refreshMe()
          } catch (disableError) {
            setError(describeApiError(disableError))
          } finally {
            setEmailBusy(false)
          }
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
