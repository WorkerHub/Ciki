import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { adminApi, describeApiError, type SiteSettings } from "@/lib/api"

const DEFAULT_MAX_MB = 10

/**
 * 图片上传上限 (MB) 配置项。
 * 照 RevisionRetentionCard 现行模式：Input + onBlur/Enter 保存 + 回读 settings() 校验落库。
 * 1–100 整数合法；空串 = 重置默认（null，后端回落 10）。
 * UI 极简：只留标签、输入、保存，不加说明段落。
 */
export function MaxImageUploadCard({
  limit,
  disabled,
  onSaved
}: {
  limit?: number | null
  disabled?: boolean
  /** 保存成功后把服务端返回值交回页面，保证展示与落库一致。 */
  onSaved: (settings: SiteSettings) => void
}) {
  const currentLimit = limit ?? DEFAULT_MAX_MB
  const [draft, setDraft] = useState(String(currentLimit))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const { t } = useTranslation()

  const locked = Boolean(disabled) || saving

  useEffect(() => {
    setDraft(String(limit ?? DEFAULT_MAX_MB))
  }, [limit])

  const save = async (value: number | null) => {
    setSaving(true)
    setError("")
    setNotice("")
    try {
      await adminApi.saveSettings({ maxImageUploadMb: value })
      // 回读一次确认真的落库：旧后端会忽略未知字段并回 200
      const saved = await adminApi.settings()
      const raw: unknown = saved.maxImageUploadMb
      const savedLimit = typeof raw === "number" ? raw : null
      const expectedLimit = value === null ? DEFAULT_MAX_MB : value
      if (
        raw === undefined ||
        (savedLimit !== expectedLimit && savedLimit !== value)
      ) {
        setError(t("admin.uploadLimit.notSaved"))
        return
      }
      onSaved(saved)
      setDraft(String(expectedLimit))
      setNotice(
        value === null
          ? t("admin.uploadLimit.savedDefault")
          : t("admin.uploadLimit.saved", { count: value })
      )
    } catch (saveError: unknown) {
      setError(describeApiError(saveError))
    } finally {
      setSaving(false)
    }
  }

  const commit = () => {
    if (locked) return
    const current = String(limit ?? DEFAULT_MAX_MB)
    const next = draft.trim()
    if (next === current) {
      setDraft(current)
      return
    }
    setError("")
    setNotice("")
    if (next === "") {
      void save(null)
      return
    }
    if (!/^\d+$/.test(next) || Number(next) < 1 || Number(next) > 100) {
      setDraft(current)
      setError(t("admin.uploadLimit.invalid"))
      return
    }
    void save(Number(next))
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
        <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <p className="text-sm font-medium">{t("admin.uploadLimit.label")}</p>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Input
              type="number"
              min={1}
              max={100}
              step={1}
              inputMode="numeric"
              placeholder={t("admin.uploadLimit.placeholder")}
              aria-label={t("admin.uploadLimit.label")}
              className="h-8 w-full sm:w-56"
              value={draft}
              disabled={locked}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  commit()
                }
                if (event.key === "Escape") {
                  event.preventDefault()
                  setDraft(String(limit ?? DEFAULT_MAX_MB))
                }
              }}
            />
            <Button
              type="button"
              size="sm"
              className="h-8 shrink-0"
              disabled={
                locked || draft.trim() === String(limit ?? DEFAULT_MAX_MB)
              }
              onClick={commit}
            >
              {t("common.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
