import { useEffect, useState } from "react"
import { Link } from "react-router"
import { AuthShell } from "@/components/AuthShell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { type AuthConfig, authApi, describeApiError } from "@/lib/api"
import { useSiteStore } from "@/stores/site"

export function RegisterPage() {
  const siteName = useSiteStore((state) => state.name)
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [repeat, setRepeat] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [done, setDone] = useState<null | { approvalRequired: boolean }>(null)

  useEffect(() => {
    let alive = true
    authApi
      .config()
      .then((value) => {
        if (alive) setConfig(value)
      })
      .catch(() => {
        if (alive)
          setConfig({
            registrationEnabled: true,
            registrationApprovalRequired: true,
            siteName: useSiteStore.getState().name,
            // 配置接口挂了就按「发信未配置」处理：注册页不涉及邮箱验证码
            emailConfigured: false
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
      const result = await authApi.register(email.trim(), password)
      setDone({ approvalRequired: result.approvalRequired })
    } catch (registerError) {
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

  return (
    <AuthShell
      title={`注册 ${siteName}`}
      subtitle={
        config?.registrationApprovalRequired
          ? "注册后需要管理员批准才能登录"
          : "注册后即可登录"
      }
    >
      {config && !config.registrationEnabled ? (
        <div className="space-y-2 text-sm">
          <p>站点当前关闭了自助注册。</p>
          <p className="text-muted-foreground">
            请联系管理员创建账号，或直接登录已有账号。
          </p>
          <Button asChild size="sm" variant="outline" className="w-full">
            <Link to="/login">返回登录</Link>
          </Button>
        </div>
      ) : (
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
      )}
    </AuthShell>
  )
}
