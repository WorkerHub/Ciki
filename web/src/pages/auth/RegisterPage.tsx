import { useEffect, useState } from "react"
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
      setError("密码至少 8 位")
      return
    }
    if (password !== repeat) {
      setError("两次输入的密码不一致")
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
      <AuthShell title="注册申请已提交">
        <div className="space-y-3 text-sm">
          <p>
            {done.approvalRequired
              ? "账号已创建，正在等待管理员批准。批准后即可用同一邮箱登录。"
              : "账号已创建并激活，现在可以登录了。"}
          </p>
          <Button asChild size="sm" className="w-full">
            <Link to="/login">去登录</Link>
          </Button>
        </div>
      </AuthShell>
    )
  }

  if (config && !config.registrationEnabled) {
    return (
      <AuthShell title={`注册 ${siteName}`}>
        <div className="space-y-2 text-sm">
          <p>站点当前关闭了自助注册。</p>
          <p className="text-muted-foreground">
            请联系管理员创建账号，或直接登录已有账号。
          </p>
          <Button asChild size="sm" variant="outline" className="w-full">
            <Link to="/login">返回登录</Link>
          </Button>
        </div>
      </AuthShell>
    )
  }

  if (unavailable) {
    return (
      <AuthShell title={`注册 ${siteName}`}>
        <div className="space-y-3 text-sm">
          <p>站点还没有配置发信（SMTP），自助注册暂不可用。</p>
          <p className="text-muted-foreground">
            {
              "注册后需要用邮箱验证码验证邮箱，所以必须先配好发信：请联系管理员在「系统管理 → 邮件配置」中填写 SMTP。"
            }
          </p>
          <Button asChild size="sm" variant="outline" className="w-full">
            <Link to="/login">返回登录</Link>
          </Button>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title={`注册 ${siteName}`}
      subtitle={
        config?.registrationApprovalRequired
          ? "注册后需要验证邮箱并经管理员批准才能登录"
          : "注册后需要验证邮箱才能登录"
      }
    >
      <form key="register-form" className="space-y-4" onSubmit={submit}>
        <div className="space-y-1.5">
          <Label htmlFor="register-email">邮箱</Label>
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
          <Label htmlFor="register-password">密码（至少 8 位）</Label>
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
          <Label htmlFor="register-repeat">再次输入密码</Label>
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
          {busy ? "提交中…" : "注册"}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          已有账号？
          <Link to="/login" className="underline underline-offset-4">
            登录
          </Link>
        </p>
      </form>
    </AuthShell>
  )
}
