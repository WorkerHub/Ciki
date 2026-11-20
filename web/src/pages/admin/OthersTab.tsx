import type { TFunction } from "i18next"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { type AdminStorage, adminApi, type R2CleanupSummary } from "@/lib/api"
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
      ? t("admin.others.storage.databaseUnavailable")
      : t("admin.others.storage.database", {
          size: formatBytes(storage.databaseSizeBytes)
        })
  ]
  if (typeof storage.assetsSizeBytes === "number") {
    parts.push(
      t("admin.others.storage.assets", {
        size: formatBytes(storage.assetsSizeBytes)
      })
    )
  }
  if (typeof storage.contentSizeBytes === "number") {
    parts.push(
      t("admin.others.storage.content", {
        size: formatBytes(storage.contentSizeBytes)
      })
    )
  }
  parts.push(t("admin.others.storage.pages", { pages: storage.pageCount }))
  return parts.join(" · ")
}

/**
 * 其他：孤儿图片两步清理；有数据时附两行状态——
 * 一行库体积（D1 + 两个 R2 桶）与页数（服务端按 Cloudflare D1 REST API 与
 * R2 `list()` 口径给，D1 是 Ciki 独占库，不写 scope 字样），
 * 一行最近一轮清理摘要。清理入口只调既有手动触发接口，可清理数与删除量全部由服务端给。
 * 数据库迁移已移至部署流水线自动执行，此处不再提供手动升级入口。
 */
export function OthersTab() {
  const [storage, setStorage] = useState<AdminStorage | null>(null)
  const [lastRun, setLastRun] = useState<R2CleanupSummary | null>(null)
  const [runningSeconds, setRunningSeconds] = useState<number | null>(null)
  const { t } = useTranslation()

  // 摘要只做展示：接口失败时静默留空即可。
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
      // 摘要读取失败不打扰用户
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

  return (
    <div className="space-y-4">
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
          {t("admin.others.lastRun", {
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
