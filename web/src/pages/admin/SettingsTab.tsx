import { useEffect, useState } from "react"
import { adminApi, describeApiError, type SiteSettings } from "@/lib/api"
import { SettingRow } from "@/pages/admin/SettingRow"

/** 应用设置：注册、审批、初始化页开关（无邮件业务，故没有 SMTP 分区）。 */
export function SettingsTab() {
  const [settings, setSettings] = useState<SiteSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

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
      <div className="rounded-xl border border-border px-4">
        <SettingRow
          label="开放注册"
          description="关闭后新账号只能由管理员在「用户管理」里创建。"
          checked={settings.registrationEnabled}
          disabled={saving}
          onChange={(checked) => void update({ registrationEnabled: checked })}
        />
        <SettingRow
          label="注册需要管理员批准"
          description="开启时，自助注册的账号先进入待批准状态，批准后才能登录。"
          checked={settings.registrationApprovalRequired}
          disabled={saving || !settings.registrationEnabled}
          onChange={(checked) =>
            void update({ registrationApprovalRequired: checked })
          }
        />
        <SettingRow
          label="显示初始化页面"
          description="初始化完成后通常应关闭，避免把 setup 入口暴露在登录页。"
          checked={settings.setupPageEnabled}
          disabled={saving}
          onChange={(checked) => void update({ setupPageEnabled: checked })}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        站点没有邮件相关功能，因此不提供 SMTP
        配置；账号的创建与重置都由管理员操作。
      </p>
    </div>
  )
}
