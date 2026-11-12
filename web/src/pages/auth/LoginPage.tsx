import { ArrowLeft, KeyRound, Mail, ShieldAlert } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { Link, useNavigate } from "react-router"
import { AuthShell } from "@/components/AuthShell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  ApiError,
  authApi,
  describeApiError,
  type SecondFactorMethod
} from "@/lib/api"
import { waitText } from "@/lib/auth-wait"
import {
  VERIFY_CODE_TTL_MINUTES,
  VERIFY_EMAIL_PATH,
  type VerifyEmailNavState
} from "@/lib/email-verification"
import {
  authenticationCredential,
  describeWebAuthnError,
  webauthnSupported
} from "@/lib/webauthn"
import { useAuthStore } from "@/stores/auth"
import { useSiteStore } from "@/stores/site"

/** 第二步可选的方式：两种「输码」方式 + Passkey（Passkey 仍走专用端点）。 */
type TwoFaMethod = SecondFactorMethod | "passkey"

type Step =
  | { kind: "password" }
  | { kind: "twofa"; tempToken: string; methods: string[]; method: TwoFaMethod }

/** 切换器与默认落点的顺序，与契约的 availableMethods 顺序一致。 */
const METHOD_ORDER: TwoFaMethod[] = ["totp", "passkey", "email_otp"]

/** 方式名走 locale（`auth.twofa.methods.*`），加语言只加资源，不改这里。 */
const METHOD_KEYS: Record<TwoFaMethod, string> = {
  totp: "auth.twofa.methods.totp",
  passkey: "auth.twofa.methods.passkey",
  email_otp: "auth.twofa.methods.emailOtp"
}

/**
 * 登录两步（规格 §8、邮箱验证码 2FA）：
 * - 两步的 <form> 与输入框各自带不同 key，换步时 React 会换掉 DOM 节点，
 *   避免浏览器把第一步的密码输入框复用给验证码（自动填充串位）。
 * - 密码框独占 type="password"；验证码框 type="text" + one-time-code + numeric，
 *   name/id 里不含 "password"。
 * - 第二步按 availableMethods 列出可用方式；选「邮箱验证码」即向账号邮箱发码
 *   （同一个 tempToken 只自动发一次），重发有 60s 冷却倒计时。
 */
