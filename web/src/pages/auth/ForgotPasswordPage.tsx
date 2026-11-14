import { ArrowLeft, KeyRound, Mail } from "lucide-react"
import { useEffect, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { Link } from "react-router"
import { AuthShell } from "@/components/AuthShell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ApiError, authApi, describeApiError } from "@/lib/api"
import { waitText } from "@/lib/auth-wait"
import { useSiteStore } from "@/stores/site"

/**
 * 邮箱找回密码（#48 冻结契约的前端部分，三步）：
 * 输账号邮箱 → 发码 → 验码换一次性 resetToken → 设新密码。
 *
 * 三条不能破坏的规矩：
 * - 第一步一律按同一句话展示结果，不从 200/文案推断邮箱是否存在（防枚举）；
 * - 第二步错码、过期、账号不存在都只显示同一句「验证码不正确或已过期」，
 *   连续输错 5 次按契约作废，提示重新获取；
 * - 第三步只拿 resetToken 说话，成功后后端已让该账号全部会话失效，
 *   这里不自动登录，明确引导回登录页。
 */
type Step = "email" | "code" | "password"

export function ForgotPasswordPage() {
  const { t } = useTranslation()
  const emailConfigured = useSiteStore((state) => state.emailConfigured)
  const siteLoaded = useSiteStore((state) => state.loaded)
  const setEmailConfigured = useSiteStore((state) => state.setEmailConfigured)

  const [step, setStep] = useState<Step>("email")
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [resetToken, setResetToken] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [repeat, setRepeat] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [done, setDone] = useState(false)
  /** 站点是否配了发信：公开配置说 false 就整页换成「不可用」分支；
   *  提交时服务端回 503 也算权威结论（配置可能在打开页面之后被清掉）。 */
  const [emailUnavailable, setEmailUnavailable] = useState(false)
  /** 重发冷却（契约 60 秒，429 时按 retryAfter 起步）。 */
  const [cooldown, setCooldown] = useState(0)
  /** 验码被限流后的等待秒数：这段时间里提交按钮不装能点。 */
  const [verifyWait, setVerifyWait] = useState(0)
  /** 本页连续输错的次数；第 5 次按契约这枚码已作废。 */
  const [wrongCode, setWrongCode] = useState(0)

  const unavailable = emailUnavailable || (siteLoaded && !emailConfigured)
  const accountEmail = email.trim() || t("auth.common.accountEmailFallback")

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(
      () => setCooldown((left) => Math.max(0, left - 1)),
      1000
    )
    return () => clearTimeout(timer)
  }, [cooldown])

  useEffect(() => {
    if (verifyWait <= 0) return
    const timer = setTimeout(
      () => setVerifyWait((left) => Math.max(0, left - 1)),
      1000
    )
    return () => clearTimeout(timer)
  }, [verifyWait])

  const sendCode = async (event?: React.FormEvent) => {
    event?.preventDefault()
    setBusy(true)
    setError("")
    try {
      const sent = await authApi.passwordForgot(email.trim())
      // 响应与账号是否存在无关：只拿冷却秒数，文案保持「如果已注册」的中性说法
      setCooldown(sent.cooldownSeconds)
      setCode("")
      setWrongCode(0)
      setVerifyWait(0)
      setStep("code")
    } catch (sendError) {
      if (
        sendError instanceof ApiError &&
        sendError.code === "EMAIL_NOT_CONFIGURED"
      ) {
        setEmailUnavailable(true)
        setEmailConfigured(false)
        return
      }
      if (sendError instanceof ApiError && sendError.retryAfter) {
        setCooldown(sendError.retryAfter)
      }
      setError(waitText(sendError))
    } finally {
      setBusy(false)
    }
  }

  const verifyCode = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      const grant = await authApi.passwordVerify(email.trim(), code.trim())
      setResetToken(grant.resetToken)
      setCode("")
      setStep("password")
    } catch (verifyError) {
      if (
        verifyError instanceof ApiError &&
        verifyError.code === "RATE_LIMITED"
      ) {
        if (verifyError.retryAfter) setVerifyWait(verifyError.retryAfter)
        setError(waitText(verifyError))
        return
      }
      const failed = wrongCode + 1
      setWrongCode(failed)
      if (failed >= 5) {
        // 契约：第 5 次错误删除该码，只能重新发码
        setCode("")
        setError(t("auth.forgot.wrongCode"))
        return
      }
      setError(describeApiError(verifyError))
    } finally {
      setBusy(false)
    }
  }

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault()
    setError("")
    // 强度校验沿用注册 / 改密口径（至少 8 位），服务端同样会拦（WEAK_PASSWORD）
    if (newPassword.length < 8) {
      setError(t("auth.forgot.passwordTooShort"))
      return
    }
    if (newPassword !== repeat) {
      setError(t("auth.common.passwordMismatch"))
      return
    }
    setBusy(true)
    try {
      await authApi.passwordReset(resetToken, newPassword)
      setNewPassword("")
      setRepeat("")
      setResetToken("")
      setDone(true)
    } catch (resetError) {
      // 设密端点也有 5 次 / 5 分钟的提交限流（#48 契约），同样带出剩余时间
      setError(waitText(resetError))
    } finally {
      setBusy(false)
    }
  }

  /** 回到第一步重新发码：邮箱保留，验证码与凭证一律清掉。 */
  const restart = () => {
    setStep("email")
    setCode("")
    setResetToken("")
    setWrongCode(0)
    setVerifyWait(0)
    setError("")
  }

  if (done) {
    return (
      <AuthShell title={t("auth.forgot.doneTitle")}>
        <div className="space-y-3 text-sm">
          <p>{t("auth.forgot.doneBody")}</p>
          <p className="text-muted-foreground">{t("auth.forgot.doneHint")}</p>
          <Button asChild size="sm" className="w-full">
            <Link to="/login">{t("auth.common.goLogin")}</Link>
          </Button>
        </div>
      </AuthShell>
    )
  }

  if (unavailable) {
    return (
      <AuthShell title={t("auth.forgot.title")}>
        <div className="space-y-3 text-sm">
          <p>{t("auth.forgot.unavailable")}</p>
          <p className="text-muted-foreground">
            {t("auth.forgot.unavailableHint")}
          </p>
          <Button asChild size="sm" variant="outline" className="w-full">
            <Link to="/login">{t("auth.common.backToLogin")}</Link>
          </Button>
        </div>
      </AuthShell>
    )
  }

  if (step === "code") {
    return (
      <AuthShell
        title={t("auth.forgot.codeTitle")}
        subtitle={t("auth.forgot.codeSubtitle", { email: accountEmail })}
      >
        <form
          key="forgot-code-step"
          id="forgot-code-step"
          className="space-y-4"
          onSubmit={verifyCode}
        >
          <div className="space-y-2">
            <div className="space-y-1.5">
              <Label htmlFor="reset-code">{t("auth.forgot.codeLabel")}</Label>
              <Input
                id="reset-code"
                name="reset-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                required
                value={code}
                onChange={(event) =>
                  setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                }
                placeholder="123456"
                className="w-36 text-center font-mono text-lg tracking-[0.4em]"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Mail className="size-3.5" aria-hidden="true" />
                {t("auth.forgot.codeHint")}
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busy || cooldown > 0}
                onClick={() => void sendCode()}
              >
                {cooldown > 0
                  ? t("auth.common.resendIn", { seconds: cooldown })
                  : t("auth.common.resend")}
              </Button>
            </div>
          </div>

          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            size="sm"
            className="w-full"
            disabled={busy || verifyWait > 0 || code.length !== 6}
          >
            {busy ? t("auth.forgot.verifying") : t("auth.forgot.submit")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="w-full text-muted-foreground"
            disabled={busy}
            onClick={restart}
          >
            <ArrowLeft aria-hidden="true" />
            {t("auth.forgot.back")}
          </Button>
        </form>
      </AuthShell>
    )
  }

  if (step === "password") {
    return (
      <AuthShell
        title={t("auth.forgot.passwordTitle")}
        subtitle={t("auth.forgot.passwordSubtitle")}
      >
        <form
          key="forgot-password-step"
          id="forgot-password-step"
          className="space-y-4"
          onSubmit={submitPassword}
        >
          <p className="text-xs text-muted-foreground">
            {t("auth.forgot.passwordHint")}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="reset-new-password">
              {t("auth.forgot.newPassword")}
            </Label>
            <Input
              id="reset-new-password"
              name="new-password"
              type="password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reset-repeat-password">
              {t("auth.forgot.repeat")}
            </Label>
            <Input
              id="reset-repeat-password"
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
            <KeyRound aria-hidden="true" />
            {busy ? t("auth.forgot.saving") : t("auth.forgot.save")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="w-full text-muted-foreground"
            disabled={busy}
            onClick={restart}
          >
            {t("auth.forgot.resend")}
          </Button>
        </form>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title={t("auth.forgot.title")}
      subtitle={t("auth.forgot.subtitle")}
    >
      <form
        key="forgot-email-step"
        id="forgot-email-step"
        className="space-y-4"
        onSubmit={sendCode}
      >
        <div className="space-y-1.5">
          <Label htmlFor="reset-email">{t("auth.forgot.email")}</Label>
          <Input
            id="reset-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t("auth.forgot.emailHint")}
        </p>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="sm" className="w-full" disabled={busy}>
          <Mail aria-hidden="true" />
          {busy ? t("auth.forgot.sending") : t("auth.forgot.send")}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          <Trans
            i18nKey="auth.forgot.remembered"
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
