import { Database, KeyRound } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router"
import { AuthShell } from "@/components/AuthShell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  ApiError,
  describeApiError,
  type SetupResult,
  type SetupState,
  setupApi
} from "@/lib/api"

/**
 * 初始化页（规格 §5A.6）：只认 SETUP_SECRET 请求头，密钥框 id/name 固定为
 * setup-secret、autocomplete 关掉、提交后清空。初始化完成后再进来只显示结果，
 * 不再重复建库；任何情况下都没有删表/清库入口。
 */
export function SetupPage() {
  const [state, setState] = useState<SetupState | null>(null)
  const [secret, setSecret] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState<SetupResult | null>(null)
  const [conflict, setConflict] = useState<{
    prefixes: string[]
    resolved: string
  } | null>(null)

  useEffect(() => {
    let alive = true
    setupApi
      .state()
      .then((value) => {
        if (alive) setState(value)
      })
      .catch(() => {
        if (alive) setState({ initialized: false, enabled: true })
      })
    return () => {
      alive = false
    }
  }, [])

  const run = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError("")
    setConflict(null)
    try {
      const value = await setupApi.run(secret.trim())
      setResult(value)
      setState({ initialized: true, enabled: false })
    } catch (runError) {
      if (runError instanceof ApiError && runError.code === "PREFIX_CONFLICT") {
        setConflict({
          prefixes: runError.details?.detectedPrefixes ?? [],
          resolved: runError.details?.resolvedPrefix ?? ""
        })
        setError("检测到另一套表前缀下已有数据，初始化已中止。")
      } else if (runError instanceof ApiError && runError.status === 403) {
        setError("初始化密钥不正确，请确认部署时配置的 SETUP_SECRET。")
      } else if (runError instanceof ApiError && runError.status === 429) {
        setError("尝试过于频繁（同一 IP 每 10 分钟 3 次），请稍后再试。")
      } else {
        setError(describeApiError(runError))
      }
    } finally {
      setSecret("")
      setBusy(false)
    }
  }

  if (!state) {
    return (
      <AuthShell title="ciki">
        <p className="text-center text-sm text-muted-foreground">
          正在检查初始化状态…
        </p>
      </AuthShell>
    )
  }

  const disabled = state.initialized && !state.enabled

  return (
    <AuthShell
      title={
        <span className="inline-flex items-center gap-2">
          <Database
            className="size-5 text-muted-foreground"
            aria-hidden="true"
          />
          ciki 初始化
        </span>
      }
      subtitle={
        disabled
          ? "站点已完成初始化。"
          : "第一次部署需要先建表，然后用 SETUP_SECRET 完成初始化；之后注册的首个账号会成为管理员。"
      }
    >
      <div className="space-y-4">
        {result ? (
          <div className="space-y-2 rounded-lg bg-muted/50 p-3 text-sm">
            <p className="font-medium">初始化完成</p>
            <p className="text-xs text-muted-foreground">生效的表前缀</p>
            <p className="font-mono">{result.tablePrefix || "（无前缀）"}</p>
            <Separator />
            <ul className="space-y-1 text-xs">
              {result.migrations.map((migration) => (
                <li key={migration.name} className="flex justify-between gap-3">
                  <span className="font-mono">{migration.name}</span>
                  <span className="text-muted-foreground">
                    {migration.status === "applied" ? "已应用" : "已是最新"}
                  </span>
                </li>
              ))}
            </ul>
            <Button asChild size="sm" className="mt-1 w-full">
              <Link to="/register">注册首个管理员账号</Link>
            </Button>
            <Button asChild size="sm" variant="ghost" className="w-full">
              <Link to="/login">去登录</Link>
            </Button>
          </div>
        ) : disabled ? (
          <div className="space-y-3 text-sm">
            <p>初始化页已经在系统设置里关闭，说明数据库已就绪。</p>
            <Button asChild size="sm" variant="outline" className="w-full">
              <Link to="/login">去登录</Link>
            </Button>
          </div>
        ) : (
          <form key="setup-form" className="space-y-4" onSubmit={run}>
            <div className="space-y-1.5">
              <Label htmlFor="setup-secret">SETUP_SECRET</Label>
              <Input
                id="setup-secret"
                name="setup-secret"
                type="password"
                autoComplete="off"
                required
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder="部署时配置的初始化密钥"
              />
              <p className="text-[11px] text-muted-foreground">
                密钥只会放进请求头，不会出现在地址栏；每次尝试都按来源 IP 限流。
              </p>
            </div>
            {error ? (
              <div role="alert" className="space-y-1 text-xs text-destructive">
                <p>{error}</p>
                {conflict ? (
                  <p className="text-muted-foreground">
                    当前解析出的前缀是{" "}
                    <code className="font-mono">
                      {conflict.resolved || "—"}
                    </code>
                    {conflict.prefixes.length
                      ? `，但另一个前缀 ${conflict.prefixes.join("、")} 下已经存在本项目的数据`
                      : ""}
                    。为避免出现两套表，初始化已中止，请联系部署负责人确认
                    TABLE_PREFIX。
                  </p>
                ) : null}
              </div>
            ) : null}
            <Button type="submit" size="sm" className="w-full" disabled={busy}>
              <KeyRound aria-hidden="true" />
              {busy ? "初始化中…" : "初始化数据库"}
            </Button>
            <p className="text-[11px] text-muted-foreground">
              重复执行只会做幂等检查/迁移，不会重建表，也不会清空数据。
            </p>
          </form>
        )}
      </div>
    </AuthShell>
  )
}
