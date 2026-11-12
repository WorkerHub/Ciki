import {
  KeyRound,
  Languages,
  Laptop,
  Lock,
  LogOut,
  Mail,
  MonitorSmartphone,
  ShieldCheck
} from "lucide-react"
import QRCode from "qrcode"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router"
import { ApiTokensCard } from "@/components/ApiTokensCard"
import { ImportTokensCard } from "@/components/ImportTokensCard"
import { LanguageSegmented } from "@/components/LanguageToggle"
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
import { changeLanguage, currentLanguage } from "@/i18n"
import {
  ApiError,
  authApi,
  describeApiError,
  meApi,
  type SessionInfo,
  type TotpSetup
} from "@/lib/api"
import { formatDateTime, formatRelative } from "@/lib/format"
import type { Language } from "@/lib/language"
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
  const { t } = useTranslation()
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
            <Label htmlFor="confirm-password">
              {t("settings.password.accountLabel")}
            </Label>
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
              {busy ? t("settings.password.busy") : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function SettingsPage() {
  const user = useAuthStore((state) => state.user)
  const setUser = useAuthStore((state) => state.setUser)
  const refreshMe = useAuthStore((state) => state.refreshMe)
  const setRestricted = useAuthStore((state) => state.setRestricted)
  const logout = useAuthStore((state) => state.logout)
  const navigate = useNavigate()
  const { t } = useTranslation()

  const [error, setError] = useState("")
  /** 成功提示存 key，渲染时再 t()：本页就能切语言，提示不能停在旧语言。 */
  const [noticeKey, setNoticeKey] = useState("")

  // 语言：切换即时生效，再写回账号（规格 §2.4）
  const [savingLanguage, setSavingLanguage] = useState(false)

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
    setNoticeKey("")
    if (newPassword.length < 8) {
      setError(t("settings.password.tooShort"))
      return
    }
    if (newPassword !== repeatPassword) {
      setError(t("settings.password.mismatch"))
      return
    }
    setChangingPassword(true)
    try {
      await meApi.changePassword(currentPassword, newPassword)
      setCurrentPassword("")
      setNewPassword("")
      setRepeatPassword("")
      setNoticeKey("settings.notices.passwordUpdated")
    } catch (passwordError) {
      setError(describeApiError(passwordError))
    } finally {
      setChangingPassword(false)
    }
  }

  /**
   * 语言切换：先本地即时生效，再写回账号（只提交 language，不碰用户名/头像）。
   * 写回失败就回滚到切换前的语言，避免界面显示与账号里存的不一致。
   */
  const saveLanguage = async (next: Language) => {
    const before = currentLanguage()
    if (next === before) return
    setError("")
    setNoticeKey("")
    setSavingLanguage(true)
    await changeLanguage(next)
    try {
      setUser(await meApi.updateProfile({ language: next }))
    } catch (languageError) {
      if (currentLanguage() === next) await changeLanguage(before)
      setError(describeApiError(languageError))
    } finally {
      setSavingLanguage(false)
    }
  }

  const startTotp = async (password?: string) => {
    setError("")
    setNoticeKey("")
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
      setNoticeKey("settings.notices.totpEnabled")
      await refreshMe()
    } catch (enableError) {
      setError(describeApiError(enableError))
    } finally {
      setTotpBusy(false)
    }
  }

  const registerPasskey = async (password?: string) => {
    setError("")
    setNoticeKey("")
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
      setNoticeKey("settings.notices.passkeyAdded")
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
    setNoticeKey("")
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
      setNoticeKey("settings.notices.emailOtpEnabled")
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
  const emailSentHint = t("auth.common.codeSentTo", {
    email: user?.email ?? t("auth.common.accountEmailFallback"),
    minutes: Math.round(emailExpiresIn / 60)
  })
  const accountEmail = user?.email ?? t("auth.common.accountEmailFallback")
  const emailHint = emailOtpEnabled
    ? emailConfigured
      ? t("settings.twofa.email.hintEnabledConfigured", { email: accountEmail })
      : t("settings.twofa.email.hintEnabledUnconfigured")
    : emailConfigured
      ? t("settings.twofa.email.hintNotEnabled")
      : t("settings.twofa.email.hintUnavailable")

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          {t("settings.title")}
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
      {noticeKey ? (
        <p
          role="status"
          className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
        >
          {t(noticeKey)}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MonitorSmartphone
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            {t("settings.appearance.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <ThemeSegmented />
          <p className="text-xs text-muted-foreground">
            {t("settings.appearance.account", { email: user?.email })}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Languages
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            {t("settings.language.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <LanguageSegmented
            onChange={(next) => void saveLanguage(next)}
            disabled={savingLanguage}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="size-4 text-muted-foreground" aria-hidden="true" />
            {t("settings.password.title")}
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
              <Label htmlFor="current-password">
                {t("settings.password.current")}
              </Label>
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
              <Label htmlFor="new-password">{t("settings.password.new")}</Label>
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
              <Label htmlFor="repeat-password">
                {t("settings.password.repeat")}
              </Label>
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
                {changingPassword
                  ? t("settings.password.submitting")
                  : t("settings.password.submit")}
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
            {t("settings.twofa.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">
                  {t("settings.twofa.totp.label")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {totpEnabled
                    ? t("settings.twofa.totp.enabled")
                    : t("settings.twofa.totp.disabled")}
                </p>
              </div>
              {totpEnabled ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setDisableTotpOpen(true)}
                >
                  {t("settings.twofa.disable")}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void startTotp()}
                  disabled={totpBusy}
                >
                  {totpBusy
                    ? t("settings.twofa.totp.preparing")
                    : t("settings.twofa.totp.start")}
                </Button>
              )}
            </div>

            {totp && !totpEnabled ? (
              <div className="rounded-lg border border-border p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                  {totpQr ? (
                    <img
                      src={totpQr}
                      alt={t("settings.twofa.totp.qrAlt")}
                      width={160}
                      height={160}
                      className="size-40 rounded bg-white p-1"
                    />
                  ) : null}
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {t("settings.twofa.totp.scanHint")}
                    </p>
                    <code className="block rounded bg-muted px-2 py-1 font-mono text-xs break-all">
                      {totp.secret}
                    </code>
                    <div className="flex items-end gap-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="totp-enable-code">
                          {t("settings.twofa.totp.codeLabel")}
                        </Label>
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
                        {t("settings.twofa.enable")}
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
                    ? t("settings.twofa.passkey.registered", {
                        count: passkeyCount
                      })
                    : t("settings.twofa.passkey.none")}
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
                      : t("settings.twofa.passkey.unsupported")
                  }
                >
                  {passkeyBusy
                    ? t("settings.twofa.passkey.waiting")
                    : t("settings.twofa.passkey.add")}
                </Button>
                {passkeyCount > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setRemovePasskeyOpen(true)}
                  >
                    {t("settings.twofa.passkey.removeAll")}
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
                  {t("settings.twofa.email.label")}
                </p>
                <p className="text-xs text-muted-foreground">{emailHint}</p>
              </div>
              {emailOtpEnabled ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={t("settings.twofa.email.disableLabel")}
                  onClick={() => setDisableEmailOtpOpen(true)}
                >
                  {t("settings.twofa.disable")}
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
                    ? t("settings.twofa.email.sending")
                    : // 冷却期间不论是刚发完还是刚取消，都别留一个点了必定 429 的按钮
                      emailCooldown > 0
                      ? t("settings.twofa.email.resendIn", {
                          seconds: emailCooldown
                        })
                      : emailVerifySent
                        ? t("settings.twofa.email.resend")
                        : t("settings.twofa.email.enable")}
                </Button>
              )}
            </div>

            {emailVerifySent && !emailOtpEnabled ? (
              <div className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="email-otp-enable-code">
                      {t("settings.twofa.email.label")}
                    </Label>
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
                    {t("settings.twofa.enable")}
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
                    {t("common.cancel")}
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

      <ApiTokensCard />

      <ImportTokensCard />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Laptop
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            {t("settings.sessions.title")}
          </CardTitle>
          <CardDescription>
            {t("settings.sessions.description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {sessions.length === 0 ? (
              <li className="py-2 text-sm text-muted-foreground">
                {t("settings.sessions.empty")}
              </li>
            ) : (
              sessions.map((session) => (
                <li
                  key={session.id}
                  className="flex flex-wrap items-center gap-2 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {session.userAgent ||
                        t("settings.sessions.unknownDevice")}
                      {session.current ? (
                        <span className="ml-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
                          {t("settings.sessions.current")}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {t("settings.sessions.meta", {
                        ip: session.ip || "—",
                        relative: formatRelative(session.lastSeenAt),
                        time: formatDateTime(session.createdAt)
                      })}
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
                    {t("settings.sessions.revoke")}
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
          {t("shell.userMenu.logout")}
        </Button>
      </div>

      <PasswordConfirmDialog
        open={disableTotpOpen}
        onOpenChange={setDisableTotpOpen}
        title={t("settings.dialogs.disableTotp.title")}
        description={t("settings.dialogs.disableTotp.description")}
        confirmLabel={t("settings.twofa.disable")}
        busy={totpBusy}
        error={error}
        onConfirm={async (password) => {
          setTotpBusy(true)
          setError("")
          try {
            await authApi.totpDisable(password)
            setDisableTotpOpen(false)
            setNoticeKey("settings.notices.totpDisabled")
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
        title={t("settings.dialogs.reauth.title")}
        description={t("settings.dialogs.reauth.description")}
        confirmLabel={t("settings.dialogs.reauth.confirm")}
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
        title={t("settings.dialogs.disableEmail.title")}
        description={t("settings.dialogs.disableEmail.description")}
        confirmLabel={t("settings.dialogs.disableEmail.confirm")}
        busy={emailBusy}
        error={error}
        onConfirm={async (password) => {
          setEmailBusy(true)
          setError("")
          try {
            await authApi.emailOtpDisable(password)
            setDisableEmailOtpOpen(false)
            setNoticeKey("settings.notices.emailOtpDisabled")
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
        title={t("settings.dialogs.removePasskey.title")}
        description={t("settings.dialogs.removePasskey.description")}
        confirmLabel={t("settings.twofa.passkey.removeAll")}
        busy={passkeyBusy}
        error={error}
        onConfirm={async (password) => {
          setPasskeyBusy(true)
          setError("")
          try {
            await authApi.passkeyDisableAll(password)
            setRemovePasskeyOpen(false)
            setNoticeKey("settings.notices.passkeyRemoved")
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
