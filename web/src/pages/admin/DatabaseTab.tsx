import type { TFunction } from "i18next"
import { DatabaseZap } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  type AdminStorage,
  adminApi,
  describeApiError,
  type R2CleanupSummary,
  type SetupResult
} from "@/lib/api"
import { formatBytes, formatDateTime } from "@/lib/format"
import { OrphanCleanupCard } from "@/pages/admin/OrphanCleanupCard"

/** 清理锁是分钟级的，运行态用短轮询跟着走：锁一释放按钮就能用。 */
const RUNNING_POLL_MS = 10_000

/**
 * 体积行：数据库体积恒显示（取不到写「不可得」）；两个 R2 桶按桶各一项，
 * 统计失败（null / 未下发）时整项不渲染——与 D1 的「不可得」同一降级思路，
 * 不拿 0 或估算数顶替。
 */
function storageLine(storage: AdminStorage, t: TFunction): string {
  const parts = [
    storage.databaseSizeBytes === null
      ? t("admin.database.storage.databaseUnavailable")
      : t("admin.database.storage.database", {
          size: formatBytes(storage.databaseSizeBytes)
        })
  ]
  if (typeof storage.assetsSizeBytes === "number") {
    parts.push(
      t("admin.database.storage.assets", {
        size: formatBytes(storage.assetsSizeBytes)
      })
    )
  }
  if (typeof storage.contentSizeBytes === "number") {
    parts.push(
      t("admin.database.storage.content", {
        size: formatBytes(storage.contentSizeBytes)
      })
    )
  }
  parts.push(t("admin.database.storage.pages", { pages: storage.pageCount }))
  return parts.join(" · ")
}

/**
 * 数据库维护：检查并升级、孤儿图片两步清理；有数据时附两行状态——
 * 一行库体积（D1 + 两个 R2 桶）与页数（服务端按 Cloudflare D1 REST API 与
 * R2 `list()` 口径给，D1 是 Ciki 独占库，不写 scope 字样），
 * 一行最近一轮清理摘要。清理入口只调既有手动触发接口，可清理数与删除量全部由服务端给。
 */
export function DatabaseTab() {
  const [result, setResult] = useState<SetupResult | null>(null)
  const [storage, setStorage] = useState<AdminStorage | null>(null)
  const [lastRun, setLastRun] = useState<R2CleanupSummary | null>(null)
  const [runningSeconds, setRunningSeconds] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const { t } = useTranslation()

  // 摘要只做展示：升级前 schema 还没到 v5 时接口会失败，静默留空即可。
  // 运行态与摘要同源，一次 GET 拿两样，页面加载时就能判定「是否在跑」。
  const loadCleanup = useCallback(async () => {
    try {
      const { lastRun: latest, running } = await adminApi.r2Cleanup()
      setLastRun(latest)
      // retryAfter 缺省（契约漂移）时按 1 秒处理，下一轮轮询就会纠正
      setRunningSeconds(
        running
          ? Math.max(
              1,
              typeof running.retryAfter === "number" ? running.retryAfter : 0
            )
          : null
      )
    } catch {
      // 页面唯一的错误提示留给升级操作，摘要读取失败不打扰用户
    }
  }, [])

  // 体积行只做展示：旧库还没有这个接口时整行不渲染，不占错误提示位。
  const loadStorage = useCallback(async () => {
    try {
      setStorage(await adminApi.storage())
    } catch {
      setStorage(null)
    }
  }, [])

  useEffect(() => {
    void loadCleanup()
    void loadStorage()
  }, [loadCleanup, loadStorage])

  // 已有一轮在跑：重读运行态直到锁释放，不要求用户刷新页面
  useEffect(() => {
    if (runningSeconds === null) return
    const timer = setInterval(() => void loadCleanup(), RUNNING_POLL_MS)
    return () => clearInterval(timer)
  }, [runningSeconds, loadCleanup])

  const run = async () => {
    setBusy(true)
    setError("")
    try {
      setResult(await adminApi.runAsAdmin())
      // 升级前清理日志表还不存在，摘要接口会失败；升级成功后两行一起补拉
      void loadCleanup()
      void loadStorage()
    } catch (runError) {
      setError(describeApiError(runError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border p-4">
        <h3 className="text-sm font-medium">{t("admin.database.title")}</h3>
        <Button
          type="button"
          size="sm"
          className="mt-3"
          onClick={() => void run()}
          disabled={busy}
        >
          <DatabaseZap aria-hidden="true" />
          {busy ? t("admin.database.checking") : t("admin.database.check")}
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
            <p className="text-xs text-muted-foreground">
              {t("admin.database.prefix")}
            </p>
            <p className="font-mono text-sm">
              {result.tablePrefix || t("admin.database.noPrefix")}
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
                    {migration.status === "applied"
                      ? t("admin.database.applied")
                      : t("admin.database.current")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <OrphanCleanupCard
        runningSeconds={runningSeconds}
        onBlocked={(seconds) => setRunningSeconds(Math.max(1, seconds))}
        onRefresh={() => void loadCleanup()}
      />

      {storage ? (
        <p className="text-xs text-muted-foreground">
          {storageLine(storage, t)}
        </p>
      ) : null}

      {lastRun ? (
        <p className="text-xs text-muted-foreground">
          {t("admin.database.lastRun", {
            time: formatDateTime(lastRun.startedAt),
            scanned: lastRun.scanned,
            referenced: lastRun.referenced,
            deleted: lastRun.deleted,
            youngSkipped: lastRun.youngSkipped,
            failed: lastRun.failed
          })}
        </p>
      ) : null}
    </div>
  )
}
