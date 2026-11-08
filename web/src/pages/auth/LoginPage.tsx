import { ArrowLeft, KeyRound } from "lucide-react"
import { useState } from "react"
import { Link, useNavigate } from "react-router"
import { AuthShell } from "@/components/AuthShell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authApi, describeApiError } from "@/lib/api"
import {
  authenticationCredential,
  describeWebAuthnError,
  webauthnSupported
} from "@/lib/webauthn"
import { useAuthStore } from "@/stores/auth"
import { useSiteStore } from "@/stores/site"

type Step =
  | { kind: "password" }
  | { kind: "twofa"; tempToken: string; methods: string[] }

/**
 * 两步登录（规格 §8）：
 * - 两步的 <form> 与输入框各自带不同 key，换步时 React 会换掉 DOM 节点，
 *   避免浏览器把第一步的密码输入框复用给验证码（自动填充串位）。
 * - 密码框独占 type="password"；验证码框 type="text" + one-time-code + numeric，
 *   name/id 里不含 "password"。
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
          methods: response.availableMethods
        })
        setCode("")
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

  const submitCode = async (event: React.FormEvent) => {
    event.preventDefault()
    if (step.kind !== "twofa") return
    setBusy(true)
    setError("")
    try {
      await authApi.verifyTotp(step.tempToken, code.trim())
      await finishLogin()
    } catch (verifyError) {
      setError(describeApiError(verifyError))
    } finally {
      setBusy(false)
    }
  }

  const loginWithPasskey = async () => {
    if (step.kind !== "twofa") return
    setBusy(true)
    setError("")
    try {
      const options = await authApi.passkeyAuthOptions(step.tempToken)
      const credential = await authenticationCredential(options)
      await authApi.passkeyAuthVerify(
        step.tempToken,
        credential as unknown as Record<string, unknown>
      )
      await finishLogin()
    } catch (passkeyError) {
      setError(describeWebAuthnError(passkeyError))
    } finally {
      setBusy(false)
    }
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

  const hasPasskey = step.methods.includes("passkey")

  return (
    <AuthShell
      title="两步验证"
      subtitle={`继续验证 ${email.trim() || "当前账号"}，输入验证器里的 6 位动态码。`}
    >
      <form
        key="twofa-step"
        id="twofa-step"
        className="space-y-4"
        onSubmit={submitCode}
      >
        <div className="space-y-1.5">
          <Label htmlFor="otp-code">动态验证码</Label>
          <Input
            key="otp-input"
            id="otp-code"
            name="otp-code"
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
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          size="sm"
          className="w-full"
          disabled={busy || code.length !== 6}
        >
          {busy ? "验证中…" : "验证并登录"}
        </Button>

        {hasPasskey ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full"
            disabled={busy || !webauthnSupported()}
            onClick={() => void loginWithPasskey()}
          >
            <KeyRound aria-hidden="true" />
            改用 Passkey
          </Button>
        ) : null}

        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="w-full text-muted-foreground"
          onClick={() => {
            setStep({ kind: "password" })
            setError("")
            setCode("")
          }}
        >
          <ArrowLeft aria-hidden="true" />
          返回上一步
        </Button>
      </form>
    </AuthShell>
  )
}
