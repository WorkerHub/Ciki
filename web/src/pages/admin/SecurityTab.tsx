import { ShieldCheck } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { adminApi, describeApiError, type SiteSettings } from "@/lib/api"
import { SettingRow } from "@/pages/admin/SettingRow"

/** 访问与安全：强制两步验证、注册与审批开关 + 站点权限模型说明。 */
export function SecurityTab() {
  const [settings, setSettings] = useState<SiteSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const { t } = useTranslation()

  useEffect(() => {
    let alive = true
    adminApi
      .settings()
      .then((value) => {
        if (alive) setSettings(value)
      })
      .catch((loadError: unknown) => {
        if (alive) setError(describeApiError(loadError))
      })
    return () => {
      alive = false
    }
  }, [])

  const update = async (patch: Partial<SiteSettings>) => {
    if (!settings) return
    setSaving(true)
    setError("")
    const previous = settings
    setSettings({ ...settings, ...patch })
    try {
      await adminApi.saveSettings(patch)
    } catch (saveError) {
      setSettings(previous)
      setError(describeApiError(saveError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <div className="rounded-xl border border-border px-4">
        {settings ? (
          <>
            <SettingRow
              label={t("admin.security.require2fa.label")}
              description={t("admin.security.require2fa.description")}
              checked={settings.require2fa}
              disabled={saving}
              onChange={(checked) => void update({ require2fa: checked })}
            />
            <SettingRow
              label={t("admin.security.registration.label")}
              description={t("admin.security.registration.description")}
              checked={settings.registrationEnabled}
              disabled={saving}
              onChange={(checked) =>
                void update({ registrationEnabled: checked })
              }
            />
            <SettingRow
              label={t("admin.security.approval.label")}
              description={t("admin.security.approval.description")}
              checked={settings.registrationApprovalRequired}
              disabled={saving || !settings.registrationEnabled}
              onChange={(checked) =>
                void update({ registrationApprovalRequired: checked })
              }
            />
          </>
        ) : (
          <div className="h-16 animate-pulse bg-muted/60" />
        )}
      </div>

      <section className="rounded-xl border border-border p-4">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          {t("admin.security.model.title")}
        </h3>
        <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
          <li>{t("admin.security.model.roles")}</li>
          <li>{t("admin.security.model.wiki")}</li>
          <li>{t("admin.security.model.delete")}</li>
          <li>{t("admin.security.model.admin")}</li>
        </ul>
      </section>
    </div>
  )
}