export function LoginPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const siteName = useSiteStore((state) => state.name)
  const emailConfigured = useSiteStore((state) => state.emailConfigured)
  const siteLoaded = useSiteStore((state) => state.loaded)
  /** 站点没配发信时两个邮件入口都走不通（忘记密码要收码、自助注册要先验证邮箱），
   *  一并收起，不在登录页摆点了必错的链接。站点信息还没读到之前按可用渲染，
   *  真正的判定在各自页面与服务端 503 里再兜一层。 */
  const mailEntryUnavailable = siteLoaded && !emailConfigured
  const refreshMe = useAuthStore((state) => state.refreshMe)
  const setRestricted = useAuthStore((state) => state.setRestricted)
  const setEmailConfigured = useSiteStore((state) => state.setEmailConfigured)
  const [step, setStep] = useState<Step>({ kind: "password" })
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  /** 密码正确但邮箱未验证（403 EMAIL_NOT_VERIFIED）：给验证页与重发两个入口。 */
  const [unverified, setUnverified] = useState<string | null>(null)
  /** 登录页直接重发验证码的状态（与两步验证的邮箱码各自独立）。 */
  const [resendBusy, setResendBusy] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(0)
  const [resendNote, setResendNote] = useState<
    { tone: "info"; email: string } | { tone: "error"; text: string } | null
  >(null)
  const [emailSent, setEmailSent] = useState(false)
  const [emailCooldown, setEmailCooldown] = useState(0)
  /** 已经为哪个登录挑战自动发过码：严格模式下 effect 会跑两遍，别发两封。 */
  const autoSentFor = useRef<string | null>(null)

  const accountEmail = email.trim() || t("auth.common.accountEmailFallback")
  const twofa = step.kind === "twofa" ? step : null

  const finishLogin = async () => {
    await refreshMe()
    setRestricted(false)
    navigate("/", { replace: true })
  }

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError("")
    setUnverified(null)
    setResendNote(null)
    try {
      const response = await authApi.login(email.trim(), password)
      if ("requires2fa" in response && response.requires2fa) {
        // 新一次登录（可能又拿到同一个 tempToken）要重新允许自动发码
        autoSentFor.current = null
        setStep({
          kind: "twofa",
          tempToken: response.tempToken,
          methods: response.availableMethods,
          method:
            METHOD_ORDER.find((method) =>
              response.availableMethods.includes(method)
            ) ?? "totp"
        })
        setCode("")
        setEmailSent(false)
        setEmailCooldown(0)
        return
      }
      if ("needs2faSetup" in response && response.needs2faSetup) {
        setRestricted(true)
        await refreshMe()
        navigate("/settings#security", { replace: true })
        return
      }
      await finishLogin()
    } catch (loginError) {
      // 密码已对、只是邮箱还没验证：换成带两个入口的提示块，不只是报一句话
      if (
        loginError instanceof ApiError &&
        loginError.code === "EMAIL_NOT_VERIFIED"
      ) {
        setUnverified(email.trim())
        setResendCooldown(0)
        return
      }
      setError(describeApiError(loginError))
    } finally {
      setBusy(false)
    }
  }

  /** 登录页的「重新发送验证码」（契约 200 同形，只看冷却秒数）。 */
  const resendVerification = useCallback(
    async (target: string) => {
      setResendBusy(true)
      setResendNote(null)
      try {
        const sent = await authApi.resendVerificationEmail(target)
        setResendCooldown(sent.cooldownSeconds)
        setResendNote({ tone: "info", email: target })
      } catch (sendError) {
        if (sendError instanceof ApiError && sendError.retryAfter) {
          setResendCooldown(sendError.retryAfter)
        }
        if (
          sendError instanceof ApiError &&
          sendError.code === "EMAIL_NOT_CONFIGURED"
        ) {
          setEmailConfigured(false)
        }
        setResendNote({ tone: "error", text: waitText(sendError) })
      } finally {
        setResendBusy(false)
      }
    },
    [setEmailConfigured]
  )

  const sendEmailCode = useCallback(async (tempToken: string) => {
    setBusy(true)
    setError("")
    try {
      const sent = await authApi.sendLoginEmailCode(tempToken)
      setEmailSent(true)
      setEmailCooldown(sent.cooldownSeconds)
      setCode("")
    } catch (sendError) {
      // 429 带 retryAfter：冷却按服务端给的剩余秒数起步
      if (sendError instanceof ApiError && sendError.retryAfter) {
        setEmailCooldown(sendError.retryAfter)
      }
      setError(describeApiError(sendError))
    } finally {
      setBusy(false)
    }
  }, [])

  // 选到「邮箱验证码」就发码；同一个 tempToken 不再重复自动发。
  const emailToken = twofa?.method === "email_otp" ? twofa.tempToken : null
  useEffect(() => {
    if (!emailToken || autoSentFor.current === emailToken) return
    autoSentFor.current = emailToken
    void sendEmailCode(emailToken)
  }, [emailToken, sendEmailCode])

  useEffect(() => {
    if (emailCooldown <= 0) return
    const timer = setTimeout(
      () => setEmailCooldown((left) => Math.max(0, left - 1)),
      1000
    )
    return () => clearTimeout(timer)
  }, [emailCooldown])

  useEffect(() => {
    if (resendCooldown <= 0) return
    const timer = setTimeout(
      () => setResendCooldown((left) => Math.max(0, left - 1)),
      1000
    )
    return () => clearTimeout(timer)
  }, [resendCooldown])

  const submitCode = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!twofa || twofa.method === "passkey") return
    setBusy(true)
    setError("")
    try {
      await authApi.verifySecondFactor(
        twofa.tempToken,
        twofa.method,
        code.trim()
      )
      await finishLogin()
    } catch (verifyError) {
      setError(describeApiError(verifyError))
    } finally {
      setBusy(false)
    }
  }

  const loginWithPasskey = async (tempToken: string) => {
    setBusy(true)
    setError("")
    try {
      const options = await authApi.passkeyAuthOptions(tempToken)
      const credential = await authenticationCredential(options)
      await authApi.passkeyAuthVerify(
        tempToken,
        credential as unknown as Record<string, unknown>
      )
      await finishLogin()
    } catch (passkeyError) {
      setError(describeWebAuthnError(passkeyError))
    } finally {
      setBusy(false)
    }
  }

  const selectMethod = (method: TwoFaMethod) => {
    if (!twofa || method === twofa.method) return
    setStep({ ...twofa, method })
    setCode("")
    setError("")
  }

  if (step.kind === "password") {
    return (
      <AuthShell title={t("auth.login.title", { siteName })}>
        <form
          key="password-step"
          id="password-step"
          className="space-y-4"
          onSubmit={submitPassword}
        >
          <div className="space-y-1.5">
            <Label htmlFor="login-email">{t("auth.login.email")}</Label>
            <Input
              id="login-email"
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
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="login-password">{t("auth.login.password")}</Label>
              {mailEntryUnavailable ? (
                <span
                  aria-disabled="true"
                  title={t("auth.login.forgotUnavailable")}
                  className="cursor-not-allowed text-xs text-muted-foreground/60"
                >
                  {t("auth.login.forgot")}
                </span>
              ) : (
                <Link
                  to="/forgot-password"
                  className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  {t("auth.login.forgot")}
                </Link>
              )}
            </div>
            <Input
              key="password-input"
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {unverified ? (
            <div
              role="alert"
              className="space-y-2 rounded-lg border border-border bg-muted/40 p-3 text-xs"
            >
              <p className="flex items-start gap-1.5">
                <ShieldAlert
                  className="mt-px size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span>{t("auth.login.unverified", { email: unverified })}</span>
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild size="xs" variant="outline">
                  <Link
                    to={VERIFY_EMAIL_PATH}
                    state={
                      {
                        email: unverified,
                        // 刚在这页重发过：验证页进去也按冷却计，避免立刻再撞 429
                        codeSent: resendNote?.tone === "info"
                      } satisfies VerifyEmailNavState
                    }
                  >
                    {t("auth.login.verifyNow")}
                  </Link>
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={resendBusy || resendCooldown > 0}
                  onClick={() => void resendVerification(unverified)}
                >
                  {resendCooldown > 0
                    ? t("auth.common.resendIn", { seconds: resendCooldown })
                    : t("auth.common.resend")}
                </Button>
              </div>
              {resendNote ? (
                <p
                  role="status"
                  className={
                    resendNote.tone === "error"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {resendNote.tone === "error"
                    ? resendNote.text
                    : t("auth.common.codeSentTo", {
                        email: resendNote.email,
                        minutes: VERIFY_CODE_TTL_MINUTES
                      })}
                </p>
              ) : null}
            </div>
          ) : error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="sm" className="w-full" disabled={busy}>
            {busy ? t("auth.login.submitting") : t("auth.login.submit")}
          </Button>
          {mailEntryUnavailable ? (
            <p className="text-xs text-muted-foreground">
              {t("auth.login.smtpMissing")}
            </p>
          ) : null}
          {mailEntryUnavailable ? (
            // 发信不可用时上面那行已说明原因：这行只说账号怎么来，不重复 SMTP
            <p className="text-center text-xs text-muted-foreground">
              {t("auth.login.accountViaAdmin")}
            </p>
          ) : (
            <p className="text-center text-xs text-muted-foreground">
              <Trans
                i18nKey="auth.login.noAccount"
                components={{
                  signup: (
                    <Link
                      to="/register"
                      className="underline underline-offset-4"
                    />
                  )
                }}
              />
            </p>
          )}
        </form>
      </AuthShell>
    )
  }

  const isEmailCode = step.method === "email_otp"
  const isPasskey = step.method === "passkey"
  const subtitle = isEmailCode
    ? t("auth.twofa.subtitleEmail", { account: accountEmail })
    : isPasskey
      ? t("auth.twofa.subtitlePasskey", { account: accountEmail })
      : t("auth.twofa.subtitleTotp", { account: accountEmail })
  const codeInputId = isEmailCode ? "email-otp-code" : "otp-code"
  const methods = METHOD_ORDER.filter((method) => step.methods.includes(method))

  return (
    <AuthShell title={t("auth.twofa.title")} subtitle={subtitle}>
      <form
        key="twofa-step"
        id="twofa-step"
        className="space-y-4"
        onSubmit={submitCode}
      >
        {methods.length > 1 ? (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            className="w-full"
            value={step.method}
            onValueChange={(value) => {
              if (value) selectMethod(value as TwoFaMethod)
            }}
            aria-label={t("auth.twofa.methodsLabel")}
          >
            {methods.map((method) => (
              <ToggleGroupItem
                key={method}
                value={method}
                className="flex-1"
                disabled={busy}
              >
                {t(METHOD_KEYS[method])}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}

        {step.method === "passkey" ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {t("auth.twofa.passkeyHint")}
            </p>
            <Button
              type="button"
              size="sm"
              className="w-full"
              disabled={busy || !webauthnSupported()}
              onClick={() => void loginWithPasskey(step.tempToken)}
              title={
                webauthnSupported()
                  ? undefined
                  : t("auth.twofa.passkeyUnsupported")
              }
            >
              <KeyRound aria-hidden="true" />
              {busy
                ? t("auth.twofa.passkeyWaiting")
                : t("auth.twofa.passkeySubmit")}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="space-y-1.5">
              <Label htmlFor={codeInputId}>
                {isEmailCode
                  ? t("auth.twofa.codeLabelEmail")
                  : t("auth.twofa.codeLabelTotp")}
              </Label>
              <Input
                key={codeInputId}
                id={codeInputId}
                name={codeInputId}
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
            {isEmailCode ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Mail className="size-3.5" aria-hidden="true" />
                  {emailSent
                    ? t("auth.twofa.codeSent", { email: accountEmail })
                    : t("auth.twofa.codeWillSend")}
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy || emailCooldown > 0}
                  onClick={() => void sendEmailCode(step.tempToken)}
                >
                  {emailCooldown > 0
                    ? t("auth.common.resendIn", { seconds: emailCooldown })
                    : emailSent
                      ? t("auth.twofa.resend")
                      : t("auth.twofa.sendCode")}
                </Button>
              </div>
            ) : null}
          </div>
        )}

        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {isPasskey ? null : (
          <Button
            type="submit"
            size="sm"
            className="w-full"
            disabled={busy || code.length !== 6}
          >
            {busy ? t("auth.twofa.verifying") : t("auth.twofa.verify")}
          </Button>
        )}

        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="w-full text-muted-foreground"
          onClick={() => {
            // 退回第一步时要一并作废「已自动发过码」的记账，否则再登录一次
            // 若后端派回同一个 tempToken，会自动发码被误判为已发而跳过。
            autoSentFor.current = null
            setStep({ kind: "password" })
            setError("")
            setCode("")
            setEmailSent(false)
            setEmailCooldown(0)
          }}
        >
          <ArrowLeft aria-hidden="true" />
          {t("auth.twofa.back")}
        </Button>
      </form>
    </AuthShell>
  )
}
