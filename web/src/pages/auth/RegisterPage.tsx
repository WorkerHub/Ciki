import { useEffect, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { Link, useNavigate } from "react-router"
import { AuthShell } from "@/components/AuthShell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { currentLanguage } from "@/i18n"
import { ApiError, type AuthConfig, authApi, describeApiError } from "@/lib/api"
import {
  VERIFY_EMAIL_PATH,
  type VerifyEmailNavState
} from "@/lib/email-verification"
import { useSiteStore } from "@/stores/site"

/**
 * 自助注册（#85 契约）：
 * - 站点没配发信时整页换成「暂不可用」：服务端此时也会 503 不建账号，
 *   不摆一个填完才报错的表单；
 * - 注册成功后账号还要先验证邮箱（`emailVerificationRequired`），
 *   服务端在那一次请求里已把 6 位码发出，这里直接带去验证页并锁住重发冷却。
 */
export function RegisterPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const siteName = useSiteStore((state) => state.name)
  const emailConfigured = useSiteStore((state) => state.emailConfigured)
  const siteLoaded = useSiteStore((state) => state.loaded)
  const setEmailConfigured = useSiteStore((state) => state.setEmailConfigured)
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [repeat, setRepeat] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [done, setDone] = useState<null | { approvalRequired: boolean }>(null)
  /** 提交时服务端回 503：配置可能在打开页面之后被清掉，以它为准。 */
  const [emailUnavailable, setEmailUnavailable] = useState(false)

  const unavailable = emailUnavailable || (siteLoaded && !emailConfigured)

  useEffect(() => {
    let alive = true
    authApi
      .config()
      .then((value) => {
        if (alive) setConfig(value)
      })
      .catch(() => {
        // 配置接口挂了仍按「能注册」渲染：真正的权威判定在提交时的服务端回执里，
        // 这里不额外断言发信是否可用（那是 site store 的事）。
        if (alive)
          setConfig({
            registrationEnabled: true,
            registrationApprovalRequired: true,
            siteName: useSiteStore.getState().name,
            emailConfigured: useSiteStore.getState().emailConfigured
          })
      })
    return () => {
      alive = false
    }
  }, [])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError("")
    if (password.length < 8) {
      setError(t("auth.register.passwordTooShort"))
      return
    }
    if (password !== repeat) {
      setError(t("auth.common.passwordMismatch"))
      return
    }
    setBusy(true)
    try {
      const result = await authApi.register(
        email.trim(),
        password,
        currentLanguage()
      )
      if (result.emailVerificationRequired === true) {
        // 那次注册请求里服务端已发码：带去验证页，重发先按冷却计
        const state: VerifyEmailNavState = {
          email: email.trim(),
          codeSent: true,
          approvalRequired: result.approvalRequired
        }
        navigate(VERIFY_EMAIL_PATH, { state })
        return
      }
      setDone({ approvalRequired: result.approvalRequired })
    } catch (registerError) {
      // 站点发信被关掉时服务端 503 不建账号：当场切成「暂不可用」，不再让用户重试
      if (
        registerError instanceof ApiError &&
        registerError.code === "EMAIL_NOT_CONFIGURED"
      ) {
        setEmailUnavailable(true)
        setEmailConfigured(false)
        return
      }
      setError(describeApiError(registerError))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <AuthShell title={t("auth.register.doneTitle")}>
        <div className="space-y-3 text-sm">
          <p>
            {done.approvalRequired
              ? t("auth.register.donePending")
              : t("auth.register.doneActive")}
          </p>
          <Button asChild size="sm" className="w-full">
            <Link to="/login">{t("auth.common.goLogin")}</Link>
          </Button>
        </div>
      </AuthShell>
    )
  }

  if (config && !config.registrationEnabled) {
    return (
      <AuthShell title={t("auth.register.title", { siteName })}>
        <div className="space-y-2 text-sm">
          <p>{t("auth.register.closed")}</p>
          <p className="text-muted-foreground">
            {t("auth.register.closedHint")}
          </p>
          <Button asChild size="sm" variant="outline" className="w-full">
            <Link to="/login">{t("auth.common.backToLogin")}</Link>
          </Button>
        </div>
      </AuthShell>
    )
  }

  if (unavailable) {
    return (
      <AuthShell title={t("auth.register.title", { siteName })}>
        <div className="space-y-3 text-sm">
          <p>{t("auth.register.unavailable")}</p>
          <p className="text-muted-foreground">
            {t("auth.register.unavailableHint")}
          </p>
          <Button asChild size="sm" variant="outline" className="w-full">
            <Link to="/login">{t("auth.common.backToLogin")}</Link>
          </Button>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title={t("auth.register.title", { siteName })}
      subtitle={
        config?.registrationApprovalRequired
          ? t("auth.register.subtitleApproval")
          : t("auth.register.subtitle")
      }
    >
      <form key="register-form" className="space-y-4" onSubmit={submit}>
        <div className="space-y-1.5">
          <Label htmlFor="register-email">{t("auth.register.email")}</Label>
          <Input
            id="register-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="register-password">
            {t("auth.register.password")}
          </Label>
          <Input
            id="register-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="register-repeat">{t("auth.register.repeat")}</Label>
          <Input
            id="register-repeat"
            name="repeat-password"
            type="password"
            autoComplete="new-password"
            required
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
          />
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="sm" className="w-full" disabled={busy}>
          {busy ? t("auth.register.submitting") : t("auth.register.submit")}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          <Trans
            i18nKey="auth.register.hasAccount"
            components={{
              signin: (
                <Link to="/login" className="underline underline-offset-4" />
              )
            }}
          />
        </p>
      </form>
    </AuthShell>
  )
}
