import { DatabaseZap } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  adminApi,
  describeApiError,
  type R2CleanupSummary,
  type SetupResult
} from "@/lib/api"
import { formatDateTime } from "@/lib/format"

/** 数据库维护：检查并升级；有清理记录时附一行最近一轮摘要。 */
export function DatabaseTab() {
  const [result, setResult] = useState<SetupResult | null>(null)
  const [lastRun, setLastRun] = useState<R2CleanupSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  // 摘要只做展示：升级前 schema 还没到 v5 时接口会失败，静默留空即可。
  const loadCleanup = useCallback(async () => {
    try {
      const { lastRun: latest } = await adminApi.r2Cleanup()
      setLastRun(latest)
    } catch {
      // 页面唯一的错误提示留给升级操作，摘要读取失败不打扰用户
    }
  }, [])

  useEffect(() => {
    void loadCleanup()
  }, [loadCleanup])

  const run = async () => {
    setBusy(true)
    setError("")
    try {
      setResult(await adminApi.runAsAdmin())
      // 刚应用 schema_v5 的部署上，摘要接口此前不可用，升级成功后补拉一次
      void loadCleanup()
    } catch (runError) {
      setError(describeApiError(runError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border p-4">
        <h3 className="text-sm font-medium">数据库升级</h3>
        <Button
          type="button"
          size="sm"
          className="mt-3"
          onClick={() => void run()}
          disabled={busy}
        >
          <DatabaseZap aria-hidden="true" />
          {busy ? "检查中…" : "检查并升级数据库"}
        </Button>

        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        {result ? (
          <div className="mt-3 space-y-2 rounded-lg bg-muted/50 p-3">
            <p className="text-xs text-muted-foreground">当前表前缀</p>
            <p className="font-mono text-sm">
              {result.tablePrefix || "（无前缀）"}
            </p>
            <Separator />
            <ul className="space-y-1 text-xs">
              {result.migrations.map((migration) => (
                <li
                  key={migration.name}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="font-mono">{migration.name}</span>
                  <span
                    className={
                      migration.status === "applied"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground"
                    }
                  >
                    {migration.status === "applied" ? "已应用" : "已是最新"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {lastRun ? (
        <p className="text-xs text-muted-foreground">
          最近清理 {formatDateTime(lastRun.startedAt)} · 扫描 {lastRun.scanned}{" "}
          · 引用 {lastRun.referenced} · 删除 {lastRun.deleted} · 未满 30 天跳过{" "}
          {lastRun.youngSkipped} · 失败 {lastRun.failed}
        </p>
      ) : null}
    </div>
  )
}
