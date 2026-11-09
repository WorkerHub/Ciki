import { useEffect, useState } from "react"
import {
  ApiError,
  adminApi,
  describeApiError,
  type SiteSettings
} from "@/lib/api"
import { SettingRow, SettingTextRow } from "@/pages/admin/SettingRow"
import { useSiteStore } from "@/stores/site"

/**
 * 应用设置：站点名、初始化页开关。
 * 注册与审批开关在「访问与安全」里，SMTP 与测试发信在「邮件配置」里。
 */
export function SettingsTab() {
  const siteName = useSiteStore((state) => state.name)
  const setName = useSiteStore((state) => state.setName)
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
      setError("站点名称需为 1–32 个字符。")
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
        setError("站点名称没有保存成功，请刷新后重试。")
        return
      }
      setSettings(saved)
      // 品牌区、页签标题、登录页都读同一份 store，保存成功即全站更新
      setName(next)
      setNotice("站点名称已保存，全站即时生效。")
    } catch (saveError) {
      setSettings(previous)
      setError(
        saveError instanceof ApiError && saveError.status === 400
          ? "站点名称需为 1–32 个字符。"
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
          label="站点名称"
          description="显示在浏览器页签、左上品牌区与登录页；保存后全站即时生效，不需要重新部署。"
          value={settings.siteName || siteName}
          maxLength={32}
          disabled={saving}
          onSave={(next) => void saveSiteName(next)}
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
        {settings.emailConfigured
          ? "邮件服务已配置：邮箱验证码两步验证与找回密码可用，修改在「邮件配置」。"
          : "邮件服务未配置：邮箱验证码两步验证与找回密码不可用，请到「邮件配置」填写 SMTP。"}
      </p>
    </div>
  )
}
