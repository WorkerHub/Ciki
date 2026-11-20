import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Switch } from "@/components/ui/switch"
import { adminApi, describeApiError, type SiteSettings } from "@/lib/api"

/**
 * 系统管理 · 其他（规格 §5.3.5、§6.1）。
 *
 * 「开放初始化页面」只门控页面，不门控密钥接口。
 */
export function OthersSection(props?: {
  settings?: SiteSettings
  onSaved?: (settings: SiteSettings) => void
}) {
  const { t } = useTranslation()
  const [internalSettings, setInternalSettings] = useState<SiteSettings | null>(
    props?.settings ?? null
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (props?.settings !== undefined) {
      setInternalSettings(props.settings)
      return
    }
    let alive = true
    adminApi
      .settings()
      .then((data) => {
        if (alive) setInternalSettings(data)
      })
      .catch((loadError: unknown) => {
        if (alive) setError(describeApiError(loadError))
      })
    return () => {
      alive = false
    }
  }, [props?.settings])

  const settings = internalSettings

  const toggleSetupPage = async (enabled: boolean) => {
    if (!settings || saving) return
    setSaving(true)
    setError("")
    const previous = settings
    const optimistic: SiteSettings = { ...settings, setupPageEnabled: enabled }
    setInternalSettings(optimistic)
    try {
      await adminApi.saveSettings({
        setupPageEnabled: enabled
      })
      props?.onSaved?.(optimistic)
    } catch (saveError: unknown) {
      setInternalSettings(previous)
      setError(describeApiError(saveError))
    } finally {
      setSaving(false)
    }
  }

  if (!settings) {
    if (error) {
      return (
        <section className="space-y-4 rounded-xl border border-border bg-card p-4">
          <h3 className="font-heading text-sm font-semibold">
            {t("admin.others.title")}
          </h3>
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        </section>
      )
    }
    return null
  }

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4">
      <h3 className="font-heading text-sm font-semibold">
        {t("admin.others.title")}
      </h3>

      <label className="flex items-center justify-between gap-4 text-sm">
        <span className="space-y-0.5">
          <span className="block">{t("admin.others.setupPage")}</span>
          <span className="block text-xs text-muted-foreground">
            {t("admin.others.setupPageHint")}
          </span>
        </span>
        <Switch
          checked={settings.setupPageEnabled}
          disabled={saving}
          onCheckedChange={(checked) => void toggleSetupPage(checked)}
          aria-label={t("admin.others.setupPage")}
        />
      </label>

      <dl className="grid gap-2 text-sm sm:grid-cols-[8rem_1fr]">
        <dt className="text-muted-foreground">
          {t("admin.others.tablePrefix")}
        </dt>
        <dd className="font-mono text-xs">
          {settings.tablePrefix || t("admin.others.noPrefix")}
        </dd>
      </dl>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}
