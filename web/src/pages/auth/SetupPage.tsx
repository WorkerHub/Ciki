import { Database, KeyRound } from "lucide-react"
import { useEffect, useState } from "react"
import { currentLanguage } from "@/i18n"
import { Trans, useTranslation } from "react-i18next"
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
  setupApi
} from "@/lib/api"
import { useSetupGateStore } from "@/stores/setup"
import { useSiteStore } from "@/stores/site"

/**
 * 初始化页（规格 §5A.6）：只认 SETUP_SECRET 请求头，密钥框 id/name 固定为
 * setup-secret、autocomplete 关掉、提交后清空。初始化完成后再进来只显示结果，
 * 不再重复建库；任何情况下都没有删表/清库入口。
 */
export function SetupPage() {
  const { t } = useTranslation()
  // 与 RootGate 共用同一份状态：初始化成功后重拉一次，根门立刻放行
  const gateState = useSetupGateStore((state) => state.state)
  const loadSetup = useSetupGateStore((state) => state.load)
  const siteName = useSiteStore((state) => state.name)
  const [secret, setSecret] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState<SetupResult | null>(null)
  const [conflict, setConflict] = useState<{
    prefixes: string[]
    resolved: string
  } | null>(null)

  useEffect(() => {
    if (gateState === null) void loadSetup()
  }, [gateState, loadSetup])

  const run = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError("")
    setConflict(null)
    try {
      const value = await setupApi.run(secret.trim(), currentLanguage())
      setResult(value)
      // 让根门拿到服务端真实状态（initialized: true / enabled: false），
      // 否则下面的「注册首个管理员」会被重定向回 /setup
      await loadSetup()
    } catch (runError) {
      if (runError instanceof ApiError && runError.code === "PREFIX_CONFLICT") {
        setConflict({
          prefixes: runError.details?.detectedPrefixes ?? [],
          resolved: runError.details?.resolvedPrefix ?? ""
        })
        setError(t("auth.setup.conflict"))
      } else if (runError instanceof ApiError && runError.status === 403) {
        setError(t("auth.setup.invalidSecret"))
      } else if (runError instanceof ApiError && runError.status === 429) {
        setError(t("auth.setup.rateLimited"))
      } else {
        setError(describeApiError(runError))
      }
    } finally {
      setSecret("")
      setBusy(false)
    }
  }

  const state =
    gateState === "error" ? { initialized: false, enabled: true } : gateState

  if (!state) {
    return (
      <AuthShell title={siteName}>
        <p className="text-center text-sm text-muted-foreground">
          {t("auth.setup.checking")}
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
          {t("auth.setup.title", { siteName })}
        </span>
      }
      subtitle={
        disabled ? t("auth.setup.doneSubtitle") : t("auth.setup.subtitle")
      }
    >
      <div className="space-y-4">
        {result ? (
          <div className="space-y-2 rounded-lg bg-muted/50 p-3 text-sm">
            <p className="font-medium">{t("auth.setup.doneTitle")}</p>
            <p className="text-xs text-muted-foreground">
              {t("auth.setup.tablePrefix")}
            </p>
            <p className="font-mono">
              {result.tablePrefix || t("auth.setup.noPrefix")}
            </p>
            <Separator />
            <ul className="space-y-1 text-xs">
              {result.migrations.map((migration) => (
                <li key={migration.name} className="flex justify-between gap-3">
                  <span className="font-mono">{migration.name}</span>
                  <span className="text-muted-foreground">
                    {migration.status === "applied"
                      ? t("auth.setup.migrationApplied")
                      : t("auth.setup.migrationCurrent")}
                  </span>
                </li>
              ))}
            </ul>
            <Button asChild size="sm" className="mt-1 w-full">
              <Link to="/register">{t("auth.setup.registerAdmin")}</Link>
            </Button>
            <Button asChild size="sm" variant="ghost" className="w-full">
              <Link to="/login">{t("auth.common.goLogin")}</Link>
            </Button>
          </div>
        ) : disabled ? (
          <div className="space-y-3 text-sm">
            <p>{t("auth.setup.disabled")}</p>
            <Button asChild size="sm" variant="outline" className="w-full">
              <Link to="/login">{t("auth.common.goLogin")}</Link>
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
                placeholder={t("auth.setup.secretPlaceholder")}
              />
              <p className="text-[11px] text-muted-foreground">
                {t("auth.setup.secretHint")}
              </p>
            </div>
            {error ? (
              <div role="alert" className="space-y-1 text-xs text-destructive">
                <p>{error}</p>
                {conflict ? (
                  <p className="text-muted-foreground">
                    <Trans
                      i18nKey="auth.setup.conflictResolved"
                      values={{
                        resolved: conflict.resolved || "—",
                        others: conflict.prefixes.length
                          ? t("auth.setup.conflictOthers", {
                              prefixes: conflict.prefixes.join(
                                t("auth.setup.prefixSeparator")
                              )
                            })
                          : ""
                      }}
                      components={{ code: <code className="font-mono" /> }}
                    />
                  </p>
                ) : null}
              </div>
            ) : null}
            <Button type="submit" size="sm" className="w-full" disabled={busy}>
              <KeyRound aria-hidden="true" />
              {busy ? t("auth.setup.running") : t("auth.setup.submit")}
            </Button>
            <p className="text-[11px] text-muted-foreground">
              {t("auth.setup.idempotentHint")}
            </p>
          </form>
        )}
      </div>
    </AuthShell>
  )
}
