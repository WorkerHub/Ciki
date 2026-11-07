import { ShieldCheck } from "lucide-react"
import { useEffect, useState } from "react"
import { adminApi, describeApiError, type SiteSettings } from "@/lib/api"
import { SettingRow } from "@/pages/admin/SettingRow"

/** 访问与安全：强制两步验证 + 站点权限模型说明。 */
export function SecurityTab() {
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

  const toggle = async (checked: boolean) => {
    if (!settings) return
    setSaving(true)
    setError("")
    setSettings({ ...settings, require2fa: checked })
    try {
      await adminApi.saveSettings({ require2fa: checked })
    } catch (saveError) {
      setSettings(settings)
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
          <SettingRow
            label="强制两步验证"
            description="开启后，未配置 TOTP 或 Passkey 的账号登录后会先被引导到「设置 → 两步验证」，配置完成前只能访问安全设置。"
            checked={settings.require2fa}
            disabled={saving}
            onChange={(checked) => void toggle(checked)}
          />
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
          权限模型
        </h3>
        <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
          <li>
            两级角色：管理员（admin）与普通用户（user），系统管理仅管理员可见、可调用。
          </li>
          <li>wiki 语义：登录用户可以阅读与编辑任何页面。</li>
          <li>
            删除页面、回滚版本限页面作者本人与管理员；彻底删除只对回收站里的页面生效。
          </li>
          <li>注册审批、账号停用与密码重置都在「用户管理」里操作。</li>
        </ul>
      </section>
    </div>
  )
}
