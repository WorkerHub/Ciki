import { ArrowLeft, KeyRound, Mail } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
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

const METHOD_LABELS: Record<TwoFaMethod, string> = {
  totp: "验证器 App",
  passkey: "Passkey",
  email_otp: "邮箱验证码"
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
  const navigate = useNavigate()
  const siteName = useSiteStore((state) => state.name)
  const refreshMe = useAuthStore((state) => state.refreshMe)
  const setRestricted = useAuthStore((state) => state.setRestricted)
  const [step, setStep] = useState<Step>({ kind: "password" })
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [emailSent, setEmailSent] = useState(false)
  const [emailCooldown, setEmailCooldown] = useState(0)
  /** 已经为哪个登录挑战自动发过码：严格模式下 effect 会跑两遍，别发两封。 */
  const autoSentFor = useRef<string | null>(null)

  const accountEmail = email.trim() || "账号邮箱"
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
    try {
      const response = await authApi.login(email.trim(), password)
      if ("requires2fa" in response && response.requires2fa) {
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
      setError(describeApiError(loginError))
    } finally {
      setBusy(false)
    }
  }

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
      <AuthShell
        title={`登录 ${siteName}`}
        subtitle="把 Confluence 页面原样搬进来的团队 wiki"
      >
        <form
          key="password-step"
          id="password-step"
          className="space-y-4"
          onSubmit={submitPassword}
        >
          <div className="space-y-1.5">
            <Label htmlFor="login-email">邮箱</Label>
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
            <Label htmlFor="login-password">密码</Label>
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
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="sm" className="w-full" disabled={busy}>
            {busy ? "登录中…" : "登录"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            还没有账号？
            <Link to="/register" className="underline underline-offset-4">
              注册
            </Link>
          </p>
        </form>
      </AuthShell>
    )
  }

  const isEmailCode = step.method === "email_otp"
  const isPasskey = step.method === "passkey"
  const subtitle = isEmailCode
    ? `继续验证 ${accountEmail}，验证码会发到账号邮箱。`
    : isPasskey
      ? `继续验证 ${accountEmail}，使用已登记的 Passkey。`
      : `继续验证 ${accountEmail}，输入验证器里的 6 位动态码。`
  const codeInputId = isEmailCode ? "email-otp-code" : "otp-code"
  const methods = METHOD_ORDER.filter((method) => step.methods.includes(method))

  return (
    <AuthShell title="两步验证" subtitle={subtitle}>
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
            aria-label="验证方式"
          >
            {methods.map((method) => (
              <ToggleGroupItem
                key={method}
                value={method}
                className="flex-1"
                disabled={busy}
              >
                {METHOD_LABELS[method]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}

        {step.method === "passkey" ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              浏览器会弹出指纹 / 面容 / 安全钥匙验证，不需要输入验证码。
            </p>
            <Button
              type="button"
              size="sm"
              className="w-full"
              disabled={busy || !webauthnSupported()}
              onClick={() => void loginWithPasskey(step.tempToken)}
              title={
                webauthnSupported() ? undefined : "当前浏览器不支持 WebAuthn"
              }
            >
              <KeyRound aria-hidden="true" />
              {busy ? "等待验证…" : "使用 Passkey 验证"}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="space-y-1.5">
              <Label htmlFor={codeInputId}>
                {isEmailCode ? "邮箱验证码" : "动态验证码"}
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
                    ? `验证码已发送到 ${accountEmail}`
                    : "选这个方式会向账号邮箱发送 6 位验证码"}
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy || emailCooldown > 0}
                  onClick={() => void sendEmailCode(step.tempToken)}
                >
                  {emailCooldown > 0
                    ? `${emailCooldown}s 后可重发`
                    : emailSent
                      ? "重新发送"
                      : "发送验证码"}
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
            {busy ? "验证中…" : "验证并登录"}
          </Button>
        )}

        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="w-full text-muted-foreground"
          onClick={() => {
            setStep({ kind: "password" })
            setError("")
            setCode("")
            setEmailSent(false)
            setEmailCooldown(0)
          }}
        >
          <ArrowLeft aria-hidden="true" />
          返回上一步
        </Button>
      </form>
    </AuthShell>
  )
}
