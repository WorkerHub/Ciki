import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ApiError,
  adminApi,
  describeApiError,
  type SiteSettings
} from "@/lib/api"
import { SettingRow, SettingTextRow } from "@/pages/admin/SettingRow"
import { RevisionRetentionCard } from "@/pages/admin/RevisionRetentionCard"
import { useSiteStore } from "@/stores/site"

/**
 * 应用设置：站点名、初始化页开关。
 * 注册与审批开关在「访问与安全」里，SMTP 与测试发信在「邮件配置」里。
 */
export function SettingsTab() {
  const siteName = useSiteStore((state) => state.name)
  const setName = useSiteStore((state) => state.setName)
  const { t } = useTranslation()
  const [settings, setSettings] = useState<SiteSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

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
    setNotice("")
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

  const saveSiteName = async (next: string) => {
    if (!settings) return
    if (next.length > 32) {
      setError(t("admin.settings.siteName.tooLong"))
      return
    }
    setSaving(true)
    setError("")
    setNotice("")
    const previous = settings
    setSettings({ ...settings, siteName: next })
    try {
      await adminApi.saveSettings({ siteName: next })
      // 回读一次，确认后端真的落库：旧后端会忽略未知字段并回 200，
      // 不验证的话界面会假装保存成功。以服务端返回值为准。
      const saved = await adminApi.settings()
      if ((saved.siteName ?? "").trim() !== next) {
        setSettings(previous)
        setError(t("admin.settings.siteName.notSaved"))
        return
      }
      setSettings(saved)
      // 品牌区、页签标题、登录页都读同一份 store，保存成功即全站更新
      setName(next)
      setNotice(t("admin.settings.siteName.saved"))
    } catch (saveError) {
      setSettings(previous)
      setError(
        saveError instanceof ApiError && saveError.status === 400
          ? t("admin.settings.siteName.tooLong")
          : describeApiError(saveError)
      )
    } finally {
      setSaving(false)
    }
  }

  if (!settings) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="h-16 animate-pulse rounded-lg bg-muted/60"
          />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {error ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
        >
          {notice}
        </p>
      ) : null}
      <div className="rounded-xl border border-border px-4">
        <SettingTextRow
          label={t("admin.settings.siteName.label")}
          description={t("admin.settings.siteName.description")}
          value={settings.siteName || siteName}
          maxLength={32}
          disabled={saving}
          onSave={(next) => void saveSiteName(next)}
        />
        <SettingRow
          label={t("admin.settings.setupPage.label")}
          description={t("admin.settings.setupPage.description")}
          checked={settings.setupPageEnabled}
          disabled={saving}
          onChange={(checked) => void update({ setupPageEnabled: checked })}
        />
      </div>
      <RevisionRetentionCard
        limit={settings.revisionRetentionLimit ?? null}
        disabled={saving}
        onSaved={setSettings}
      />
      <p className="text-[11px] text-muted-foreground">
        {settings.emailConfigured
          ? t("admin.settings.mailConfigured")
          : t("admin.settings.mailMissing")}
      </p>
    </div>
  )
}
