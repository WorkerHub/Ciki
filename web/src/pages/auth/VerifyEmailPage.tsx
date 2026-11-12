import { CircleCheck, Mail } from "lucide-react"
import { useEffect, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { Link, useLocation, useSearchParams } from "react-router"
import { AuthShell } from "@/components/AuthShell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ApiError, authApi, describeApiError } from "@/lib/api"
import { waitText } from "@/lib/auth-wait"
import {
  RESEND_COOLDOWN_SECONDS,
  VERIFY_CODE_TTL_MINUTES,
  verifyEmailEntry
} from "@/lib/email-verification"
import { useSiteStore } from "@/stores/site"

/** 输入框下方的一行反馈：成功存目标邮箱、失败存原始错误，显示时再按当前语言取文案。 */
type Note = { tone: "info"; email: string } | { tone: "error"; text: string }

/**
 * 注册邮箱验证页（#85 冻结契约的前端部分）。
 *
 * 未登录可访问：验证只认「邮箱 + 验证码」，不要求会话；成功后只置已验证、
 * 不发放会话，因此这里不自动登录，只引导回登录页。
 *
 * 两条不能破坏的规矩：
 * - 错码、过期、已用过、未知邮箱只显示同一句「验证码不正确或已过期。」，
 *   不从文案透出账号是否存在；
 * - 重发一律 200（账号存在与否同形），页面只看冷却秒数，不据此宣布「已发送到」以外的事。
 */
export function VerifyEmailPage() {
  const { t } = useTranslation()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const entry = verifyEmailEntry(location.state, searchParams.get("email"))
  const emailConfigured = useSiteStore((state) => state.emailConfigured)
  const siteLoaded = useSiteStore((state) => state.loaded)
  const setEmailConfigured = useSiteStore((state) => state.setEmailConfigured)

  const [email, setEmail] = useState(entry.email)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [note, setNote] = useState<Note | null>(null)
  const [done, setDone] = useState(false)
  /** 站点没配发信时整页换成不可用分支：没有 SMTP 就收不到验证码。 */
  const [emailUnavailable, setEmailUnavailable] = useState(false)
  /** 重发冷却：注册成功后进页时服务端已发过一封，先按合约的 60 秒锁住。 */
  const [cooldown, setCooldown] = useState(
    entry.codeSent ? RESEND_COOLDOWN_SECONDS : 0
  )
  /** 验码被限流后的等待秒数：这段时间里提交按钮不装能点。 */
  const [verifyWait, setVerifyWait] = useState(0)

  const unavailable = emailUnavailable || (siteLoaded && !emailConfigured)
  const target = email.trim()

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

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!target) {
      setError(t("auth.verify.missingEmail"))
      return
    }
    setBusy(true)
    setError("")
    try {
      await authApi.verifyEmail(target, code.trim())
      setCode("")
      setDone(true)
    } catch (verifyError) {
      if (
        verifyError instanceof ApiError &&
        verifyError.code === "RATE_LIMITED"
      ) {
        if (verifyError.retryAfter) setVerifyWait(verifyError.retryAfter)
        setError(waitText(verifyError))
        return
      }
      setError(describeApiError(verifyError))
    } finally {
      setBusy(false)
    }
  }

  const resend = async () => {
    setBusy(true)
    setError("")
    setNote(null)
    try {
      const sent = await authApi.resendVerificationEmail(target)
      setCooldown(sent.cooldownSeconds || RESEND_COOLDOWN_SECONDS)
      // 新码换掉旧码：把已输入的旧码清掉，免得反复拿它去试
      setCode("")
      setNote({ tone: "info", email: target })
    } catch (sendError) {
      if (sendError instanceof ApiError && sendError.retryAfter) {
        setCooldown(sendError.retryAfter)
      }
      if (
        sendError instanceof ApiError &&
        sendError.code === "EMAIL_NOT_CONFIGURED"
      ) {
        setEmailUnavailable(true)
        setEmailConfigured(false)
        return
      }
      setNote({ tone: "error", text: waitText(sendError) })
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <AuthShell title={t("auth.verify.doneTitle")}>
        <div className="space-y-3 text-sm">
          <p className="flex items-start gap-1.5">
            <CircleCheck
              className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-500"
              aria-hidden="true"
            />
            <span>
              {entry.approvalRequired
                ? t("auth.verify.donePending", { email: target })
                : t("auth.verify.doneApproved", { email: target })}
            </span>
          </p>
          <Button asChild size="sm" className="w-full">
            <Link to="/login">{t("auth.common.goLogin")}</Link>
          </Button>
        </div>
      </AuthShell>
    )
  }

  if (unavailable) {
    return (
      <AuthShell title={t("auth.verify.title")}>
        <div className="space-y-3 text-sm">
          <p>{t("auth.verify.unavailable")}</p>
          <p className="text-muted-foreground">
            {t("auth.verify.unavailableHint")}
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
      title={t("auth.verify.title")}
      subtitle={
        target
          ? t("auth.verify.subtitleWithEmail", { email: target })
          : t("auth.verify.subtitle")
      }
    >
      <form
        key="verify-email-step"
        id="verify-email-step"
        className="space-y-4"
        onSubmit={submit}
      >
        <div className="space-y-1.5">
          <Label htmlFor="verify-email">{t("auth.verify.email")}</Label>
          <Input
            id="verify-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <div className="space-y-2">
          <div className="space-y-1.5">
            <Label htmlFor="verify-code">{t("auth.verify.code")}</Label>
            <Input
              id="verify-code"
              name="verify-code"
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
              {t("auth.verify.ttl", { minutes: VERIFY_CODE_TTL_MINUTES })}
            </span>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy || cooldown > 0 || !target}
              onClick={() => void resend()}
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
        {note ? (
          <p
            role={note.tone === "error" ? "alert" : "status"}
            className={
              note.tone === "error"
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {note.tone === "error"
              ? note.text
              : t("auth.common.codeSentTo", {
                  email: note.email,
                  minutes: VERIFY_CODE_TTL_MINUTES
                })}
          </p>
        ) : null}

        <Button
          type="submit"
          size="sm"
          className="w-full"
          disabled={busy || verifyWait > 0 || code.length !== 6}
        >
          {busy ? t("auth.verify.verifying") : t("auth.verify.submit")}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          <Trans
            i18nKey="auth.verify.alreadyVerified"
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
