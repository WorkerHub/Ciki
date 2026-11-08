import { DatabaseZap } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { adminApi, describeApiError, type SetupResult } from "@/lib/api"

/** 数据库维护：只做「检查并升级」，不提供任何删表/清库入口。 */
export function DatabaseTab() {
  const [result, setResult] = useState<SetupResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const run = async () => {
    setBusy(true)
    setError("")
    try {
      setResult(await adminApi.runAsAdmin())
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
    </div>
  )
}
